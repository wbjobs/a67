import * as Arrow from 'apache-arrow';

export class FlowFlightClient {
  constructor(host = 'localhost', port = 8815) {
    this.host = host;
    this.port = port;
    this.clientId = null;
    this.connected = false;
    this.listeners = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 2000;
    this.timeWindow = null;
    this.ws = null;
    this._eventHandlers = {
      data: [],
      stats: [],
      connect: [],
      disconnect: [],
      error: [],
      timeRange: [],
      streamStart: [],
      streamPage: [],
      streamEnd: [],
      anomalyUpdate: [],
      anomalyStats: [],
      anomalyThresholdUpdated: []
    };
    this._currentStream = null;
    this._pendingFlows = [];
    this._streamBuffer = [];
  }

  async connect() {
    try {
      const wsUrl = `ws://${this.host}:${this.port}/ws`;
      console.log(`[FlightClient] Connecting to ${wsUrl}`);

      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        console.log('[FlightClient] WebSocket connected');
        this.connected = true;
        this.reconnectAttempts = 0;
        this._emit('connect');
      };

      this.ws.onmessage = async (event) => {
        try {
          if (event.data instanceof ArrayBuffer) {
            const uint8 = new Uint8Array(event.data);
            await this._handleBinary(uint8);
          } else if (event.data instanceof Blob) {
            const buffer = await event.data.arrayBuffer();
            const uint8 = new Uint8Array(buffer);
            await this._handleBinary(uint8);
          } else {
            const message = JSON.parse(event.data);
            this._handleMessage(message);
          }
        } catch (e) {
          console.error('[FlightClient] Message parse error:', e);
        }
      };

      this.ws.onerror = (error) => {
        console.error('[FlightClient] WebSocket error:', error);
        this._emit('error', error);
      };

      this.ws.onclose = () => {
        console.log('[FlightClient] WebSocket disconnected');
        this.connected = false;
        this._emit('disconnect');
        this._attemptReconnect();
      };

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, 5000);

        this.once('connect', () => {
          clearTimeout(timeout);
          this._registerClient();
          resolve(this);
        });

        this.once('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

    } catch (e) {
      console.error('[FlightClient] Connection error:', e);
      this._emit('error', e);
      throw e;
    }
  }

  _attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[FlightClient] Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);
    console.log(`[FlightClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch(() => {});
    }, delay);
  }

  _registerClient() {
    const registerMsg = {
      action: 'register_listener',
      client_id: `browser_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    };
    this._send(registerMsg);
  }

  async setTimeWindow(startTime, endTime) {
    this.timeWindow = [startTime, endTime];
    const msg = {
      action: 'set_time_window',
      client_id: this.clientId,
      start_time: startTime,
      end_time: endTime
    };
    this._send(msg);
  }

  async getStats() {
    return new Promise((resolve) => {
      const msg = { action: 'get_stats' };
      this._send(msg);

      const handler = (stats) => {
        this.off('stats', handler);
        resolve(stats);
      };
      this.once('stats', handler);

      setTimeout(() => {
        this.off('stats', handler);
        resolve(null);
      }, 3000);
    });
  }

  async getTimeRange() {
    return new Promise((resolve) => {
      const msg = { action: 'get_time_range' };
      this._send(msg);

      const handler = (range) => {
        this.off('timeRange', handler);
        resolve(range);
      };
      this.once('timeRange', handler);

      setTimeout(() => {
        this.off('timeRange', handler);
        resolve(null);
      }, 3000);
    });
  }

  async getAnomalyStats() {
    return new Promise((resolve) => {
      const msg = { action: 'get_anomaly_stats' };
      this._send(msg);

      const handler = (data) => {
        this.off('anomalyStats', handler);
        resolve(data);
      };
      this.once('anomalyStats', handler);

      setTimeout(() => {
        this.off('anomalyStats', handler);
        resolve(null);
      }, 3000);
    });
  }

  async setAnomalyThreshold(params) {
    return new Promise((resolve) => {
      const msg = {
        action: 'set_anomaly_threshold',
        ...params
      };
      this._send(msg);

      const handler = (data) => {
        this.off('anomalyThresholdUpdated', handler);
        resolve(data);
      };
      this.once('anomalyThresholdUpdated', handler);

      setTimeout(() => {
        this.off('anomalyThresholdUpdated', handler);
        resolve(null);
      }, 3000);
    });
  }

  _send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  _handleMessage(message) {
    if (message.type === 'register_response') {
      this.clientId = message.client_id;
      console.log(`[FlightClient] Registered as ${this.clientId}`);
    } else if (message.type === 'stats') {
      this._emit('stats', message.data);
    } else if (message.type === 'time_range') {
      this._emit('timeRange', message.data);
    } else if (message.type === 'time_window_response') {
      console.log('[FlightClient] Time window updated:', message.data);
    } else if (message.type === 'stream_start') {
      this._handleStreamStart(message);
    } else if (message.type === 'stream_page') {
      this._handleStreamPage(message);
    } else if (message.type === 'stream_end') {
      this._handleStreamEnd(message);
    } else if (message.type === 'anomaly_update') {
      this._emit('anomalyUpdate', message.data);
    } else if (message.type === 'anomaly_stats') {
      this._emit('anomalyStats', message.data);
    } else if (message.type === 'anomaly_threshold_updated') {
      this._emit('anomalyThresholdUpdated', message.data);
    }
  }

  _handleStreamStart(message) {
    this._currentStream = {
      streamId: message.stream_id,
      totalRows: message.total_rows,
      totalPages: message.total_pages,
      pageSize: message.page_size,
      pagesReceived: 0,
      flows: []
    };
    this._streamBuffer = [];
    console.log(`[FlightClient] Stream start: ${message.stream_id}, total: ${message.total_rows} rows, ${message.total_pages} pages`);
    this._emit('streamStart', {
      streamId: message.stream_id,
      totalRows: message.total_rows,
      totalPages: message.total_pages
    });
  }

  _handleStreamPage(message) {
    if (this._currentStream) {
      this._currentStream.pagesReceived = message.page_index;
    }
    this._emit('streamPage', {
      streamId: message.stream_id,
      pageIndex: message.page_index,
      totalPages: message.total_pages,
      rowsInPage: message.rows_in_page
    });
  }

  async _handleStreamEnd(message) {
    if (this._currentStream) {
      console.log(`[FlightClient] Stream end: ${message.stream_id}, sent ${message.pages_sent} pages, collected ${this._currentStream.flows.length} flows`);
      const allFlows = [...this._currentStream.flows];
      this._emit('streamEnd', {
        streamId: message.stream_id,
        pagesSent: message.pages_sent,
        totalFlows: allFlows.length
      });
      if (allFlows.length > 0) {
        this._emit('data', allFlows);
      }
      this._currentStream = null;
    }
  }

  async _handleBinary(uint8) {
    try {
      const reader = Arrow.RecordBatchReader.from(uint8);
      for await (const batch of reader) {
        this._handleRecordBatch(batch);
      }
    } catch (e) {
      console.warn('[FlightClient] Binary parse error (might be partial stream):', e.message);
    }
  }

  _handleRecordBatch(batch) {
    const flows = [];
    const numRows = batch.numRows;

    for (let i = 0; i < numRows; i++) {
      const row = batch.get(i);
      flows.push({
        flow_id: row.flow_id,
        src_ip: row.src_ip,
        dst_ip: row.dst_ip,
        src_port: row.src_port,
        dst_port: row.dst_port,
        protocol: row.protocol,
        packet_count: Number(row.packet_count),
        byte_count: Number(row.byte_count),
        start_time: row.start_time ? new Date(row.start_time).getTime() / 1000 : 0,
        end_time: row.end_time ? new Date(row.end_time).getTime() / 1000 : 0,
        duration: Number(row.duration)
      });
    }

    if (this._currentStream) {
      this._currentStream.flows.push(...flows);
    }

    this._emit('dataPartial', flows);
  }

  on(event, handler) {
    if (!this._eventHandlers[event]) {
      this._eventHandlers[event] = [];
    }
    this._eventHandlers[event].push(handler);
  }

  off(event, handler) {
    if (this._eventHandlers[event]) {
      this._eventHandlers[event] = this._eventHandlers[event].filter(h => h !== handler);
    }
  }

  once(event, handler) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      handler(...args);
    };
    this.on(event, wrapper);
  }

  _emit(event, ...args) {
    if (this._eventHandlers[event]) {
      this._eventHandlers[event].forEach(handler => handler(...args));
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

export default FlowFlightClient;
