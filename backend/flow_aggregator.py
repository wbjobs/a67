import hashlib
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, Optional, List

from mock_data import PacketInfo


@dataclass
class FlowStats:
    flow_id: str
    src_ip: str
    dst_ip: str
    src_port: int
    dst_port: int
    protocol: str
    packet_count: int = 0
    byte_count: int = 0
    start_time: float = 0.0
    end_time: float = 0.0
    last_updated: float = field(default_factory=time.time)

    @property
    def duration(self) -> float:
        return max(0.0, self.end_time - self.start_time)


def get_flow_id(src_ip: str, dst_ip: str, src_port: int, dst_port: int, protocol: str) -> str:
    key = f"{src_ip}:{src_port}-{dst_ip}:{dst_port}-{protocol}"
    rev_key = f"{dst_ip}:{dst_port}-{src_ip}:{src_port}-{protocol}"
    canonical = key if key < rev_key else rev_key
    return hashlib.md5(canonical.encode()).hexdigest()[:16]


class FlowAggregator:
    def __init__(self):
        self._flows: Dict[str, FlowStats] = {}
        self._update_count = 0
        self._new_flows: List[str] = []

    def process_packet(self, packet: PacketInfo) -> FlowStats:
        flow_id = get_flow_id(
            packet.src_ip, packet.dst_ip,
            packet.src_port, packet.dst_port,
            packet.protocol
        )

        if flow_id not in self._flows:
            flow = FlowStats(
                flow_id=flow_id,
                src_ip=packet.src_ip,
                dst_ip=packet.dst_ip,
                src_port=packet.src_port,
                dst_port=packet.dst_port,
                protocol=packet.protocol,
                packet_count=1,
                byte_count=packet.packet_size,
                start_time=packet.timestamp,
                end_time=packet.timestamp
            )
            self._flows[flow_id] = flow
            self._new_flows.append(flow_id)
        else:
            flow = self._flows[flow_id]
            flow.packet_count += 1
            flow.byte_count += packet.packet_size
            flow.end_time = packet.timestamp
            flow.last_updated = time.time()

        self._update_count += 1
        return flow

    def get_all_flows(self) -> List[FlowStats]:
        return list(self._flows.values())

    def get_flow(self, flow_id: str) -> Optional[FlowStats]:
        return self._flows.get(flow_id)

    def get_new_flows(self) -> List[FlowStats]:
        result = [self._flows[fid] for fid in self._new_flows]
        self._new_flows = []
        return result

    def get_updated_flows(self) -> List[FlowStats]:
        now = time.time()
        return [f for f in self._flows.values() if (now - f.last_updated) < 5.0]

    def clear_old_flows(self, max_age_seconds: int = 3600) -> int:
        now = time.time()
        old_count = len(self._flows)
        self._flows = {
            fid: f for fid, f in self._flows.items()
            if (now - f.last_updated) < max_age_seconds
        }
        return old_count - len(self._flows)

    def __len__(self) -> int:
        return len(self._flows)
