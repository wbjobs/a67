import random
import time
from dataclasses import dataclass
from typing import List, Optional


@dataclass
class PacketInfo:
    src_ip: str
    dst_ip: str
    src_port: int
    dst_port: int
    protocol: str
    packet_size: int
    timestamp: float


INTERNAL_IPS = [
    "192.168.1.10", "192.168.1.20", "192.168.1.30",
    "192.168.1.40", "192.168.1.50", "192.168.1.1",
    "10.0.0.1", "10.0.0.5", "172.16.0.1"
]

EXTERNAL_IPS = [
    "8.8.8.8", "1.1.1.1", "208.67.222.222",
    "142.250.190.46", "151.101.1.69", "104.16.132.229",
    "52.84.13.103", "13.107.42.14", "157.240.23.35"
]

PROTOCOLS = ["TCP", "UDP", "ICMP"]

COMMON_PORTS = {
    "TCP": [80, 443, 22, 21, 3389, 8080, 8443, 25, 110, 143],
    "UDP": [53, 67, 68, 123, 161, 162, 500, 4500, 5060],
    "ICMP": [0]
}

PACKET_SIZE_DISTRIBUTION = [
    (64, 0.3),
    (128, 0.25),
    (256, 0.15),
    (512, 0.15),
    (1024, 0.1),
    (1400, 0.05)
]


class MockDataGenerator:
    def __init__(self, start_time: Optional[float] = None):
        self.current_time = start_time or time.time()
        self.active_flows = {}

    def _generate_packet_size(self) -> int:
        r = random.random()
        cumulative = 0
        for size, prob in PACKET_SIZE_DISTRIBUTION:
            cumulative += prob
            if r <= cumulative:
                return size + random.randint(-10, 10)
        return 128

    def _generate_flow_key(self):
        protocol = random.choices(PROTOCOLS, weights=[0.6, 0.3, 0.1])[0]
        use_internal = random.random() < 0.7

        if use_internal:
            src_ip = random.choice(INTERNAL_IPS)
            dst_ip = random.choice(INTERNAL_IPS)
            while dst_ip == src_ip:
                dst_ip = random.choice(INTERNAL_IPS)
        else:
            if random.random() < 0.5:
                src_ip = random.choice(INTERNAL_IPS)
                dst_ip = random.choice(EXTERNAL_IPS)
            else:
                src_ip = random.choice(EXTERNAL_IPS)
                dst_ip = random.choice(INTERNAL_IPS)

        src_port = random.randint(49152, 65535)
        dst_port = random.choice(COMMON_PORTS[protocol])

        return (src_ip, dst_ip, src_port, dst_port, protocol)

    def generate_packet(self, time_delta: float = 0.01) -> PacketInfo:
        self.current_time += time_delta + random.uniform(-0.005, 0.01)

        if random.random() < 0.7 and self.active_flows:
            flow_key = random.choice(list(self.active_flows.keys()))
            self.active_flows[flow_key] += 1
            if self.active_flows[flow_key] > random.randint(5, 50):
                del self.active_flows[flow_key]
        else:
            flow_key = self._generate_flow_key()
            self.active_flows[flow_key] = 1

        src_ip, dst_ip, src_port, dst_port, protocol = flow_key
        return PacketInfo(
            src_ip=src_ip,
            dst_ip=dst_ip,
            src_port=src_port if protocol != "ICMP" else 0,
            dst_port=dst_port if protocol != "ICMP" else 0,
            protocol=protocol,
            packet_size=self._generate_packet_size(),
            timestamp=self.current_time
        )

    def generate_burst(self, count: int, time_delta: float = 0.005) -> List[PacketInfo]:
        packets = []
        for _ in range(count):
            packets.append(self.generate_packet(time_delta))
        return packets

    def generate_historical(self, duration_seconds: int, packets_per_second: int = 100) -> List[PacketInfo]:
        end_time = time.time()
        self.current_time = end_time - duration_seconds
        total_packets = int(duration_seconds * packets_per_second)

        packets = []
        for _ in range(total_packets):
            time_delta = 1.0 / packets_per_second
            packets.append(self.generate_packet(time_delta))
        return packets
