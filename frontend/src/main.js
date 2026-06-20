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
