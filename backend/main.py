import time
import sys
import signal
import pyarrow.compute as pc

from mock_data import MockDataGenerator
from flow_aggregator import FlowAggregator
from packet_capture import PacketCapture
from arrow_store import ArrowStore
from flight_server import FlowFlightServer, run_server
from websocket_server import WebSocketBridge
from anomaly_detector import AnomalyDetector


def main():
    store = ArrowStore()
    aggregator = FlowAggregator()
    capture = PacketCapture()
    detector = AnomalyDetector(window_size=10, sigma_threshold=3.0, min_flows_for_detection=5)

    print("[Main] ========================================")
    print("[Main] 网络流量分析器 - Network Flow Analyzer")
    print("[Main] ========================================")
    print()

    print("[Main] 生成历史模拟数据 (5分钟)...")
    historical = capture.read_mock_historical(duration_seconds=300, packets_per_second=80)
    print(f"[Main] 已生成 {len(historical)} 个历史数据包")

    for packet in historical:
        flow = aggregator.process_packet(packet)

    print(f"[Main] 聚合成 {len(aggregator)} 条流")
    store.add_flows(aggregator.get_all_flows())
    print(f"[Main] 已存储 {store.count()} 条流到 Arrow RecordBatch")
    print()

    def on_packet(packet):
        flow = aggregator.process_packet(packet)
        store.update_flow(flow)
        detector.process_flow({
            'src_ip': flow.src_ip,
            'dst_ip': flow.dst_ip,
            'dst_port': flow.dst_port
        })

    capture.set_callback(on_packet)
    capture.start_mock_capture(packets_per_second=30)
    print("[Main] 模拟抓包已启动 (30包/秒)")
    print()

    ws_bridge = WebSocketBridge(store, host="localhost", port=8815, anomaly_detector=detector)
    ws_bridge.start()
    print(f"[Main] WebSocket 桥接服务已启动: ws://localhost:8815")
    print()

    print("[Main] ========================================")
    print("[Main] 服务已就绪")
    print("[Main] 前端地址: http://localhost:5173")
    print("[Main] 按 Ctrl+C 停止服务")
    print("[Main] ========================================")

    def handle_shutdown(signum, frame):
        print("\n[Main] 正在关闭服务...")
        capture.stop()
        ws_bridge.stop()
        print("[Main] 服务已停止")
        sys.exit(0)

    signal.signal(signal.SIGINT, handle_shutdown)
    signal.signal(signal.SIGTERM, handle_shutdown)

    try:
        while True:
            time.sleep(1)
            stats = store.get_table()
            anomaly_stats = detector.get_stats()
            if stats.num_rows > 0:
                total_bytes = int(pc.sum(stats['byte_count']).as_py())
                total_packets = int(pc.sum(stats['packet_count']).as_py())
                print(f"\r[Main] 实时流数: {store.count()} | 字节: {format_bytes(total_bytes)} | 包数: {total_packets} | 可疑IP: {anomaly_stats['total_suspicious_ips']}", end='', flush=True)
    except KeyboardInterrupt:
        handle_shutdown(None, None)


def format_bytes(num_bytes: int) -> str:
    for unit in ['B', 'KB', 'MB', 'GB']:
        if num_bytes < 1024:
            return f"{num_bytes:.1f}{unit}"
        num_bytes /= 1024
    return f"{num_bytes:.1f}TB"


if __name__ == "__main__":
    main()
