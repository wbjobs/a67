import time
import math
from collections import defaultdict, deque
from typing import Dict, List, Tuple, Optional
import threading


class SlidingWindowStats:
    def __init__(self, window_size: int = 10):
        self.window_size = window_size
        self._windows: Dict[str, deque] = defaultdict(lambda: deque(maxlen=window_size))
        self._sums: Dict[str, float] = defaultdict(float)
        self._squares: Dict[str, float] = defaultdict(float)

    def add(self, key: str, value: float):
        window = self._windows[key]
        if len(window) == self.window_size:
            old_val = window[0]
            self._sums[key] -= old_val
            self._squares[key] -= old_val * old_val
        window.append(value)
        self._sums[key] += value
        self._squares[key] += value * value

    def get_mean(self, key: str) -> float:
        window = self._windows.get(key)
        if not window or len(window) < 2:
            return 0.0
        return self._sums[key] / len(window)

    def get_std(self, key: str) -> float:
        window = self._windows.get(key)
        if not window or len(window) < 2:
            return 0.0
        n = len(window)
        mean = self._sums[key] / n
        variance = (self._squares[key] / n) - (mean * mean)
        return math.sqrt(max(variance, 0.0))

    def get_threshold(self, key: str, sigma: float = 3.0) -> float:
        mean = self.get_mean(key)
        std = self.get_std(key)
        return mean + sigma * std

    def is_anomaly(self, key: str, value: float, sigma: float = 3.0) -> bool:
        window = self._windows.get(key)
        if not window or len(window) < 3:
            return False
        threshold = self.get_threshold(key, sigma)
        return value > threshold

    def clear(self):
        self._windows.clear()
        self._sums.clear()
        self._squares.clear()


class AnomalyDetector:
    def __init__(self, window_size: int = 10, sigma_threshold: float = 3.0,
                 min_flows_for_detection: int = 5):
        self.window_size = window_size
        self.sigma_threshold = sigma_threshold
        self.min_flows_for_detection = min_flows_for_detection

        self._src_stats = SlidingWindowStats(window_size)
        self._dst_stats = SlidingWindowStats(window_size)

        self._current_src_counts: Dict[str, int] = defaultdict(int)
        self._current_dst_counts: Dict[str, int] = defaultdict(int)
        self._current_src_ports: Dict[str, set] = defaultdict(set)
        self._current_dst_srcs: Dict[str, set] = defaultdict(set)

        self._suspicious_sources: Dict[str, dict] = {}
        self._suspicious_destinations: Dict[str, dict] = {}
        self._alerts: List[dict] = []
        self._max_alerts = 100

        self._last_tick = time.time()
        self._tick_interval = 1.0
        self._lock = threading.RLock()

    def set_sigma_threshold(self, sigma: float):
        with self._lock:
            self.sigma_threshold = max(1.0, min(10.0, sigma))

    def set_window_size(self, size: int):
        with self._lock:
            self.window_size = max(3, min(60, size))
            self._src_stats = SlidingWindowStats(self.window_size)
            self._dst_stats = SlidingWindowStats(self.window_size)

    def set_min_flows_for_detection(self, min_flows: int):
        with self._lock:
            self.min_flows_for_detection = max(1, min(100, min_flows))

    def process_flow(self, flow: dict):
        with self._lock:
            src_ip = flow.get('src_ip')
            dst_ip = flow.get('dst_ip')
            dst_port = flow.get('dst_port', 0)

            if src_ip:
                self._current_src_counts[src_ip] += 1
                if dst_port:
                    self._current_src_ports[src_ip].add(dst_port)

            if dst_ip:
                self._current_dst_counts[dst_ip] += 1
                if src_ip:
                    self._current_dst_srcs[dst_ip].add(src_ip)

    def tick(self):
        with self._lock:
            now = time.time()
            if now - self._last_tick < self._tick_interval:
                return

            self._last_tick = now

            self._check_source_anomalies(now)
            self._check_destination_anomalies(now)

            self._current_src_counts.clear()
            self._current_dst_counts.clear()
            self._current_src_ports.clear()
            self._current_dst_srcs.clear()

    def _check_source_anomalies(self, now: float):
        for src_ip, count in self._current_src_counts.items():
            self._src_stats.add(src_ip, count)

            if count >= self.min_flows_for_detection and self._src_stats.is_anomaly(
                    src_ip, count, self.sigma_threshold):
                unique_ports = len(self._current_src_ports.get(src_ip, set()))
                alert_type = 'port_scan' if unique_ports >= 10 else 'high_connection_rate'

                mean = self._src_stats.get_mean(src_ip)
                std = self._src_stats.get_std(src_ip)
                threshold = mean + self.sigma_threshold * std

                if src_ip not in self._suspicious_sources or \
                        self._suspicious_sources[src_ip]['first_seen'] < now - 60:

                    alert = {
                        'id': f'src_{src_ip}_{int(now * 1000)}',
                        'type': alert_type,
                        'ip': src_ip,
                        'role': 'source',
                        'flow_count': count,
                        'mean': round(mean, 2),
                        'std': round(std, 2),
                        'threshold': round(threshold, 2),
                        'sigma_multiplier': self.sigma_threshold,
                        'unique_ports': unique_ports,
                        'severity': self._calc_severity(count, threshold),
                        'timestamp': now
                    }

                    self._suspicious_sources[src_ip] = {
                        'first_seen': now,
                        'last_seen': now,
                        'max_count': count,
                        'alert_type': alert_type
                    }

                    self._add_alert(alert)
                else:
                    self._suspicious_sources[src_ip]['last_seen'] = now
                    self._suspicious_sources[src_ip]['max_count'] = max(
                        self._suspicious_sources[src_ip]['max_count'], count
                    )

    def _check_destination_anomalies(self, now: float):
        for dst_ip, count in self._current_dst_counts.items():
            self._dst_stats.add(dst_ip, count)

            if count >= self.min_flows_for_detection and self._dst_stats.is_anomaly(
                    dst_ip, count, self.sigma_threshold):
                unique_srcs = len(self._current_dst_srcs.get(dst_ip, set()))
                alert_type = 'ddos_target' if unique_srcs >= 10 else 'high_inbound_rate'

                mean = self._dst_stats.get_mean(dst_ip)
                std = self._dst_stats.get_std(dst_ip)
                threshold = mean + self.sigma_threshold * std

                if dst_ip not in self._suspicious_destinations or \
                        self._suspicious_destinations[dst_ip]['first_seen'] < now - 60:

                    alert = {
                        'id': f'dst_{dst_ip}_{int(now * 1000)}',
                        'type': alert_type,
                        'ip': dst_ip,
                        'role': 'destination',
                        'flow_count': count,
                        'mean': round(mean, 2),
                        'std': round(std, 2),
                        'threshold': round(threshold, 2),
                        'sigma_multiplier': self.sigma_threshold,
                        'unique_sources': unique_srcs,
                        'severity': self._calc_severity(count, threshold),
                        'timestamp': now
                    }

                    self._suspicious_destinations[dst_ip] = {
                        'first_seen': now,
                        'last_seen': now,
                        'max_count': count,
                        'alert_type': alert_type
                    }

                    self._add_alert(alert)
                else:
                    self._suspicious_destinations[dst_ip]['last_seen'] = now
                    self._suspicious_destinations[dst_ip]['max_count'] = max(
                        self._suspicious_destinations[dst_ip]['max_count'], count
                    )

    def _calc_severity(self, count: int, threshold: float) -> str:
        if threshold <= 0:
            return 'high'
        ratio = count / threshold
        if ratio >= 5:
            return 'critical'
        elif ratio >= 3:
            return 'high'
        elif ratio >= 1.5:
            return 'medium'
        else:
            return 'low'

    def _add_alert(self, alert: dict):
        self._alerts.insert(0, alert)
        if len(self._alerts) > self._max_alerts:
            self._alerts = self._alerts[:self._max_alerts]

    def get_suspicious_ips(self) -> Dict[str, dict]:
        with self._lock:
            suspicious = {}
            now = time.time()

            for ip, info in self._suspicious_sources.items():
                if now - info['last_seen'] < 60:
                    suspicious[ip] = {
                        **info,
                        'role': 'source',
                        'is_suspicious': True
                    }

            for ip, info in self._suspicious_destinations.items():
                if now - info['last_seen'] < 60:
                    if ip in suspicious:
                        suspicious[ip]['role'] = 'both'
                        suspicious[ip]['max_count'] = max(
                            suspicious[ip]['max_count'], info['max_count']
                        )
                    else:
                        suspicious[ip] = {
                            **info,
                            'role': 'destination',
                            'is_suspicious': True
                        }

            return suspicious

    def get_alerts(self, limit: int = 50) -> List[dict]:
        with self._lock:
            return self._alerts[:limit]

    def get_stats(self) -> dict:
        with self._lock:
            suspicious = self.get_suspicious_ips()
            return {
                'total_suspicious_ips': len(suspicious),
                'suspicious_sources': sum(
                    1 for v in suspicious.values() if v['role'] in ('source', 'both')
                ),
                'suspicious_destinations': sum(
                    1 for v in suspicious.values() if v['role'] in ('destination', 'both')
                ),
                'total_alerts': len(self._alerts),
                'sigma_threshold': self.sigma_threshold,
                'window_size': self.window_size,
                'min_flows_for_detection': self.min_flows_for_detection
            }

    def clear(self):
        with self._lock:
            self._src_stats.clear()
            self._dst_stats.clear()
            self._current_src_counts.clear()
            self._current_dst_counts.clear()
            self._current_src_ports.clear()
            self._current_dst_srcs.clear()
            self._suspicious_sources.clear()
            self._suspicious_destinations.clear()
            self._alerts.clear()
