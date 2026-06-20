import time
import threading
from typing import Callable, Optional, List
from dataclasses import dataclass

try:
    from scapy.all import rdpcap, sniff, IP, TCP, UDP, ICMP
    SCAPY_AVAILABLE = True
except ImportError:
    SCAPY_AVAILABLE = False

from mock_data import MockDataGenerator, PacketInfo


class PacketCapture:
    def __init__(self):
        self._running = False
        self._callback: Optional[Callable[[PacketInfo], None]] = None
        self._thread: Optional[threading.Thread] = None
        self._mock_generator = MockDataGenerator()

    def set_callback(self, callback: Callable[[PacketInfo], None]):
        self._callback = callback

    def _process_scapy_packet(self, packet) -> Optional[PacketInfo]:
        if not SCAPY_AVAILABLE:
            return None

        if IP not in packet:
            return None

        src_ip = packet[IP].src
        dst_ip = packet[IP].dst
        src_port = 0
        dst_port = 0
        protocol = "OTHER"

        if TCP in packet:
            protocol = "TCP"
            src_port = packet[TCP].sport
            dst_port = packet[TCP].dport
        elif UDP in packet:
            protocol = "UDP"
            src_port = packet[UDP].sport
            dst_port = packet[UDP].dport
        elif ICMP in packet:
            protocol = "ICMP"

        packet_size = len(packet)
        timestamp = float(packet.time)

        return PacketInfo(
            src_ip=src_ip,
            dst_ip=dst_ip,
            src_port=src_port,
            dst_port=dst_port,
            protocol=protocol,
            packet_size=packet_size,
            timestamp=timestamp
        )

    def start_live_capture(self, interface: Optional[str] = None, filter_str: str = "ip"):
        if not SCAPY_AVAILABLE:
            raise RuntimeError("Scapy not available. Install scapy or use mock mode.")

        if self._running:
            return

        self._running = True

        def packet_handler(packet):
            info = self._process_scapy_packet(packet)
            if info and self._callback:
                self._callback(info)

        def capture_thread():
            sniff(iface=interface, filter=filter_str, prn=packet_handler, store=0)

        self._thread = threading.Thread(target=capture_thread, daemon=True)
        self._thread.start()

    def start_mock_capture(self, packets_per_second: int = 50):
        if self._running:
            return

        self._running = True

        def mock_thread():
            interval = 1.0 / packets_per_second
            while self._running:
                packet = self._mock_generator.generate_packet(interval)
                if self._callback:
                    self._callback(packet)
                time.sleep(interval)

        self._thread = threading.Thread(target=mock_thread, daemon=True)
        self._thread.start()

    def read_pcap_file(self, pcap_path: str) -> List[PacketInfo]:
        if not SCAPY_AVAILABLE:
            raise RuntimeError("Scapy not available. Cannot read PCAP files.")

        packets = rdpcap(pcap_path)
        results = []
        for packet in packets:
            info = self._process_scapy_packet(packet)
            if info:
                results.append(info)
        return results

    def read_mock_historical(self, duration_seconds: int = 300,
                             packets_per_second: int = 100) -> List[PacketInfo]:
        return self._mock_generator.generate_historical(duration_seconds, packets_per_second)

    def stop(self):
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._thread = None
