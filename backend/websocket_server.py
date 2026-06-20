import json
import asyncio
import threading
import time
import websockets
from typing import Dict, Optional
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.ipc as ipc

from arrow_store import ArrowStore
from filter import TimeWindowFilter


class WebSocketBridge:
    def __init__(self, arrow_store: ArrowStore, host: str = "localhost", port: int = 8815):
        self._store = arrow_store
        self._host = host
        self._port = port
        self._clients: Dict[str, dict] = {}
        self._client_lock = threading.RLock()
        self._running = False
        self._push_thread: Optional[threading.Thread] = None
        self._server_thread: Optional[threading.Thread] = None
        self._last_push = 0.0
        self._push_interval = 1.0
        self._server = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    async def _handle_client(self, websocket):
        client_id = f"ws_{int(time.time() * 1000)}_{id(websocket)}"
        client_config = {
            'id': client_id,
            'time_window': None,
            'websocket': websocket,
            'last_update': 0
        }

        with self._client_lock:
            self._clients[client_id] = client_config

        print(f"[WSBridge] Client connected: {client_id}")

        try:
            await self._send_message(websocket, {
                'type': 'register_response',
                'client_id': client_id
            })

            await self._push_initial_data(websocket, client_config)

            async for message in websocket:
                try:
                    if isinstance(message, str):
                        await self._handle_text_message(message, client_config)
                except Exception as e:
                    print(f"[WSBridge] Message error: {e}")

        except websockets.exceptions.ConnectionClosed:
            print(f"[WSBridge] Client disconnected: {client_id}")
        finally:
            with self._client_lock:
                if client_id in self._clients:
                    del self._clients[client_id]

    async def _handle_text_message(self, message: str, client_config: dict):
        try:
            data = json.loads(message)
            action = data.get('action')

            if action == 'register_listener':
                client_config['id'] = data.get('client_id', client_config['id'])
                await self._send_message(client_config['websocket'], {
                    'type': 'register_response',
                    'client_id': client_config['id'],
                    'total_flows': self._store.count()
                })

            elif action == 'set_time_window':
                start_time = data.get('start_time')
                end_time = data.get('end_time')
                client_config['time_window'] = (start_time, end_time)

                table = self._store.get_table()
                filtered = TimeWindowFilter.filter_by_time(table, start_time, end_time)

                response = {
                    'status': 'ok',
                    'flows_in_window': filtered.num_rows,
                    'total_bytes': int(pc.sum(filtered['byte_count']).as_py()) if filtered.num_rows > 0 else 0,
                    'total_packets': int(pc.sum(filtered['packet_count']).as_py()) if filtered.num_rows > 0 else 0
                }
                await self._send_message(client_config['websocket'], {
                    'type': 'time_window_response',
                    'data': response
                })

                await self._push_filtered_data(client_config)

            elif action == 'get_stats':
                table = self._store.get_table()
                stats = self._get_stats(table)
                await self._send_message(client_config['websocket'], {
                    'type': 'stats',
                    'data': stats
                })

            elif action == 'get_time_range':
                table = self._store.get_table()
                start, end = TimeWindowFilter.get_time_range(table)
                await self._send_message(client_config['websocket'], {
                    'type': 'time_range',
                    'data': {
                        'min_time': start,
                        'max_time': end,
                        'total_flows': table.num_rows
                    }
                })

        except Exception as e:
            print(f"[WSBridge] Handle action error: {e}")
            await self._send_message(client_config['websocket'], {
                'type': 'error',
                'message': str(e)
            })

    def _get_stats(self, table: pa.Table) -> dict:
        if table.num_rows == 0:
            return {
                'total_flows': 0,
                'total_bytes': 0,
                'total_packets': 0,
                'unique_ips': 0,
                'protocol_distribution': {}
            }

        src_ips = table['src_ip'].to_pylist()
        dst_ips = table['dst_ip'].to_pylist()
        unique_ips = len(set(src_ips + dst_ips))

        proto_dist = (
            table.group_by('protocol')
            .aggregate([('byte_count', 'sum')])
            .to_pydict()
        )

        return {
            'total_flows': table.num_rows,
            'total_bytes': int(pc.sum(table['byte_count']).as_py()),
            'total_packets': int(pc.sum(table['packet_count']).as_py()),
            'unique_ips': unique_ips,
            'protocol_distribution': proto_dist
        }

    async def _send_message(self, websocket, message: dict):
        try:
            await websocket.send(json.dumps(message))
        except Exception as e:
            print(f"[WSBridge] Send message error: {e}")

    async def _send_record_batch(self, websocket, table: pa.Table):
        try:
            sink = pa.BufferOutputStream()
            with ipc.new_stream(sink, table.schema) as writer:
                for batch in table.to_batches(max_chunksize=1000):
                    writer.write_batch(batch)

            buffer = sink.getvalue()
            await websocket.send(buffer.to_pybytes())
        except Exception as e:
            print(f"[WSBridge] Send record batch error: {e}")

    async def _push_initial_data(self, websocket, client_config: dict):
        table = self._store.get_table()
        if client_config['time_window']:
            table = TimeWindowFilter.filter_by_time(
                table,
                client_config['time_window'][0],
                client_config['time_window'][1]
            )
        if table.num_rows > 0:
            await self._send_record_batch(websocket, table)

    async def _push_filtered_data(self, client_config: dict):
        table = self._store.get_table()
        if client_config['time_window']:
            table = TimeWindowFilter.filter_by_time(
                table,
                client_config['time_window'][0],
                client_config['time_window'][1]
            )
        if table.num_rows > 0:
            await self._send_record_batch(client_config['websocket'], table)

    def _run_async(self, coro):
        if self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(coro, self._loop)

    def _push_loop(self):
        while self._running:
            try:
                if self._store.last_updated <= self._last_push:
                    time.sleep(0.1)
                    continue

                self._last_push = self._store.last_updated

                table = self._store.get_table()
                if table.num_rows == 0:
                    time.sleep(self._push_interval)
                    continue

                with self._client_lock:
                    clients = list(self._clients.values())

                for client in clients:
                    try:
                        filtered = table
                        if client['time_window']:
                            filtered = TimeWindowFilter.filter_by_time(
                                table,
                                client['time_window'][0],
                                client['time_window'][1]
                            )
                        if filtered.num_rows > 0:
                            self._run_async(self._send_record_batch(client['websocket'], filtered))
                    except Exception as e:
                        print(f"[WSBridge] Push to client error: {e}")

                time.sleep(self._push_interval)

            except Exception as e:
                print(f"[WSBridge] Push loop error: {e}")
                time.sleep(1.0)

    def start(self):
        if self._running:
            return

        self._running = True

        def run_server():
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)

            async def server_coro():
                self._server = await websockets.serve(
                    self._handle_client,
                    self._host,
                    self._port
                )
                print(f"[WSBridge] WebSocket server started on ws://{self._host}:{self._port}")
                await self._server.wait_closed()

            self._loop.run_until_complete(server_coro())

        self._server_thread = threading.Thread(target=run_server, daemon=True)
        self._server_thread.start()

        time.sleep(0.5)

        self._push_thread = threading.Thread(target=self._push_loop, daemon=True)
        self._push_thread.start()

        print(f"[WSBridge] Push loop started")

    def stop(self):
        self._running = False
        if self._server:
            self._server.close()
        if self._push_thread and self._push_thread.is_alive():
            self._push_thread.join(timeout=2.0)
        if self._server_thread and self._server_thread.is_alive():
            self._server_thread.join(timeout=2.0)
        print(f"[WSBridge] Stopped")
