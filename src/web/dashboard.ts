import type { WebStateProvider } from './types.js';

/**
 * Render a self-contained HTML dashboard page.
 * Uses inline CSS and vanilla JS — no build step, no external dependencies.
 * Data is bootstrapped server-side; live updates come via WebSocket.
 */
export function renderDashboard(state: WebStateProvider): string {
  const stats = state.getQueueStats();
  const agents = Object.values(state.getAgents());
  const tasks = state.getTasks();
  const subs = state.getChannelSubscriptions();

  // Build agent rows
  const agentRows = agents
    .map((a) => {
      const channels = Object.entries(subs)
        .filter(([, s]) => s.some((sub) => sub.agentId === a.id))
        .map(([jid]) => escapeHtml(jid));
      return `<tr>
        <td>${escapeHtml(a.id)}</td>
        <td>${escapeHtml(a.name)}</td>
        <td><span class="badge badge-${a.backend}">${escapeHtml(a.backend)}</span></td>
        <td>${escapeHtml(a.agentRuntime)}</td>
        <td>${a.isAdmin ? '<span class="badge badge-admin">admin</span>' : ''}</td>
        <td class="channels">${channels.join('<br>') || '—'}</td>
      </tr>`;
    })
    .join('\n');

  // Build task rows (most recent first, cap at 50)
  const taskRows = tasks
    .slice(0, 50)
    .map((t) => {
      const statusClass =
        t.status === 'active'
          ? 'status-active'
          : t.status === 'paused'
            ? 'status-paused'
            : 'status-completed';
      const nextRun = t.next_run
        ? new Date(t.next_run).toLocaleString()
        : '—';
      const lastRun = t.last_run
        ? new Date(t.last_run).toLocaleString()
        : '—';
      return `<tr>
        <td title="${escapeHtml(t.id)}">${escapeHtml(t.id.slice(0, 8))}…</td>
        <td>${escapeHtml(t.group_folder)}</td>
        <td><span class="badge ${statusClass}">${escapeHtml(t.status)}</span></td>
        <td>${escapeHtml(t.schedule_type)}: ${escapeHtml(t.schedule_value)}</td>
        <td title="${escapeHtml(t.prompt)}">${escapeHtml(t.prompt.slice(0, 80))}${t.prompt.length > 80 ? '…' : ''}</td>
        <td>${nextRun}</td>
        <td>${lastRun}</td>
      </tr>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OmniClaw Dashboard</title>
<style>
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --border: #2a2d3a;
    --text: #e1e4ed;
    --text-dim: #8b8fa3;
    --accent: #6366f1;
    --green: #22c55e;
    --yellow: #eab308;
    --red: #ef4444;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
  }
  header {
    padding: 1rem 2rem;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  header h1 { font-size: 1.25rem; font-weight: 600; }
  header .ws-status {
    margin-left: auto;
    font-size: 0.75rem;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    background: var(--surface);
  }
  header .ws-status.connected { color: var(--green); }
  header .ws-status.disconnected { color: var(--red); }
  main { padding: 1.5rem 2rem; }
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 1rem;
    margin-bottom: 2rem;
  }
  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem;
  }
  .stat-card .label { font-size: 0.75rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-card .value { font-size: 1.5rem; font-weight: 700; margin-top: 0.25rem; }
  section { margin-bottom: 2rem; }
  section h2 { font-size: 1rem; font-weight: 600; margin-bottom: 0.75rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }
  table {
    width: 100%;
    border-collapse: collapse;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    font-size: 0.85rem;
  }
  th {
    text-align: left;
    padding: 0.5rem 0.75rem;
    background: var(--border);
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
  }
  td {
    padding: 0.5rem 0.75rem;
    border-top: 1px solid var(--border);
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  td.channels { white-space: normal; font-size: 0.75rem; color: var(--text-dim); }
  .badge {
    display: inline-block;
    padding: 0.125rem 0.5rem;
    border-radius: 4px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
  }
  .badge-apple-container { background: #1e3a5f; color: #60a5fa; }
  .badge-docker { background: #1e3a2f; color: #34d399; }
  .badge-admin { background: #3b1764; color: #c084fc; }
  .status-active { background: #14532d; color: var(--green); }
  .status-paused { background: #422006; color: var(--yellow); }
  .status-completed { background: #1e1e1e; color: var(--text-dim); }
  #log-container {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem;
    max-height: 400px;
    overflow-y: auto;
    font-family: 'SF Mono', 'Cascadia Code', monospace;
    font-size: 0.75rem;
    line-height: 1.6;
  }
  .log-line { color: var(--text-dim); }
  .log-line .ts { color: var(--text-dim); }
  .log-line.error { color: var(--red); }
  .log-line.warn { color: var(--yellow); }
</style>
</head>
<body>
<header>
  <h1>OmniClaw</h1>
  <span id="ws-status" class="ws-status disconnected">disconnected</span>
</header>
<main>
  <div class="stats-grid">
    <div class="stat-card"><div class="label">Agents</div><div class="value" id="stat-agents">${agents.length}</div></div>
    <div class="stat-card"><div class="label">Active Containers</div><div class="value" id="stat-active">${stats.activeContainers - stats.idleContainers}/${stats.maxActive}</div></div>
    <div class="stat-card"><div class="label">Idle Containers</div><div class="value" id="stat-idle">${stats.idleContainers}/${stats.maxIdle}</div></div>
    <div class="stat-card"><div class="label">Active Tasks</div><div class="value" id="stat-tasks">${tasks.filter((t) => t.status === 'active').length}</div></div>
  </div>

  <section>
    <h2>Agents</h2>
    <table>
      <thead><tr><th>ID</th><th>Name</th><th>Backend</th><th>Runtime</th><th>Role</th><th>Channels</th></tr></thead>
      <tbody id="agents-tbody">${agentRows}</tbody>
    </table>
  </section>

  <section>
    <h2>Scheduled Tasks</h2>
    <table>
      <thead><tr><th>ID</th><th>Agent</th><th>Status</th><th>Schedule</th><th>Prompt</th><th>Next Run</th><th>Last Run</th></tr></thead>
      <tbody id="tasks-tbody">${taskRows}</tbody>
    </table>
  </section>

  <section>
    <h2>Live Logs</h2>
    <div id="log-container"><div class="log-line">Waiting for WebSocket connection…</div></div>
  </section>
</main>

<script>
(function() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = proto + '//' + location.host + '/ws';
  const statusEl = document.getElementById('ws-status');
  const logContainer = document.getElementById('log-container');
  const MAX_LOG_LINES = 200;

  function connect() {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      statusEl.textContent = 'connected';
      statusEl.className = 'ws-status connected';
      logContainer.innerHTML = '';
      ws.send(JSON.stringify({ subscribe: ['logs', 'stats'] }));
    };
    ws.onclose = () => {
      statusEl.textContent = 'disconnected';
      statusEl.className = 'ws-status disconnected';
      setTimeout(connect, 3000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        if (evt.type === 'log') {
          const line = document.createElement('div');
          line.className = 'log-line' + (evt.data.level === 'error' ? ' error' : evt.data.level === 'warn' ? ' warn' : '');
          const ts = new Date(evt.data.ts).toLocaleTimeString();
          line.innerHTML = '<span class="ts">' + ts + '</span> ' + escapeHtml(evt.data.msg || '');
          logContainer.appendChild(line);
          while (logContainer.children.length > MAX_LOG_LINES) logContainer.removeChild(logContainer.firstChild);
          logContainer.scrollTop = logContainer.scrollHeight;
        }
        if (evt.type === 'stats') {
          const d = evt.data;
          const el = (id) => document.getElementById(id);
          if (d.activeContainers != null) el('stat-active').textContent = (d.activeContainers - d.idleContainers) + '/' + d.maxActive;
          if (d.idleContainers != null) el('stat-idle').textContent = d.idleContainers + '/' + d.maxIdle;
        }
      } catch {}
    };
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  connect();
})();
</script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
