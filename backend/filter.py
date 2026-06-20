import pyarrow as pa
import pyarrow.compute as pc
from typing import Optional, Tuple


class TimeWindowFilter:
    @staticmethod
    def filter_by_time(table: pa.Table,
                       start_time: Optional[float] = None,
                       end_time: Optional[float] = None) -> pa.Table:
        if table.num_rows == 0:
            return table

        mask = None

        if start_time is not None:
            start_ns = int(start_time * 1e9)
            condition = pc.greater_equal(table['end_time'], pa.scalar(start_ns, type=pa.timestamp('ns')))
            mask = condition

        if end_time is not None:
            end_ns = int(end_time * 1e9)
            condition = pc.less_equal(table['start_time'], pa.scalar(end_ns, type=pa.timestamp('ns')))
            mask = condition if mask is None else pc.and_(mask, condition)

        if mask is not None:
            return table.filter(mask)

        return table

    @staticmethod
    def filter_by_protocol(table: pa.Table, protocols: Optional[list] = None) -> pa.Table:
        if table.num_rows == 0 or not protocols:
            return table

        mask = pc.is_in(table['protocol'], pa.array(protocols, type=pa.string()))
        return table.filter(mask)

    @staticmethod
    def filter_by_min_bytes(table: pa.Table, min_bytes: int = 0) -> pa.Table:
        if table.num_rows == 0 or min_bytes <= 0:
            return table

        mask = pc.greater_equal(table['byte_count'], pa.scalar(min_bytes, type=pa.uint64()))
        return table.filter(mask)

    @staticmethod
    def aggregate_by_ip_pair(table: pa.Table) -> pa.Table:
        if table.num_rows == 0:
            return table

        grouped = table.group_by(['src_ip', 'dst_ip', 'protocol']).aggregate([
            ('packet_count', 'sum'),
            ('byte_count', 'sum'),
            ('duration', 'max'),
            ('flow_id', 'count_distinct'),
        ])

        return grouped

    @staticmethod
    def get_time_range(table: pa.Table) -> Tuple[Optional[float], Optional[float]]:
        if table.num_rows == 0:
            return None, None

        min_start = pc.min(table['start_time']).as_py()
        max_end = pc.max(table['end_time']).as_py()

        start_sec = min_start.timestamp() if hasattr(min_start, 'timestamp') else min_start / 1e9
        end_sec = max_end.timestamp() if hasattr(max_end, 'timestamp') else max_end / 1e9

        return start_sec, end_sec

    @staticmethod
    def apply_filters(table: pa.Table,
                      time_window: Optional[Tuple[float, float]] = None,
                      protocols: Optional[list] = None,
                      min_bytes: int = 0) -> pa.Table:
        result = table
        if time_window:
            result = TimeWindowFilter.filter_by_time(result, time_window[0], time_window[1])
        if protocols:
            result = TimeWindowFilter.filter_by_protocol(result, protocols)
        if min_bytes > 0:
            result = TimeWindowFilter.filter_by_min_bytes(result, min_bytes)
        return result
