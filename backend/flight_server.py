import json
import time
import threading
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.flight as flight
from typing import Dict, Optional, Tuple, List, Generator
from collections import defaultdict

from arrow_store import ArrowStore
from filter import TimeWindowFilter
from anomaly_detector import AnomalyDetector

PAGE_SIZE = 1000


class FlowFlightServer(flight.FlightServerBase):
    def __init__(self, location: str, arrow_store: ArrowStore, anomaly_detector: AnomalyDetector = None):
        super().__init__(location)
        self._store = arrow_store
        self._detector = anomaly_detector or AnomalyDetector()
        self._clients: Dict[str, Dict] = {}
        self._client_lock = threading.RLock()
        self._push_thread: Optional[threading.Thread] = None
        self._running = False
        self._push_interval = 1.0
        self._last_push_time = defaultdict(float)

    def start_pushing(self):
        if self._running:
            return
        self._running = True
        self._push_thread = threading.Thread(target=self._push_loop, daemon=True)
        self._push_thread.start()

    def stop_pushing(self):
        self._running = False
        if self._push_thread and self._push_thread.is_alive():
            self._push_thread.join(timeout=2.0)

    def _push_loop(self):
        while self._running:
            try:
                self._check_and_push_updates()
            except Exception as e:
                print(f"[FlightServer] Push loop error: {e}")
            time.sleep(self._push_interval)

    def _check_and_push_updates(self):
        with self._client_lock:
            clients = list(self._clients.values())

        for client in clients:
            try:
                last_update = self._last_push_time.get(client['id'], 0)
                if self._store.last_updated <= last_update:
                    continue

                self._last_push_time[client['id']] = time.time()
            except Exception as e:
                print(f"[FlightServer] Update check error: {e}")

    def _get_filtered_data(self, client_config: dict) -> pa.Table:
        table = self._store.get_table()
        time_window = client_config.get('time_window')
        protocols = client_config.get('protocols')
        min_bytes = client_config.get('min_bytes', 0)
        return TimeWindowFilter.apply_filters(table, time_window, protocols, min_bytes)

    def _page_generator(self, table: pa.Table) -> Generator[pa.RecordBatch, None, None]:
        total_rows = table.num_rows
        if total_rows == 0:
            return

        for offset in range(0, total_rows, PAGE_SIZE):
            end = min(offset + PAGE_SIZE, total_rows)
            page_table = table.slice(offset, end - offset)
            if page_table.num_rows > 0:
                for batch in page_table.to_batches(max_chunksize=PAGE_SIZE):
                    yield batch

    def do_get(self, context, ticket: flight.Ticket):
        client_id = ticket.ticket.decode('utf-8')

        with self._client_lock:
            if client_id not in self._clients:
                self._clients[client_id] = {
                    'id': client_id,
                    'time_window': None,
                    'protocols': None,
                    'min_bytes': 0,
                    'created_at': time.time(),
                    'context': context,
                }

        client_config = self._clients[client_id]

        def data_generator():
            while self._running:
                try:
                    filtered_table = self._get_filtered_data(client_config)
                    if filtered_table.num_rows > 0:
                        for batch in self._page_generator(filtered_table):
                            yield batch

                    self._last_push_time[client_id] = self._store.last_updated

                    time.sleep(self._push_interval)
                except Exception as e:
                    print(f"[FlightServer] Generator error: {e}")
                    break

        schema = self._store.get_schema()
        reader = flight.RecordBatchStream(schema, data_generator())
        return flight.FlightDataStream(reader, schema)

    def do_put(self, context, descriptor, reader, writer):
        try:
            descriptor_path = descriptor.path[0].decode('utf-8') if descriptor.path else ''

            if descriptor_path == 'anomaly_threshold':
                table = reader.read_all()
                if table.num_rows > 0:
                    row = table.to_pylist()[0]
                    if 'sigma_threshold' in row:
                        self._detector.set_sigma_threshold(float(row['sigma_threshold']))
                    if 'window_size' in row:
                        self._detector.set_window_size(int(row['window_size']))
                    if 'min_flows_for_detection' in row:
                        self._detector.set_min_flows_for_detection(int(row['min_flows_for_detection']))

                stats = self._detector.get_stats()
                result_table = pa.table([
                    pa.array([stats['sigma_threshold']], type=pa.float64()),
                    pa.array([stats['window_size']], type=pa.int32()),
                    pa.array([stats['min_flows_for_detection']], type=pa.int32()),
                    pa.array([stats['total_suspicious_ips']], type=pa.int32()),
                ], names=['sigma_threshold', 'window_size', 'min_flows_for_detection', 'total_suspicious_ips'])

                writer.write(result_table)
                return

            raise NotImplementedError(f"Unknown descriptor: {descriptor_path}")
        except Exception as e:
            print(f"[FlightServer] do_put error: {e}")
            raise

    def list_flights(self, context, criteria):
        yield flight.FlightInfo(
            schema=self._store.get_schema(),
            flight_descriptor=flight.FlightDescriptor.for_path("flow_data"),
            endpoints=[flight.FlightEndpoint(ticket=flight.Ticket(b"client"), locations=[self.location])],
            total_records=self._store.count(),
            total_bytes=-1,
        )

    def get_flight_info(self, context, descriptor):
        return flight.FlightInfo(
            schema=self._store.get_schema(),
            flight_descriptor=descriptor,
            endpoints=[flight.FlightEndpoint(ticket=flight.Ticket(b"client"), locations=[self.location])],
            total_records=self._store.count(),
            total_bytes=-1,
        )

    def do_action(self, context, action: flight.Action):
        action_type = action.type

        if action_type == "register_listener":
            client_id = f"client_{int(time.time() * 1000)}_{id(context)}"
            with self._client_lock:
                self._clients[client_id] = {
                    'id': client_id,
                    'time_window': None,
                    'protocols': None,
                    'min_bytes': 0,
                    'created_at': time.time(),
                    'context': context,
                }

            result = {
                'client_id': client_id,
                'schema': self._store.get_schema().to_string(),
                'total_flows': self._store.count(),
                'page_size': PAGE_SIZE
            }
            yield flight.Result(json.dumps(result).encode('utf-8'))

        elif action_type == "set_time_window":
            try:
                params = json.loads(action.body.to_pybytes().decode('utf-8'))
                client_id = params.get('client_id')
                start_time = params.get('start_time')
                end_time = params.get('end_time')

                with self._client_lock:
                    if client_id in self._clients:
                        self._clients[client_id]['time_window'] = (start_time, end_time)

                table = self._store.get_table()
                filtered = TimeWindowFilter.filter_by_time(table, start_time, end_time)

                result = {
                    'status': 'ok',
                    'flows_in_window': filtered.num_rows,
                    'total_bytes': int(pc.sum(filtered['byte_count']).as_py()) if filtered.num_rows > 0 else 0,
                    'total_packets': int(pc.sum(filtered['packet_count']).as_py()) if filtered.num_rows > 0 else 0,
                    'page_size': PAGE_SIZE,
                    'total_pages': (filtered.num_rows + PAGE_SIZE - 1) // PAGE_SIZE
                }
                yield flight.Result(json.dumps(result).encode('utf-8'))

            except Exception as e:
                result = {'status': 'error', 'message': str(e)}
                yield flight.Result(json.dumps(result).encode('utf-8'))

        elif action_type == "get_time_range":
            table = self._store.get_table()
            start, end = TimeWindowFilter.get_time_range(table)
            result = {
                'min_time': start,
                'max_time': end,
                'total_flows': table.num_rows,
            }
            yield flight.Result(json.dumps(result).encode('utf-8'))

        elif action_type == "get_stats":
            table = self._store.get_table()
            result = {
                'total_flows': table.num_rows,
                'total_bytes': int(pc.sum(table['byte_count']).as_py()) if table.num_rows > 0 else 0,
                'total_packets': int(pc.sum(table['packet_count']).as_py()) if table.num_rows > 0 else 0,
                'unique_ips': len(set(
                    list(table['src_ip'].to_pylist()) + list(table['dst_ip'].to_pylist())
                )) if table.num_rows > 0 else 0,
                'protocol_distribution': (
                    table.group_by('protocol')
                    .aggregate([('byte_count', 'sum')])
                    .to_pydict()
                ) if table.num_rows > 0 else {},
            }
            yield flight.Result(json.dumps(result).encode('utf-8'))

        elif action_type == "unregister_listener":
            try:
                params = json.loads(action.body.to_pybytes().decode('utf-8'))
                client_id = params.get('client_id')
                with self._client_lock:
                    if client_id in self._clients:
                        del self._clients[client_id]
                yield flight.Result(json.dumps({'status': 'ok'}).encode('utf-8'))
            except Exception as e:
                yield flight.Result(json.dumps({'status': 'error', 'message': str(e)}).encode('utf-8'))

        else:
            raise NotImplementedError(f"Unknown action: {action_type}")

    def list_actions(self, context):
        yield flight.ActionType("register_listener", "Register a new client listener")
        yield flight.ActionType("set_time_window", "Set time window filter")
        yield flight.ActionType("get_time_range", "Get available time range")
        yield flight.ActionType("get_stats", "Get current statistics")
        yield flight.ActionType("unregister_listener", "Unregister a client listener")


def run_server(store: ArrowStore, host: str = "localhost", port: int = 8815):
    location = f"grpc+tcp://{host}:{port}"
    server = FlowFlightServer(location, store)
    server.start_pushing()
    print(f"[FlightServer] Starting on {location}")
    print(f"[FlightServer] Press Ctrl+C to stop")

    try:
        server.serve()
    except KeyboardInterrupt:
        print("\n[FlightServer] Stopping...")
        server.stop_pushing()
        print("[FlightServer] Stopped")


if __name__ == "__main__":
    from mock_data import MockDataGenerator
    from flow_aggregator import FlowAggregator
    from packet_capture import PacketCapture

    store = ArrowStore()
    aggregator = FlowAggregator()
    capture = PacketCapture()

    print("[Main] Generating historical mock data (5 minutes)...")
    historical = capture.read_mock_historical(duration_seconds=300, packets_per_second=80)
    print(f"[Main] Generated {len(historical)} historical packets")

    for packet in historical:
        flow = aggregator.process_packet(packet)

    print(f"[Main] Aggregated into {len(aggregator)} flows")
    store.add_flows(aggregator.get_all_flows())
    print(f"[Main] Stored {store.count()} flows in Arrow")

    def on_packet(packet):
        flow = aggregator.process_packet(packet)
        store.update_flow(flow)

    capture.set_callback(on_packet)
    capture.start_mock_capture(packets_per_second=30)
    print("[Main] Mock capture started")

    run_server(store)
