import { onMount, onCleanup, createEffect, createSignal } from 'solid-js';

import { agents } from '~/lib/stores/agents';
import { api, type AgentChannelData } from '~/lib/api';
import { showToast } from '~/components/shared/Toast';

// ---- Types ----

interface TopoNode {
  id: string;
  type: 'server' | 'category' | 'channel' | 'agent';
  label: string;
  sub: string;
  detail: string;
  fullName: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number;
  fy: number;
  r: number;
  color: string;
  glow: string;
  jid: string;
  avatarUrl: string | null;
  avatarImg: HTMLImageElement | null;
}

interface TopoEdge {
  from: string;
  to: string;
  type: 'hierarchy' | 'agent';
}

interface Particle {
  from: TopoNode;
  to: TopoNode;
  t: number;
  speed: number;
  color: string;
}

// ---- Constants ----

const COLORS = {
  agent: '#818cf8',
  server: '#fbbf24',
  category: '#22d3ee',
  channel: '#34d399',
  agentGlow: 'rgba(129,140,248,.2)',
  serverGlow: 'rgba(251,191,36,.18)',
  categoryGlow: 'rgba(34,211,238,.15)',
  channelGlow: 'rgba(52,211,153,.15)',
  edgeHierarchy: 'rgba(255,255,255,.08)',
  edgeAgent: 'rgba(129,140,248,.12)',
  edgeHierarchyActive: 'rgba(255,255,255,.35)',
  edgeAgentActive: 'rgba(129,140,248,.4)',
  text: '#cdd2dc',
  textDim: '#636a7e',
};

const SIM_STEPS = 250;
const HIER_LEN = 70;
const HIER_K = 0.025;
const AGENT_LEN = 130;
const AGENT_K = 0.003;
const REPULSE = 3500;
const DAMP = 0.82;
const CENTER_PULL = 0.002;
const SAME_TYPE_REPULSE = 2000;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;

// ---- Avatar loading with retry ----

function attachAvatar(node: TopoNode): void {
  node.avatarImg = null;
  if (!node.avatarUrl) return;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  let attempts = 0;
  function load() {
    const sep = node.avatarUrl!.indexOf('?') === -1 ? '?' : '&';
    img.src = node.avatarUrl! + (attempts > 0 ? sep + 'retry=' + attempts : '');
  }
  img.onload = () => {
    node.avatarImg = img;
  };
  img.onerror = () => {
    if (attempts >= 3) return;
    attempts++;
    setTimeout(load, 1500 * attempts);
  };
  load();
}

// ---- Build topology graph from agent data ----

function buildGraph(
  agentData: AgentChannelData[],
  centerX: number,
  centerY: number,
): { nodes: TopoNode[]; edges: TopoEdge[]; nodeMap: Record<string, TopoNode> } {
  const nodes: TopoNode[] = [];
  const edges: TopoEdge[] = [];
  const nodeMap: Record<string, TopoNode> = {};
  const serverSet: Record<string, boolean> = {};
  const categorySet: Record<string, boolean> = {};
  const channelSet: Record<string, boolean> = {};

  function makeNode(
    overrides: Partial<TopoNode> & { id: string; type: TopoNode['type'] },
  ): TopoNode {
    return {
      label: '',
      sub: '',
      detail: '',
      fullName: '',
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      fx: 0,
      fy: 0,
      r: 10,
      color: COLORS.channel,
      glow: COLORS.channelGlow,
      jid: '',
      avatarUrl: null,
      avatarImg: null,
      ...overrides,
    };
  }

  // 1) Servers
  for (const a of agentData) {
    const server = a.serverFolder;
    if (!server) continue;
    const sk = 's:' + server;
    if (!serverSet[sk]) {
      serverSet[sk] = true;
      const sn = makeNode({
        id: sk,
        type: 'server',
        label: server.split('/').pop() || server,
        sub: 'server',
        detail: server,
        fullName: server.split('/').pop() || server,
        r: 24,
        color: COLORS.server,
        glow: COLORS.serverGlow,
        jid: server,
        avatarUrl: a.serverIconUrl || null,
      });
      attachAvatar(sn);
      nodes.push(sn);
      nodeMap[sk] = sn;
    } else if (a.serverIconUrl && !nodeMap[sk].avatarUrl) {
      nodeMap[sk].avatarUrl = a.serverIconUrl;
      attachAvatar(nodeMap[sk]);
    }
  }

  // 2) Categories and channels
  for (const a of agentData) {
    for (const ch of a.channels) {
      if (ch.categoryFolder) {
        const catK = 'cat:' + ch.categoryFolder;
        if (!categorySet[catK]) {
          categorySet[catK] = true;
          const catLabel =
            ch.categoryFolder.split('/').pop() || ch.categoryFolder;
          const cn = makeNode({
            id: catK,
            type: 'category',
            label: catLabel,
            sub: 'category',
            detail: ch.categoryFolder,
            fullName: catLabel,
            r: 16,
            color: COLORS.category,
            glow: COLORS.categoryGlow,
            jid: ch.categoryFolder,
          });
          nodes.push(cn);
          nodeMap[catK] = cn;

          if (a.serverFolder) {
            const sk = 's:' + a.serverFolder;
            if (
              nodeMap[sk] &&
              ch.categoryFolder.indexOf(a.serverFolder) === 0
            ) {
              edges.push({ from: sk, to: catK, type: 'hierarchy' });
            }
          }
        }
      }

      const chK = 'ch:' + ch.jid;
      if (!channelSet[chK]) {
        channelSet[chK] = true;
        const chName = ch.displayName;
        const chNode = makeNode({
          id: chK,
          type: 'channel',
          label: chName.length > 22 ? chName.slice(0, 20) + '\u2026' : chName,
          sub: 'channel',
          detail: ch.jid,
          fullName: chName,
          r: 10,
          color: COLORS.channel,
          glow: COLORS.channelGlow,
          jid: ch.jid,
          avatarUrl: ch.iconUrl || null,
        });
        attachAvatar(chNode);
        nodes.push(chNode);
        nodeMap[chK] = chNode;

        if (ch.categoryFolder) {
          edges.push({
            from: 'cat:' + ch.categoryFolder,
            to: chK,
            type: 'hierarchy',
          });
        } else if (a.serverFolder) {
          edges.push({
            from: 's:' + a.serverFolder,
            to: chK,
            type: 'hierarchy',
          });
        }
      } else {
        nodeMap[chK].r = Math.min(14, nodeMap[chK].r + 1);
      }
    }
  }

  // 3) Agent nodes
  for (const a of agentData) {
    const ak = 'a:' + a.id;
    const an = makeNode({
      id: ak,
      type: 'agent',
      label: a.name,
      sub: a.backend,
      detail:
        (a.remoteInstanceName
          ? 'remote:' + a.remoteInstanceName + ' \u2022 '
          : '') +
        a.agentRuntime +
        (a.isAdmin ? ' (admin)' : ''),
      fullName: a.name,
      r: 22,
      color: COLORS.agent,
      glow: COLORS.agentGlow,
      jid: a.id,
      avatarUrl: a.avatarUrl || null,
    });
    attachAvatar(an);
    nodes.push(an);
    nodeMap[ak] = an;

    for (const ch of a.channels) {
      edges.push({ from: ak, to: 'ch:' + ch.jid, type: 'agent' });
    }
  }

  // Initial layout: hierarchical rings
  const serverNodes = nodes.filter((n) => n.type === 'server');
  const catNodes = nodes.filter((n) => n.type === 'category');
  const chNodes = nodes.filter((n) => n.type === 'channel');
  const agentNodes = nodes.filter((n) => n.type === 'agent');

  serverNodes.forEach((n, i) => {
    const angle =
      (2 * Math.PI * i) / Math.max(1, serverNodes.length) - Math.PI / 2;
    n.x = centerX + Math.cos(angle) * 60;
    n.y = centerY + Math.sin(angle) * 60;
  });
  catNodes.forEach((n, i) => {
    const angle =
      (2 * Math.PI * i) / Math.max(1, catNodes.length) - Math.PI / 4;
    n.x = centerX + Math.cos(angle) * 180;
    n.y = centerY + Math.sin(angle) * 180;
  });
  chNodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, chNodes.length);
    n.x = centerX + Math.cos(angle) * 320;
    n.y = centerY + Math.sin(angle) * 320;
  });
  agentNodes.forEach((n, i) => {
    const angle =
      (2 * Math.PI * i) / Math.max(1, agentNodes.length) + Math.PI / 6;
    n.x = centerX + Math.cos(angle) * 140;
    n.y = centerY + Math.sin(angle) * 140;
  });

  return { nodes, edges, nodeMap };
}

// ---- Component ----

export default function TopologyCanvas() {
  let canvasRef!: HTMLCanvasElement;
  let wrapRef!: HTMLDivElement;
  let tooltipRef!: HTMLDivElement;

  const [agentData, setAgentData] = createSignal<AgentChannelData[]>([]);

  // Fetch full agent topology data when SSE agent list changes (includes initial load)
  createEffect(() => {
    const _count = agents.list.length;
    api
      .getAgents()
      .then(setAgentData)
      .catch(() => {});
  });

  onMount(() => {
    const canvas = canvasRef;
    const wrap = wrapRef;
    const tooltip = tooltipRef;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;

    const dpr = window.devicePixelRatio || 1;
    let W = 0;
    let H = 0;
    let resizeRetryTimer: ReturnType<typeof setTimeout> | null = null;

    // Pan & Zoom state
    let panX = 0;
    let panY = 0;
    let zoom = 1;

    function resize(): boolean {
      const r = wrap.getBoundingClientRect();
      W = Math.max(0, r.width);
      H = Math.max(0, r.height);
      if (!W || !H) {
        if (resizeRetryTimer) clearTimeout(resizeRetryTimer);
        resizeRetryTimer = setTimeout(() => {
          resizeRetryTimer = null;
          if (canvas.isConnected) resize();
        }, 80);
        return false;
      }
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      return true;
    }
    resize();

    const ro = new ResizeObserver(() => resize());
    ro.observe(wrap);

    function refreshLayout() {
      if (!canvas.isConnected || document.visibilityState === 'hidden') return;
      const hadSize = !!(W && H);
      if (resize() && (!hadSize || !hasFitted)) fitView();
    }
    window.addEventListener('pageshow', refreshLayout);
    document.addEventListener('visibilitychange', refreshLayout);

    function screenToWorld(sx: number, sy: number) {
      return { x: (sx - panX) / zoom, y: (sy - panY) / zoom };
    }

    // Graph state
    let nodes: TopoNode[] = [];
    let edges: TopoEdge[] = [];
    let nodeMap: Record<string, TopoNode> = {};
    let particles: Particle[] = [];
    let step = 0;
    let hoverNode: TopoNode | null = null;
    let dragNode: TopoNode | null = null;
    let dragOff = { x: 0, y: 0 };
    let isPanning = false;
    let panStart = { x: 0, y: 0 };
    let panStartOff = { x: 0, y: 0 };
    let time = 0;
    let animFrame: number | null = null;
    let hasFitted = false;

    // Rebuild graph when agentData changes
    createEffect(() => {
      const data = agentData();
      if (data.length === 0) return;
      const centerX = W / 2 || 300;
      const centerY = H / 2 || 200;
      const graph = buildGraph(data, centerX, centerY);
      nodes = graph.nodes;
      edges = graph.edges;
      nodeMap = graph.nodeMap;
      particles = [];
      step = 0;
      hasFitted = false;
    });

    function fitView() {
      if (nodes.length === 0) return;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const n of nodes) {
        minX = Math.min(minX, n.x - n.r - 30);
        maxX = Math.max(maxX, n.x + n.r + 30);
        minY = Math.min(minY, n.y - n.r - 30);
        maxY = Math.max(maxY, n.y + n.r + 30);
      }
      const graphW = maxX - minX;
      const graphH = maxY - minY;
      if (graphW < 1 || graphH < 1) return;
      zoom = Math.min(W / graphW, H / graphH) * 0.85;
      zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
      panX = W / 2 - ((minX + maxX) / 2) * zoom;
      panY = H / 2 - ((minY + maxY) / 2) * zoom;
    }

    function getConnected(node: TopoNode): Record<string, boolean> {
      const set: Record<string, boolean> = { [node.id]: true };
      for (const e of edges) {
        if (e.from === node.id) set[e.to] = true;
        if (e.to === node.id) set[e.from] = true;
      }
      return set;
    }

    function simulate() {
      for (const n of nodes) {
        n.fx = 0;
        n.fy = 0;
      }

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) d2 = 1;
          let rep = REPULSE;
          if (a.type === b.type) rep += SAME_TYPE_REPULSE;
          const f = rep / d2;
          const dist = Math.sqrt(d2);
          const fx = (dx / dist) * f;
          const fy = (dy / dist) * f;
          a.fx -= fx;
          a.fy -= fy;
          b.fx += fx;
          b.fy += fy;
        }
      }

      for (const e of edges) {
        const a = nodeMap[e.from];
        const b = nodeMap[e.to];
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const len = e.type === 'hierarchy' ? HIER_LEN : AGENT_LEN;
        const k = e.type === 'hierarchy' ? HIER_K : AGENT_K;
        const f = (d - len) * k;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.fx += fx;
        a.fy += fy;
        b.fx -= fx;
        b.fy -= fy;
      }

      const centerX = W / 2;
      const centerY = H / 2;
      for (const n of nodes) {
        n.fx += (centerX - n.x) * CENTER_PULL;
        n.fy += (centerY - n.y) * CENTER_PULL;
      }

      for (const n of nodes) {
        if (n === dragNode) continue;
        n.vx = (n.vx + n.fx) * DAMP;
        n.vy = (n.vy + n.fy) * DAMP;
        n.x += n.vx;
        n.y += n.vy;
      }
    }

    function spawnParticle() {
      if (edges.length === 0) return;
      const e = edges[Math.floor(Math.random() * edges.length)];
      if (e.type !== 'hierarchy') return;
      const a = nodeMap[e.from];
      const b = nodeMap[e.to];
      if (!a || !b) return;
      particles.push({
        from: a,
        to: b,
        t: 0,
        speed: 0.6 + Math.random() * 0.4,
        color: a.color,
      });
    }

    function draw() {
      time += 0.016;
      if (step < SIM_STEPS) {
        simulate();
        step++;
      }

      if (W && H && step === SIM_STEPS && !hasFitted) {
        hasFitted = true;
        fitView();
      }

      ctx2d!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2d!.clearRect(0, 0, W, H);
      ctx2d!.setTransform(zoom * dpr, 0, 0, zoom * dpr, panX * dpr, panY * dpr);

      const connSet = hoverNode ? getConnected(hoverNode) : null;

      // Draw edges
      for (const e of edges) {
        const a = nodeMap[e.from];
        const b = nodeMap[e.to];
        if (!a || !b) continue;
        const isActive =
          connSet &&
          (connSet[a.id] || connSet[b.id]) &&
          (hoverNode === a || hoverNode === b);
        ctx2d!.beginPath();
        ctx2d!.moveTo(a.x, a.y);
        ctx2d!.lineTo(b.x, b.y);
        if (e.type === 'hierarchy') {
          ctx2d!.strokeStyle = isActive
            ? COLORS.edgeHierarchyActive
            : COLORS.edgeHierarchy;
          ctx2d!.lineWidth = isActive ? 2 : 1.2;
          ctx2d!.setLineDash([]);
        } else {
          ctx2d!.strokeStyle = isActive
            ? COLORS.edgeAgentActive
            : COLORS.edgeAgent;
          ctx2d!.lineWidth = isActive ? 1.5 : 0.6;
          ctx2d!.setLineDash([4, 4]);
        }
        ctx2d!.stroke();
        ctx2d!.setLineDash([]);
      }

      // Particles
      if (Math.random() < 0.12) spawnParticle();
      for (let pi = particles.length - 1; pi >= 0; pi--) {
        const p = particles[pi];
        p.t += p.speed * 0.016;
        if (p.t >= 1) {
          particles.splice(pi, 1);
          continue;
        }
        const px = p.from.x + (p.to.x - p.from.x) * p.t;
        const py = p.from.y + (p.to.y - p.from.y) * p.t;
        const alpha = Math.sin(p.t * Math.PI) * 0.7;
        ctx2d!.beginPath();
        ctx2d!.arc(px, py, 2 / zoom, 0, Math.PI * 2);
        const c = p.color;
        if (c.charAt(0) === '#') {
          const r2 = parseInt(c.slice(1, 3), 16);
          const g2 = parseInt(c.slice(3, 5), 16);
          const b2 = parseInt(c.slice(5, 7), 16);
          ctx2d!.fillStyle =
            'rgba(' + r2 + ',' + g2 + ',' + b2 + ',' + alpha + ')';
        } else {
          ctx2d!.fillStyle = c;
        }
        ctx2d!.fill();
      }

      // Draw nodes
      for (let ni = 0; ni < nodes.length; ni++) {
        const n = nodes[ni];
        const isHover = hoverNode === n;
        const isConn = connSet ? !!connSet[n.id] : true;
        const dimmed = connSet && !isConn;
        const pulse = isHover
          ? 1.15
          : 1 + Math.sin(time * 1.8 + ni * 0.5) * 0.03;
        const r = n.r * pulse;
        const nodeAlpha = dimmed ? 0.2 : 1;

        ctx2d!.globalAlpha = nodeAlpha;

        // Glow
        ctx2d!.beginPath();
        ctx2d!.arc(n.x, n.y, r + 5, 0, Math.PI * 2);
        ctx2d!.fillStyle = n.glow;
        ctx2d!.fill();

        // Body gradient
        ctx2d!.beginPath();
        ctx2d!.arc(n.x, n.y, r, 0, Math.PI * 2);
        const grad = ctx2d!.createRadialGradient(
          n.x - r * 0.3,
          n.y - r * 0.3,
          0,
          n.x,
          n.y,
          r,
        );
        grad.addColorStop(0, n.color);
        grad.addColorStop(1, n.color + '99');
        ctx2d!.fillStyle = grad;
        ctx2d!.fill();

        // Border
        ctx2d!.beginPath();
        ctx2d!.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx2d!.strokeStyle = isHover ? '#fff' : n.color;
        ctx2d!.lineWidth = (isHover ? 2.5 : 1) / zoom;
        ctx2d!.stroke();

        // Avatar or letter
        if (n.avatarImg) {
          ctx2d!.save();
          ctx2d!.beginPath();
          ctx2d!.arc(n.x, n.y, r * 0.85, 0, Math.PI * 2);
          ctx2d!.clip();
          ctx2d!.drawImage(
            n.avatarImg,
            n.x - r * 0.85,
            n.y - r * 0.85,
            r * 1.7,
            r * 1.7,
          );
          ctx2d!.restore();
        } else {
          ctx2d!.font = '600 ' + r * 0.7 + "px 'JetBrains Mono',monospace";
          ctx2d!.textAlign = 'center';
          ctx2d!.textBaseline = 'middle';
          ctx2d!.fillStyle = 'rgba(0,0,0,.35)';
          const icon =
            n.type === 'server'
              ? 'S'
              : n.type === 'category'
                ? 'C'
                : n.type === 'agent'
                  ? 'A'
                  : '#';
          ctx2d!.fillText(icon, n.x, n.y + 1);
        }

        // Label
        const fontSize =
          n.type === 'agent' || n.type === 'server'
            ? 11
            : n.type === 'category'
              ? 10
              : 9;
        ctx2d!.font =
          (n.type === 'agent' || n.type === 'server' ? '600 ' : '500 ') +
          fontSize +
          "px 'JetBrains Mono',monospace";
        ctx2d!.textAlign = 'center';
        ctx2d!.textBaseline = 'top';
        ctx2d!.fillStyle = isHover
          ? '#fff'
          : dimmed
            ? COLORS.textDim
            : COLORS.text;
        ctx2d!.fillText(n.label, n.x, n.y + r + 4);

        ctx2d!.globalAlpha = 1;
      }

      // Reset transform for overlay
      ctx2d!.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (zoom !== 1) {
        ctx2d!.font = "500 10px 'JetBrains Mono',monospace";
        ctx2d!.textAlign = 'left';
        ctx2d!.textBaseline = 'top';
        ctx2d!.fillStyle = COLORS.textDim;
        ctx2d!.fillText(Math.round(zoom * 100) + '%', 8, 8);
      }

      animFrame = requestAnimationFrame(draw);
    }
    draw();

    // ---- Hit testing ----
    function getNode(sx: number, sy: number): TopoNode | null {
      const w = screenToWorld(sx, sy);
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const dx = w.x - n.x;
        const dy = w.y - n.y;
        const hitR = n.r + 4;
        if (dx * dx + dy * dy < hitR * hitR) return n;
      }
      return null;
    }

    function mousePos(e: MouseEvent) {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function escapeHtml(s: string): string {
      return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    // ---- Mouse move ----
    canvas.addEventListener('mousemove', (e) => {
      const m = mousePos(e);
      if (isPanning) {
        panX = panStartOff.x + (m.x - panStart.x);
        panY = panStartOff.y + (m.y - panStart.y);
        return;
      }
      if (dragNode) {
        const w = screenToWorld(m.x, m.y);
        dragNode.x = w.x + dragOff.x;
        dragNode.y = w.y + dragOff.y;
        dragNode.vx = 0;
        dragNode.vy = 0;
        step = Math.max(0, SIM_STEPS - 40);
        return;
      }
      const n = getNode(m.x, m.y);
      hoverNode = n;
      if (n) {
        canvas.style.cursor = 'pointer';
        tooltip.className = 'topo-tooltip visible';
        tooltip.innerHTML =
          '<div><span class="tt-name">' +
          escapeHtml(n.fullName || n.label) +
          '</span>' +
          '<span class="tt-type ' +
          n.type +
          '">' +
          n.type +
          '</span></div>' +
          '<div class="tt-detail">' +
          escapeHtml(n.detail || n.jid) +
          '</div>' +
          '<div class="tt-copy">click to copy</div>';
        tooltip.style.left = Math.min(m.x + 12, W - 200) + 'px';
        tooltip.style.top = m.y - 10 + 'px';
      } else {
        canvas.style.cursor = 'grab';
        tooltip.className = 'topo-tooltip';
      }
    });

    // ---- Mouse down ----
    canvas.addEventListener('mousedown', (e) => {
      const m = mousePos(e);
      const n = getNode(m.x, m.y);
      if (n) {
        const w = screenToWorld(m.x, m.y);
        dragNode = n;
        dragOff = { x: n.x - w.x, y: n.y - w.y };
        canvas.classList.add('dragging');
      } else {
        isPanning = true;
        panStart = { x: m.x, y: m.y };
        panStartOff = { x: panX, y: panY };
        canvas.classList.add('dragging');
      }
    });

    function handleMouseUp() {
      if (dragNode) {
        dragNode = null;
        canvas.classList.remove('dragging');
      }
      if (isPanning) {
        isPanning = false;
        canvas.classList.remove('dragging');
      }
    }
    document.addEventListener('mouseup', handleMouseUp);

    // ---- Zoom ----
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const m = mousePos(e);
        const oldZoom = zoom;
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * delta));
        panX = m.x - (m.x - panX) * (zoom / oldZoom);
        panY = m.y - (m.y - panY) * (zoom / oldZoom);
      },
      { passive: false },
    );

    // ---- Click ----
    canvas.addEventListener('click', (e) => {
      if (isPanning) return;
      const m = mousePos(e);
      const n = getNode(m.x, m.y);
      if (n && n.jid) {
        navigator.clipboard.writeText(n.jid).then(() => {
          showToast('Copied: ' + n.jid);
        });
      }
    });

    // ---- Double-click to fit ----
    canvas.addEventListener('dblclick', (e) => {
      const m = mousePos(e);
      if (getNode(m.x, m.y)) return;
      fitView();
    });

    // ---- Cleanup ----
    onCleanup(() => {
      ro.disconnect();
      if (animFrame) cancelAnimationFrame(animFrame);
      if (resizeRetryTimer) clearTimeout(resizeRetryTimer);
      window.removeEventListener('pageshow', refreshLayout);
      document.removeEventListener('visibilitychange', refreshLayout);
      document.removeEventListener('mouseup', handleMouseUp);
    });
  });

  return (
    <div class="flex flex-col flex-1 min-h-0">
      <div class="flex items-center justify-between px-1 mb-2">
        <h2 class="text-sm font-semibold text-text-bright">agent topology</h2>
        <div class="flex items-center gap-3 text-xs text-text-dim">
          <span class="flex items-center gap-1">
            <span
              class="inline-block w-2 h-2 rounded-full"
              style={{ background: COLORS.agent }}
            />
            agent
          </span>
          <span class="flex items-center gap-1">
            <span
              class="inline-block w-2 h-2 rounded-full"
              style={{ background: COLORS.server }}
            />
            server
          </span>
          <span class="flex items-center gap-1">
            <span
              class="inline-block w-2 h-2 rounded-full"
              style={{ background: COLORS.category }}
            />
            category
          </span>
          <span class="flex items-center gap-1">
            <span
              class="inline-block w-2 h-2 rounded-full"
              style={{ background: COLORS.channel }}
            />
            channel
          </span>
        </div>
      </div>
      <div ref={wrapRef!} class="flex-1 min-h-0 relative">
        <canvas ref={canvasRef!} class="block w-full h-full" />
        <div ref={tooltipRef!} class="topo-tooltip" />
      </div>
    </div>
  );
}
