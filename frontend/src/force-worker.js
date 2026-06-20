import * as d3 from 'd3';

let simulation = null;
let nodes = [];
let links = [];
let currentTick = 0;
const TICK_INTERVAL = 2;

function initSimulation(width, height) {
  if (simulation) {
    simulation.stop();
  }

  simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(120).strength(0.5))
    .force('charge', d3.forceManyBody().strength(-300))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('x', d3.forceX(width / 2).strength(0.03))
    .force('y', d3.forceY(height / 2).strength(0.03))
    .force('collision', d3.forceCollide().radius(35))
    .alphaDecay(0.028)
    .velocityDecay(0.4)
    .on('tick', () => {
      currentTick++;
      if (currentTick % TICK_INTERVAL === 0) {
        postTick();
      }
    });

  simulation.alpha(1).restart();
}

function postTick() {
  const nodePositions = nodes.map(n => ({
    id: n.id,
    x: n.x,
    y: n.y,
    vx: n.vx,
    vy: n.vy,
    fx: n.fx,
    fy: n.fy
  }));

  const linkPositions = links.map(l => ({
    id: l.id,
    sourceX: l.source.x,
    sourceY: l.source.y,
    targetX: l.target.x,
    targetY: l.target.y
  }));

  self.postMessage({
    type: 'tick',
    data: {
      nodes: nodePositions,
      links: linkPositions,
      alpha: simulation.alpha()
    }
  });
}

function updateData(newNodes, newLinks, width, height) {
  const nodeMap = new Map();
  nodes.forEach(n => nodeMap.set(n.id, n));

  nodes = newNodes.map(n => {
    const existing = nodeMap.get(n.id);
    return {
      ...n,
      x: existing ? existing.x : undefined,
      y: existing ? existing.y : undefined,
      vx: existing ? existing.vx : 0,
      vy: existing ? existing.vy : 0,
      fx: existing ? existing.fx : null,
      fy: existing ? existing.fy : null
    };
  });

  const sourceTargetMap = new Map();
  nodes.forEach(n => sourceTargetMap.set(n.id, n));

  links = newLinks.map(l => ({
    ...l,
    source: sourceTargetMap.get(l.source) || l.source,
    target: sourceTargetMap.get(l.target) || l.target
  }));

  initSimulation(width, height);
}

function updateSize(width, height) {
  if (simulation) {
    simulation
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('x', d3.forceX(width / 2).strength(0.03))
      .force('y', d3.forceY(height / 2).strength(0.03))
      .alpha(0.3)
      .restart();
  }
}

function fixNode(id, fx, fy) {
  const node = nodes.find(n => n.id === id);
  if (node) {
    node.fx = fx;
    node.fy = fy;
    if (simulation) {
      simulation.alphaTarget(0.3).restart();
    }
  }
}

function releaseNode(id) {
  const node = nodes.find(n => n.id === id);
  if (node) {
    node.fx = null;
    node.fy = null;
    if (simulation) {
      simulation.alphaTarget(0);
    }
  }
}

function restart(alpha = 0.5) {
  if (simulation) {
    simulation.alpha(alpha).restart();
  }
}

function stop() {
  if (simulation) {
    simulation.stop();
  }
}

self.onmessage = (event) => {
  const { type, data } = event.data;

  switch (type) {
    case 'init':
      updateData(data.nodes, data.links, data.width, data.height);
      break;

    case 'updateData':
      updateData(data.nodes, data.links, data.width, data.height);
      break;

    case 'updateSize':
      updateSize(data.width, data.height);
      break;

    case 'fixNode':
      fixNode(data.id, data.fx, data.fy);
      break;

    case 'releaseNode':
      releaseNode(data.id);
      break;

    case 'restart':
      restart(data?.alpha || 0.5);
      break;

    case 'stop':
      stop();
      break;
  }
};
