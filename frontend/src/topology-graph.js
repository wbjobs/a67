import * as d3 from 'd3';

const PROTOCOL_COLORS = {
  'TCP': '#ff6b6b',
  'UDP': '#4ecdc4',
  'ICMP': '#ffe66d',
  'OTHER': '#8892a6'
};

const INTERNAL_IP_PREFIXES = ['192.168', '10.', '172.16', '172.17', '172.18', '172.19', '172.2', '172.3', '172.31'];

function isInternalIP(ip) {
  return INTERNAL_IP_PREFIXES.some(prefix => ip.startsWith(prefix));
}

export class TopologyGraph {
  constructor(svgElement, tooltipElement) {
    this.svg = d3.select(svgElement);
    this.tooltip = d3.select(tooltipElement);
    this.width = 0;
    this.height = 0;
    this.nodes = [];
    this.links = [];
    this.nodeMap = new Map();
    this.linkMap = new Map();
    this.simulation = null;
    this.onNodeClick = null;
    this.onLinkClick = null;

    this._init();
  }

  _init() {
    this._updateSize();
    window.addEventListener('resize', () => this._updateSize());

    this.defs = this.svg.append('defs');

    this.gLink = this.svg.append('g').attr('class', 'links');
    this.gNode = this.svg.append('g').attr('class', 'nodes');
    this.gLabel = this.svg.append('g').attr('class', 'labels');

    this._createDefs();
    this._initSimulation();
  }

  _createDefs() {
    const glowFilter = this.defs.append('filter')
      .attr('id', 'glow')
      .attr('x', '-50%')
      .attr('y', '-50%')
      .attr('width', '200%')
      .attr('height', '200%');

    glowFilter.append('feGaussianBlur')
      .attr('stdDeviation', '3')
      .attr('result', 'coloredBlur');

    const feMerge = glowFilter.append('feMerge');
    feMerge.append('feMergeNode').attr('in', 'coloredBlur');
    feMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    Object.entries(PROTOCOL_COLORS).forEach(([proto, color]) => {
      const gradient = this.defs.append('linearGradient')
        .attr('id', `gradient-${proto}`)
        .attr('x1', '0%')
        .attr('y1', '0%')
        .attr('x2', '100%')
        .attr('y2', '0%');

      gradient.append('stop')
        .attr('offset', '0%')
        .attr('stop-color', color)
        .attr('stop-opacity', 0.3);

      gradient.append('stop')
        .attr('offset', '50%')
        .attr('stop-color', color)
        .attr('stop-opacity', 0.8);

      gradient.append('stop')
        .attr('offset', '100%')
        .attr('stop-color', color)
        .attr('stop-opacity', 0.3);
    });
  }

  _updateSize() {
    const container = this.svg.node().parentElement;
    this.width = container.clientWidth;
    this.height = container.clientHeight;
    this.svg.attr('viewBox', [0, 0, this.width, this.height]);

    if (this.simulation) {
      this.simulation
        .force('center', d3.forceCenter(this.width / 2, this.height / 2))
        .force('x', d3.forceX(this.width / 2).strength(0.05))
        .force('y', d3.forceY(this.height / 2).strength(0.05))
        .alpha(0.3)
        .restart();
    }
  }

  _initSimulation() {
    this.simulation = d3.forceSimulation(this.nodes)
      .force('link', d3.forceLink(this.links).id(d => d.id).distance(120).strength(0.6))
      .force('charge', d3.forceManyBody().strength(-400))
      .force('center', d3.forceCenter(this.width / 2, this.height / 2))
      .force('x', d3.forceX(this.width / 2).strength(0.05))
      .force('y', d3.forceY(this.height / 2).strength(0.05))
      .force('collision', d3.forceCollide().radius(40))
      .alphaDecay(0.02)
      .on('tick', () => this._tick());
  }

  updateData(flows) {
    const newNodeMap = new Map();
    const newLinkMap = new Map();

    flows.forEach(flow => {
      const edgeKey = this._getEdgeKey(flow.src_ip, flow.dst_ip);
      const protocol = flow.protocol || 'OTHER';

      if (!newNodeMap.has(flow.src_ip)) {
        newNodeMap.set(flow.src_ip, {
          id: flow.src_ip,
          isInternal: isInternalIP(flow.src_ip),
          flows: [],
          totalBytes: 0,
          totalPackets: 0
        });
      }
      if (!newNodeMap.has(flow.dst_ip)) {
        newNodeMap.set(flow.dst_ip, {
          id: flow.dst_ip,
          isInternal: isInternalIP(flow.dst_ip),
          flows: [],
          totalBytes: 0,
          totalPackets: 0
        });
      }

      const srcNode = newNodeMap.get(flow.src_ip);
      const dstNode = newNodeMap.get(flow.dst_ip);
      srcNode.flows.push(flow);
      dstNode.flows.push(flow);
      srcNode.totalBytes += flow.byte_count;
      srcNode.totalPackets += flow.packet_count;
      dstNode.totalBytes += flow.byte_count;
      dstNode.totalPackets += flow.packet_count;

      if (!newLinkMap.has(edgeKey)) {
        newLinkMap.set(edgeKey, {
          id: edgeKey,
          source: flow.src_ip,
          target: flow.dst_ip,
          protocol: protocol,
          flows: [],
          totalBytes: 0,
          totalPackets: 0
        });
      }

      const link = newLinkMap.get(edgeKey);
      link.flows.push(flow);
      link.totalBytes += flow.byte_count;
      link.totalPackets += flow.packet_count;
    });

    this.nodes = Array.from(newNodeMap.values());
    this.links = Array.from(newLinkMap.values());
    this.nodeMap = newNodeMap;
    this.linkMap = newLinkMap;

    this._updateVisualization();
  }

  _getEdgeKey(src, dst) {
    return [src, dst].sort().join('|');
  }

  _getStrokeWidth(link) {
    const maxBytes = Math.max(...this.links.map(l => l.totalBytes), 1);
    const normalized = Math.sqrt(link.totalBytes / maxBytes);
    return Math.max(1, normalized * 12);
  }

  _getNodeRadius(node) {
    const maxBytes = Math.max(...this.nodes.map(n => n.totalBytes), 1);
    const normalized = Math.sqrt(node.totalBytes / maxBytes);
    return Math.max(8, normalized * 20 + 8);
  }

  _updateVisualization() {
    this.simulation.nodes(this.nodes);
    this.simulation.force('link').links(this.links);

    this._updateLinks();
    this._updateNodes();
    this._updateLabels();

    this.simulation.alpha(0.5).restart();
  }

  _updateLinks() {
    const self = this;

    const link = this.gLink.selectAll('line')
      .data(this.links, d => d.id);

    link.exit()
      .transition()
      .duration(500)
      .style('stroke-opacity', 0)
      .remove();

    const linkEnter = link.enter()
      .append('line')
      .attr('class', 'link')
      .attr('stroke', d => `url(#gradient-${d.protocol})`)
      .style('stroke-opacity', 0)
      .on('mouseover', function(event, d) {
        d3.select(this)
          .transition()
          .duration(200)
          .style('stroke-opacity', 1)
          .style('stroke-width', self._getStrokeWidth(d) + 2);
        self._showLinkTooltip(event, d);
      })
      .on('mousemove', function(event) {
        self._moveTooltip(event);
      })
      .on('mouseout', function(event, d) {
        d3.select(this)
          .transition()
          .duration(200)
          .style('stroke-opacity', 0.6)
          .style('stroke-width', self._getStrokeWidth(d));
        self._hideTooltip();
      })
      .on('click', function(event, d) {
        if (self.onLinkClick) {
          self.onLinkClick(d);
        }
      });

    linkEnter.merge(link)
      .transition()
      .duration(500)
      .attr('stroke-width', d => this._getStrokeWidth(d))
      .style('stroke-opacity', 0.6);
  }

  _updateNodes() {
    const self = this;

    const node = this.gNode.selectAll('g.node')
      .data(this.nodes, d => d.id);

    node.exit()
      .transition()
      .duration(500)
      .style('opacity', 0)
      .remove();

    const nodeEnter = node.enter()
      .append('g')
      .attr('class', 'node')
      .style('opacity', 0)
      .call(this._drag());

    nodeEnter.append('circle')
      .attr('r', d => this._getNodeRadius(d))
      .attr('fill', d => d.isInternal ? '#00d4ff' : '#8892a6')
      .attr('stroke', d => d.isInternal ? '#0099cc' : '#5a6478')
      .attr('stroke-width', 2)
      .style('filter', 'url(#glow)')
      .on('mouseover', function(event, d) {
        self._showNodeTooltip(event, d);
      })
      .on('mousemove', function(event) {
        self._moveTooltip(event);
      })
      .on('mouseout', function() {
        self._hideTooltip();
      })
      .on('click', function(event, d) {
        if (self.onNodeClick) {
          self.onNodeClick(d);
        }
      });

    nodeEnter.append('text')
      .attr('dy', d => -this._getNodeRadius(d) - 6)
      .text(d => d.id)
      .style('font-size', '10px')
      .style('fill', '#e8ecf3')
      .style('text-anchor', 'middle')
      .style('pointer-events', 'none');

    nodeEnter.merge(node)
      .transition()
      .duration(500)
      .style('opacity', 1);

    node.select('circle')
      .transition()
      .duration(300)
      .attr('r', d => this._getNodeRadius(d))
      .attr('fill', d => d.isInternal ? '#00d4ff' : '#8892a6');
  }

  _updateLabels() {
    const label = this.gLabel.selectAll('text.link-label')
      .data(this.links.filter(l => l.totalBytes > 10000), d => d.id);

    label.exit().remove();

    const labelEnter = label.enter()
      .append('text')
      .attr('class', 'link-label')
      .attr('dy', -5)
      .style('text-anchor', 'middle')
      .style('fill', '#8892a6')
      .style('font-size', '9px')
      .style('pointer-events', 'none');

    labelEnter.merge(label)
      .text(d => this._formatBytes(d.totalBytes));
  }

  _drag() {
    const self = this;
    return d3.drag()
      .on('start', function(event, d) {
        if (!event.active) self.simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', function(event, d) {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', function(event, d) {
        if (!event.active) self.simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });
  }

  _tick() {
    this.gLink.selectAll('line')
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    this.gNode.selectAll('g.node')
      .attr('transform', d => `translate(${d.x},${d.y})`);

    this.gLabel.selectAll('text.link-label')
      .attr('x', d => (d.source.x + d.target.x) / 2)
      .attr('y', d => (d.source.y + d.target.y) / 2);
  }

  _showNodeTooltip(event, node) {
    const isInternal = node.isInternal ? '内网' : '外网';
    const html = `
      <h4>${node.id}</h4>
      <div class="tooltip-row">
        <span class="label">类型</span>
        <span class="value">${isInternal}</span>
      </div>
      <div class="tooltip-row">
        <span class="label">关联流数</span>
        <span class="value">${node.flows.length}</span>
      </div>
      <div class="tooltip-row">
        <span class="label">总字节</span>
        <span class="value">${this._formatBytes(node.totalBytes)}</span>
      </div>
      <div class="tooltip-row">
        <span class="label">总包数</span>
        <span class="value">${node.totalPackets.toLocaleString()}</span>
      </div>
    `;
    this.tooltip.html(html).classed('visible', true);
    this._moveTooltip(event);
  }

  _showLinkTooltip(event, link) {
    const html = `
      <h4>${link.source.id} ↔ ${link.target.id}</h4>
      <div class="tooltip-row">
        <span class="label">协议</span>
        <span class="value" style="color: ${PROTOCOL_COLORS[link.protocol]}">${link.protocol}</span>
      </div>
      <div class="tooltip-row">
        <span class="label">流数量</span>
        <span class="value">${link.flows.length}</span>
      </div>
      <div class="tooltip-row">
        <span class="label">总字节</span>
        <span class="value">${this._formatBytes(link.totalBytes)}</span>
      </div>
      <div class="tooltip-row">
        <span class="label">总包数</span>
        <span class="value">${link.totalPackets.toLocaleString()}</span>
      </div>
    `;
    this.tooltip.html(html).classed('visible', true);
    this._moveTooltip(event);
  }

  _moveTooltip(event) {
    const container = this.svg.node().parentElement.getBoundingClientRect();
    const x = event.clientX - container.left + 15;
    const y = event.clientY - container.top + 15;
    this.tooltip
      .style('left', x + 'px')
      .style('top', y + 'px');
  }

  _hideTooltip() {
    this.tooltip.classed('visible', false);
  }

  _formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
      bytes /= 1024;
      i++;
    }
    return bytes.toFixed(1) + units[i];
  }

  setNodeClickHandler(handler) {
    this.onNodeClick = handler;
  }

  setLinkClickHandler(handler) {
    this.onLinkClick = handler;
  }

  getStats() {
    return {
      nodeCount: this.nodes.length,
      linkCount: this.links.length,
      totalBytes: this.links.reduce((sum, l) => sum + l.totalBytes, 0),
      totalPackets: this.links.reduce((sum, l) => sum + l.totalPackets, 0)
    };
  }
}

export default TopologyGraph;
