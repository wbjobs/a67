import { FlowFlightClient } from './flight-client.js';
import { TopologyGraph } from './topology-graph.js';
import { TimeSlider } from './time-slider.js';

const PROTOCOL_COLORS = {
  'TCP': '#ff6b6b',
  'UDP': '#4ecdc4',
  'ICMP': '#ffe66d',
  'OTHER': '#8892a6'
};

class App {
  constructor() {
    this.client = null;
    this.graph = null;
    this.timeSlider = null;
    this.currentFlows = [];
    this.flowMap = new Map();
    this.streamInfo = null;
    this.incrementalUpdateTimer = null;
    this.pendingFlows = [];
    this.INCREMENTAL_INTERVAL = 200;
    this.suspiciousIps = {};
    this.alerts = [];
    this.anomalyStats = null;
    this.alertPanel = null;
    this.alertList = null;
    this.alertCountBadge = null;
    this.thresholdPanel = null;
    this._init();
  }

  async _init() {
    this._initDOM();
    this._initGraph();
    this._initTimeSlider();
    this._initDetailPanel();

    try {
      await this._connectBackend();
    } catch (e) {
      console.error('[App] Failed to connect backend:', e);
      this._updateConnectionStatus('error');
    }
  }

  _initDOM() {
    this.statFlows = document.getElementById('stat-flows');
    this.statIps = document.getElementById('stat-ips');
    this.statBytes = document.getElementById('stat-bytes');
    this.statPackets = document.getElementById('stat-packets');
    this.connectionStatus = document.getElementById('connection-status');
    this.statusDot = this.connectionStatus.querySelector('.status-dot');
    this.statusText = this.connectionStatus.querySelector('.status-text');
    this.detailPanel = document.getElementById('detail-panel');
    this.panelContent = document.getElementById('panel-content');
    this.closePanelBtn = document.getElementById('close-panel');
    this.streamProgress = document.createElement('div');
    this.streamProgress.id = 'stream-progress';
    this.streamProgress.style.cssText = `
      position: fixed;
      top: 80px;
      right: 20px;
      background: rgba(10, 14, 23, 0.9);
      border: 1px solid #1e2a3a;
      border-radius: 8px;
      padding: 10px 16px;
      color: #00d4ff;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      z-index: 1000;
      display: none;
      backdrop-filter: blur(10px);
    `;
    document.body.appendChild(this.streamProgress);

    this._initAlertPanel();
    this._initThresholdPanel();
  }

  _initAlertPanel() {
    this.alertPanel = document.createElement('div');
    this.alertPanel.id = 'alert-panel';
    this.alertPanel.style.cssText = `
      position: fixed;
      top: 80px;
      left: 20px;
      width: 320px;
      max-height: calc(100vh - 180px);
      background: rgba(10, 14, 23, 0.92);
      border: 1px solid #2a1a1a;
      border-radius: 10px;
      z-index: 999;
      backdrop-filter: blur(12px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      padding: 12px 16px;
      border-bottom: 1px solid #2a1a1a;
      display: flex;
      align-items: center;
      justify-content: space-between;
    `;
    header.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="font-size: 16px;">⚠️</span>
        <span style="color: #ff6b6b; font-weight: bold; font-size: 14px;">异常告警</span>
        <span id="alert-count-badge" style="
          background: #ff4444;
          color: white;
          font-size: 11px;
          padding: 2px 8px;
          border-radius: 10px;
          font-weight: bold;
        ">0</span>
      </div>
      <button id="toggle-alert-panel" style="
        background: none;
        border: 1px solid #2a1a1a;
        color: #8892a6;
        padding: 4px 10px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
      ">收起</button>
    `;
    this.alertPanel.appendChild(header);

    this.alertList = document.createElement('div');
    this.alertList.style.cssText = `
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    `;
    this.alertPanel.appendChild(this.alertList);

    document.body.appendChild(this.alertPanel);

    const toggleBtn = header.querySelector('#toggle-alert-panel');
    let collapsed = false;
    toggleBtn.addEventListener('click', () => {
      collapsed = !collapsed;
      this.alertList.style.display = collapsed ? 'none' : 'block';
      toggleBtn.textContent = collapsed ? '展开' : '收起';
    });

    this.alertCountBadge = header.querySelector('#alert-count-badge');
  }

  _initThresholdPanel() {
    this.thresholdPanel = document.createElement('div');
    this.thresholdPanel.id = 'threshold-panel';
    this.thresholdPanel.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 280px;
      background: rgba(10, 14, 23, 0.92);
      border: 1px solid #1e2a3a;
      border-radius: 10px;
      padding: 14px 16px;
      z-index: 998;
      backdrop-filter: blur(12px);
      font-size: 12px;
      color: #e8ecf3;
    `;

    this.thresholdPanel.innerHTML = `
      <div style="font-weight: bold; margin-bottom: 12px; color: #00d4ff;">
        ⚙️ 异常检测阈值
      </div>
      <div style="margin-bottom: 10px;">
        <label style="display: block; margin-bottom: 4px; color: #8892a6;">
          Sigma 阈值 (σ): <span id="sigma-value" style="color: #00d4ff;">3.0</span>
        </label>
        <input type="range" id="sigma-slider" min="1" max="10" step="0.5" value="3"
          style="width: 100%; accent-color: #00d4ff;">
      </div>
      <div style="margin-bottom: 10px;">
        <label style="display: block; margin-bottom: 4px; color: #8892a6;">
          滑动窗口大小: <span id="window-value" style="color: #00d4ff;">10</span>
        </label>
        <input type="range" id="window-slider" min="3" max="60" step="1" value="10"
          style="width: 100%; accent-color: #00d4ff;">
      </div>
      <div style="margin-bottom: 10px;">
        <label style="display: block; margin-bottom: 4px; color: #8892a6;">
          最小触发流数: <span id="minflows-value" style="color: #00d4ff;">5</span>
        </label>
        <input type="range" id="minflows-slider" min="1" max="100" step="1" value="5"
          style="width: 100%; accent-color: #00d4ff;">
      </div>
      <button id="apply-threshold" style="
        width: 100%;
        padding: 6px;
        background: linear-gradient(135deg, #00d4ff, #0099cc);
        border: none;
        border-radius: 6px;
        color: white;
        font-weight: bold;
        cursor: pointer;
        margin-top: 6px;
      ">应用设置</button>
    `;

    document.body.appendChild(this.thresholdPanel);

    const sigmaSlider = this.thresholdPanel.querySelector('#sigma-slider');
    const sigmaValue = this.thresholdPanel.querySelector('#sigma-value');
    const windowSlider = this.thresholdPanel.querySelector('#window-slider');
    const windowValue = this.thresholdPanel.querySelector('#window-value');
    const minflowsSlider = this.thresholdPanel.querySelector('#minflows-slider');
    const minflowsValue = this.thresholdPanel.querySelector('#minflows-value');
    const applyBtn = this.thresholdPanel.querySelector('#apply-threshold');

    sigmaSlider.addEventListener('input', (e) => {
      sigmaValue.textContent = parseFloat(e.target.value).toFixed(1);
    });

    windowSlider.addEventListener('input', (e) => {
      windowValue.textContent = e.target.value;
    });

    minflowsSlider.addEventListener('input', (e) => {
      minflowsValue.textContent = e.target.value;
    });

    applyBtn.addEventListener('click', () => {
      const params = {
        sigma_threshold: parseFloat(sigmaSlider.value),
        window_size: parseInt(windowSlider.value),
        min_flows_for_detection: parseInt(minflowsSlider.value)
      };
      if (this.client && this.client.connected) {
        this.client.setAnomalyThreshold(params).then(stats => {
          if (stats) {
            console.log('[App] Threshold updated:', stats);
          }
        });
      }
    });
  }

  _initGraph() {
    const svg = document.getElementById('topology-svg');
    const tooltip = document.getElementById('tooltip');
    this.graph = new TopologyGraph(svg, tooltip);

    this.graph.setNodeClickHandler((node) => {
      this._showNodeDetail(node);
    });

    this.graph.setLinkClickHandler((link) => {
      this._showLinkDetail(link);
    });
  }

  _initTimeSlider() {
    this.timeSlider = new TimeSlider();

    this.timeSlider.setTimeWindowChangeHandler((start, end) => {
      console.log(`[App] Time window changed: ${new Date(start * 1000).toLocaleTimeString()} - ${new Date(end * 1000).toLocaleTimeString()}`);
      if (this.client && this.client.connected) {
        this.client.setTimeWindow(start, end);
      }
    });
  }

  _initDetailPanel() {
    this.closePanelBtn.addEventListener('click', () => {
      this.detailPanel.classList.remove('open');
    });
  }

  async _connectBackend() {
    this.client = new FlowFlightClient('localhost', 8815);

    this.client.on('connect', () => {
      console.log('[App] Connected to backend');
      this._updateConnectionStatus('connected');

      this.client.getTimeRange().then(range => {
        if (range && range.min_time && range.max_time) {
          console.log(`[App] Time range: ${new Date(range.min_time * 1000)} - ${new Date(range.max_time * 1000)}`);
          this.timeSlider.setTimeRange(range.min_time, range.max_time);
        }
      });

      this.client.getStats().then(stats => {
        if (stats) {
          this._updateStats(stats);
        }
      });
    });

    this.client.on('disconnect', () => {
      console.log('[App] Disconnected from backend');
      this._updateConnectionStatus('disconnected');
    });

    this.client.on('streamStart', (info) => {
      this.streamInfo = { ...info, received: 0 };
      this._showStreamProgress();
      this.flowMap.clear();
      this.pendingFlows = [];
    });

    this.client.on('streamPage', (info) => {
      if (this.streamInfo) {
        this.streamInfo.received = info.pageIndex;
        this._updateStreamProgress();
      }
    });

    this.client.on('dataPartial', (flows) => {
      flows.forEach(flow => {
        this.flowMap.set(flow.flow_id, flow);
      });
      this.pendingFlows.push(...flows);

      if (!this.incrementalUpdateTimer) {
        this.incrementalUpdateTimer = setTimeout(() => {
          this._flushIncrementalUpdate();
        }, this.INCREMENTAL_INTERVAL);
      }
    });

    this.client.on('streamEnd', (info) => {
      if (this.incrementalUpdateTimer) {
        clearTimeout(this.incrementalUpdateTimer);
        this.incrementalUpdateTimer = null;
      }
      this._flushIncrementalUpdate();
      this._hideStreamProgress();
      console.log(`[App] Stream complete: ${info.totalFlows} flows received`);
      this.streamInfo = null;
    });

    this.client.on('data', (flows) => {
      this.currentFlows = flows;
      this._updateStatsFromFlows(flows);
    });

    this.client.on('stats', (stats) => {
      this._updateStats(stats);
    });

    this.client.on('anomalyUpdate', (data) => {
      this._handleAnomalyUpdate(data);
    });

    this.client.on('anomalyStats', (data) => {
      this._handleAnomalyUpdate(data);
    });

    this.client.on('error', (error) => {
      console.error('[App] Client error:', error);
      this._updateConnectionStatus('error');
    });

    await this.client.connect();
  }

  _flushIncrementalUpdate() {
    if (this.pendingFlows.length === 0) {
      this.incrementalUpdateTimer = null;
      return;
    }

    const allFlows = Array.from(this.flowMap.values());
    this.currentFlows = allFlows;
    this.graph.updateData(allFlows);
    this._updateStatsFromFlows(allFlows);
    this.pendingFlows = [];
    this.incrementalUpdateTimer = null;
  }

  _showStreamProgress() {
    if (!this.streamInfo) return;
    const { totalRows, totalPages } = this.streamInfo;
    this.streamProgress.innerHTML = `
      <div style="font-weight: bold; margin-bottom: 4px;">📡 数据加载中</div>
      <div>总行数: <span style="color: #fff;">${totalRows.toLocaleString()}</span></div>
      <div>已接收: <span id="progress-pages">0</span> / ${totalPages} 页</div>
      <div style="margin-top: 6px; background: #1e2a3a; height: 4px; border-radius: 2px; overflow: hidden;">
        <div id="progress-bar" style="height: 100%; background: linear-gradient(90deg, #00d4ff, #00ff88); width: 0%; transition: width 0.3s;"></div>
      </div>
    `;
    this.streamProgress.style.display = 'block';
  }

  _updateStreamProgress() {
    if (!this.streamInfo) return;
    const { received, totalPages } = this.streamInfo;
    const pagesEl = document.getElementById('progress-pages');
    const barEl = document.getElementById('progress-bar');
    if (pagesEl) pagesEl.textContent = received;
    if (barEl) barEl.style.width = `${(received / totalPages) * 100}%`;
  }

  _hideStreamProgress() {
    setTimeout(() => {
      this.streamProgress.style.display = 'none';
    }, 500);
  }

  _updateConnectionStatus(status) {
    this.statusDot.classList.remove('connected', 'error');

    if (status === 'connected') {
      this.statusDot.classList.add('connected');
      this.statusText.textContent = '已连接';
    } else if (status === 'error') {
      this.statusDot.classList.add('error');
      this.statusText.textContent = '连接失败';
    } else {
      this.statusText.textContent = '连接中...';
    }
  }

  _updateStats(stats) {
    this.statFlows.textContent = stats.total_flows.toLocaleString();
    this.statIps.textContent = stats.unique_ips.toLocaleString();
    this.statBytes.textContent = this._formatBytes(stats.total_bytes);
    this.statPackets.textContent = stats.total_packets.toLocaleString();
  }

  _updateStatsFromFlows(flows) {
    const ipSet = new Set();
    let totalBytes = 0;
    let totalPackets = 0;

    flows.forEach(flow => {
      ipSet.add(flow.src_ip);
      ipSet.add(flow.dst_ip);
      totalBytes += flow.byte_count;
      totalPackets += flow.packet_count;
    });

    this.statFlows.textContent = flows.length.toLocaleString();
    this.statIps.textContent = ipSet.size.toLocaleString();
    this.statBytes.textContent = this._formatBytes(totalBytes);
    this.statPackets.textContent = totalPackets.toLocaleString();
  }

  _handleAnomalyUpdate(data) {
    if (!data) return;

    this.anomalyStats = data.stats || null;
    this.suspiciousIps = data.suspicious_ips || {};
    this.alerts = data.alerts || [];

    if (this.graph) {
      this.graph.setSuspiciousIps(this.suspiciousIps);
    }

    this._updateAlertList();
    this._updateAlertBadge();
  }

  _updateAlertBadge() {
    if (this.alertCountBadge) {
      const count = Object.keys(this.suspiciousIps || {}).length;
      this.alertCountBadge.textContent = count;
      this.alertCountBadge.style.display = count > 0 ? 'inline-block' : 'none';
    }
  }

  _updateAlertList() {
    if (!this.alertList) return;

    const alerts = this.alerts || [];
    if (alerts.length === 0) {
      this.alertList.innerHTML = `
        <div style="text-align: center; color: #8892a6; padding: 30px 10px; font-size: 12px;">
          <div style="font-size: 32px; margin-bottom: 8px;">✅</div>
          <div>暂无异常告警</div>
          <div style="margin-top: 4px; opacity: 0.6;">系统运行正常</div>
        </div>
      `;
      return;
    }

    const severityColors = {
      'critical': '#ff2222',
      'high': '#ff6b6b',
      'medium': '#ffaa00',
      'low': '#8892a6'
    };

    const typeLabels = {
      'port_scan': '端口扫描',
      'high_connection_rate': '高连接频率',
      'ddos_target': 'DDoS目标',
      'high_inbound_rate': '高入站流量'
    };

    const roleLabels = {
      'source': '攻击源',
      'destination': '被攻击目标',
      'both': '双向异常'
    };

    this.alertList.innerHTML = alerts.slice(0, 30).map(alert => {
      const time = new Date(alert.timestamp * 1000).toLocaleTimeString();
      const color = severityColors[alert.severity] || '#8892a6';
      const typeLabel = typeLabels[alert.type] || alert.type;
      const roleLabel = roleLabels[alert.role] || alert.role;

      return `
        <div class="alert-item" style="
          background: rgba(255, 68, 68, 0.08);
          border: 1px solid ${color}40;
          border-left: 3px solid ${color};
          border-radius: 6px;
          padding: 8px 10px;
          margin-bottom: 6px;
          cursor: pointer;
          transition: background 0.2s;
        " onmouseover="this.style.background='rgba(255,68,68,0.15)'"
           onmouseout="this.style.background='rgba(255,68,68,0.08)'"
           data-ip="${alert.ip}">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span style="color: ${color}; font-weight: bold; font-size: 11px;">
              ${typeLabel}
            </span>
            <span style="color: #8892a6; font-size: 10px;">${time}</span>
          </div>
          <div style="color: #e8ecf3; font-size: 12px; font-family: monospace; margin-bottom: 4px;">
            ${alert.ip}
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 10px; color: #8892a6;">
            <span>${roleLabel}</span>
            <span>${alert.flow_count} 条流</span>
          </div>
          <div style="font-size: 10px; color: #8892a6; margin-top: 2px;">
            阈值: ${alert.threshold} | 当前: ${alert.flow_count} (${alert.sigma_multiplier}σ)
          </div>
        </div>
      `;
    }).join('');

    Array.from(this.alertList.querySelectorAll('.alert-item')).forEach(item => {
      item.addEventListener('click', () => {
        const ip = item.dataset.ip;
        if (ip) {
          const node = this.graph && this.graph.nodeMap && this.graph.nodeMap.get(ip);
          if (node) {
            this._showNodeDetail(node);
          }
        }
      });
    });
  }

  _showNodeDetail(node) {
    const relatedFlows = this.currentFlows.filter(f =>
      f.src_ip === node.id || f.dst_ip === node.id
    ).sort((a, b) => b.byte_count - a.byte_count);

    const isInternal = node.isInternal ? '内网节点' : '外网节点';

    const html = `
      <div class="flow-detail">
        <h3>${node.id}</h3>
        <div class="detail-row">
          <span class="label">节点类型</span>
          <span class="value">${isInternal}</span>
        </div>
        <div class="detail-row">
          <span class="label">关联流数</span>
          <span class="value">${relatedFlows.length}</span>
        </div>
        <div class="detail-row">
          <span class="label">总字节</span>
          <span class="value">${this._formatBytes(node.totalBytes)}</span>
        </div>
        <div class="detail-row">
          <span class="label">总包数</span>
          <span class="value">${node.totalPackets.toLocaleString()}</span>
        </div>

        <h3 style="margin-top: 24px">相关流 (Top 10)</h3>
        <div class="flow-list">
          ${relatedFlows.slice(0, 10).map(flow => `
            <div class="flow-list-item">
              <div class="flow-ips">
                ${flow.src_ip} → ${flow.dst_ip}
              </div>
              <div class="flow-meta">
                <span style="color: ${PROTOCOL_COLORS[flow.protocol] || PROTOCOL_COLORS.OTHER}">${flow.protocol}</span>
                <span>${this._formatBytes(flow.byte_count)}</span>
                <span>${flow.packet_count}包</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    this.panelContent.innerHTML = html;
    this.detailPanel.classList.add('open');
  }

  _showLinkDetail(link) {
    const flows = link.flows.sort((a, b) => b.byte_count - a.byte_count);
    const srcId = typeof link.source === 'object' ? link.source.id : link.source;
    const dstId = typeof link.target === 'object' ? link.target.id : link.target;

    const html = `
      <div class="flow-detail">
        <h3>${srcId} ↔ ${dstId}</h3>
        <div class="detail-row">
          <span class="label">协议</span>
          <span class="value ${link.protocol.toLowerCase()}">${link.protocol}</span>
        </div>
        <div class="detail-row">
          <span class="label">流数量</span>
          <span class="value">${flows.length}</span>
        </div>
        <div class="detail-row">
          <span class="label">总字节</span>
          <span class="value">${this._formatBytes(link.totalBytes)}</span>
        </div>
        <div class="detail-row">
          <span class="label">总包数</span>
          <span class="value">${link.totalPackets.toLocaleString()}</span>
        </div>

        <h3 style="margin-top: 24px">流详情</h3>
        <div class="flow-list">
          ${flows.map(flow => `
            <div class="flow-list-item">
              <div class="flow-ips">
                ${flow.src_ip}:${flow.src_port} → ${flow.dst_ip}:${flow.dst_port}
              </div>
              <div class="flow-meta">
                <span style="color: ${PROTOCOL_COLORS[flow.protocol] || PROTOCOL_COLORS.OTHER}">${flow.protocol}</span>
                <span>${this._formatBytes(flow.byte_count)}</span>
                <span>${flow.packet_count}包</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    this.panelContent.innerHTML = html;
    this.detailPanel.classList.add('open');
  }

  _formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
      bytes /= 1024;
      i++;
    }
    return bytes.toFixed(1) + units[i];
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new App();
});

export default App;
