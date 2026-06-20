# 网络流量分析器 - Network Flow Analyzer

一个基于 Apache Arrow 和 D3.js 的实时网络流量可视化分析工具。

## 功能特性

- 🔍 **数据包捕获**: 支持 PCAP 文件读取、实时网卡抓包、模拟数据生成
- 📊 **五元组解析**: 提取源IP、目标IP、源端口、目标端口、协议
- 📈 **流量统计**: 按流聚合包数、字节数、持续时间
- 🏛️ **Arrow 列式存储**: 使用 Apache Arrow RecordBatch 高效存储流数据
- 🚀 **高性能传输**: Arrow Flight 协议 + WebSocket 桥接，支持流式推送
- 🎨 **力导向拓扑图**: D3.js 可视化，节点为IP，边粗细表示流量大小，颜色表示协议
- ⏱️ **时间窗口过滤**: 可拖动进度条选择时间范围，后端基于 Arrow 计算引擎过滤数据

## 技术栈

### 后端
- Python 3.10+
- Scapy (数据包解析)
- Apache Arrow (列式存储 + Flight RPC)
- WebSockets (浏览器桥接)

### 前端
- Vite 5
- D3.js v7 (力导向图)
- Apache Arrow JS (数据处理)
- 原生 JavaScript (ES6+)

## 快速开始

### Windows
双击运行 `start.bat` 脚本，自动安装依赖并启动服务。

### 手动启动

#### 1. 启动后端
```bash
cd backend
pip install -r requirements.txt
python main.py
```

#### 2. 启动前端
```bash
cd frontend
npm install
npm run dev
```

#### 3. 访问应用
打开浏览器访问: http://localhost:5173

## 项目结构

```
├── backend/
│   ├── __init__.py
│   ├── main.py              # 主入口
│   ├── mock_data.py         # 模拟数据生成器
│   ├── packet_capture.py    # 抓包/PCAP解析模块
│   ├── flow_aggregator.py   # 流聚合引擎
│   ├── arrow_store.py       # Arrow RecordBatch存储
│   ├── filter.py            # Arrow过滤引擎
│   ├── flight_server.py     # Arrow Flight服务
│   ├── websocket_server.py  # WebSocket桥接
│   └── requirements.txt     # Python依赖
├── frontend/
│   ├── src/
│   │   ├── main.js          # 应用入口
│   │   ├── flight-client.js # Arrow Flight客户端
│   │   ├── topology-graph.js # D3力导向图
│   │   ├── time-slider.js   # 时间窗口控件
│   │   └── styles.css       # 样式
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
├── start.bat                # Windows一键启动
└── README.md
```

## 数据模型 (Arrow Schema)

| 字段名 | 类型 | 说明 |
|--------|------|------|
| flow_id | Utf8 | 流唯一标识 |
| src_ip | Utf8 | 源IP地址 |
| dst_ip | Utf8 | 目标IP地址 |
| src_port | UInt16 | 源端口 |
| dst_port | UInt16 | 目标端口 |
| protocol | Utf8 | 协议 (TCP/UDP/ICMP) |
| packet_count | UInt64 | 包数量 |
| byte_count | UInt64 | 总字节数 |
| start_time | Timestamp(ns) | 流起始时间 |
| end_time | Timestamp(ns) | 流结束时间 |
| duration | Float64 | 持续时间(秒) |

## 可视化说明

- **节点颜色**: 青色=内网IP, 灰色=外网IP
- **节点大小**: 与该IP的总流量成正比
- **边颜色**: 红色=TCP, 青色=UDP, 黄色=ICMP
- **边粗细**: 与该连接的字节数成正比

## 使用说明

1. **查看拓扑**: 页面加载后自动显示当前时间窗口的流量拓扑
2. **拖动节点**: 可拖拽节点调整位置
3. **悬停查看**: 鼠标悬停在节点或边上显示详细信息
4. **点击详情**: 点击节点或边在右侧面板显示详细流信息
5. **调整窗口**: 拖动顶部滑块的左右手柄选择时间范围
6. **快捷选择**: 点击预设按钮快速选择1分钟/5分钟/15分钟等窗口

## 架构说明

```
浏览器 ←WebSocket→ WebSocket桥接 ←Arrow IPC→ Arrow存储
                                            ↑
                                      流聚合引擎
                                            ↑
                                      数据包捕获
                                            ↑
                                PCAP文件 / 实时抓包 / 模拟数据
```

## License

MIT
