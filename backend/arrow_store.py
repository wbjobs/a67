import threading
import time
from typing import List, Optional, Dict
import pyarrow as pa
import pyarrow.compute as pc
import pandas as pd

from flow_aggregator import FlowStats

FLOW_SCHEMA = pa.schema([
    ('flow_id', pa.string()),
    ('src_ip', pa.string()),
    ('dst_ip', pa.string()),
    ('src_port', pa.uint16()),
    ('dst_port', pa.uint16()),
    ('protocol', pa.string()),
    ('packet_count', pa.uint64()),
    ('byte_count', pa.uint64()),
    ('start_time', pa.timestamp('ns')),
    ('end_time', pa.timestamp('ns')),
    ('duration', pa.float64()),
])


class ArrowStore:
    def __init__(self):
        self._schema = FLOW_SCHEMA
        self._flows: Dict[str, FlowStats] = {}
        self._table: Optional[pa.Table] = None
        self._table_dirty = True
        self._lock = threading.RLock()
        self._last_updated = time.time()

    def _flow_to_dict(self, flow: FlowStats) -> dict:
        return {
            'flow_id': flow.flow_id,
            'src_ip': flow.src_ip,
            'dst_ip': flow.dst_ip,
            'src_port': flow.src_port,
            'dst_port': flow.dst_port,
            'protocol': flow.protocol,
            'packet_count': flow.packet_count,
            'byte_count': flow.byte_count,
            'start_time': int(flow.start_time * 1e9),
            'end_time': int(flow.end_time * 1e9),
            'duration': flow.duration,
        }

    def add_flow(self, flow: FlowStats):
        with self._lock:
            if flow.flow_id in self._flows:
                return
            self._flows[flow.flow_id] = flow
            self._table_dirty = True
            self._last_updated = time.time()

    def add_flows(self, flows: List[FlowStats]):
        with self._lock:
            for flow in flows:
                if flow.flow_id not in self._flows:
                    self._flows[flow.flow_id] = flow
            self._table_dirty = True
            self._last_updated = time.time()

    def update_flow(self, flow: FlowStats):
        with self._lock:
            self._flows[flow.flow_id] = flow
            self._table_dirty = True
            self._last_updated = time.time()

    def _rebuild_table(self):
        if not self._table_dirty:
            return

        flows_list = list(self._flows.values())
        if not flows_list:
            self._table = pa.Table.from_batches([], schema=self._schema)
            self._table_dirty = False
            return

        data = {field.name: [] for field in self._schema}
        for flow in flows_list:
            fd = self._flow_to_dict(flow)
            for k, v in fd.items():
                data[k].append(v)

        arrays = []
        for field in self._schema:
            arrays.append(pa.array(data[field.name], type=field.type))

        self._table = pa.Table.from_arrays(arrays, schema=self._schema)
        self._table_dirty = False

    def get_table(self) -> pa.Table:
        with self._lock:
            if self._table_dirty or self._table is None:
                self._rebuild_table()
            return self._table

    def get_record_batch(self) -> Optional[pa.RecordBatch]:
        with self._lock:
            table = self.get_table()
            if table.num_rows == 0:
                return None
            batches = table.to_batches(max_chunksize=10000)
            return batches[0] if batches else None

    def get_all_batches(self) -> List[pa.RecordBatch]:
        with self._lock:
            table = self.get_table()
            return table.to_batches(max_chunksize=1000)

    def get_schema(self) -> pa.Schema:
        return self._schema

    def to_pandas(self) -> pd.DataFrame:
        with self._lock:
            return self.get_table().to_pandas()

    def count(self) -> int:
        with self._lock:
            return len(self._flows)

    def clear(self):
        with self._lock:
            self._flows = {}
            self._table = None
            self._table_dirty = True
            self._last_updated = time.time()

    @property
    def last_updated(self) -> float:
        return self._last_updated
