import type { WebStateProvider } from './types.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the IPC Inspector page.
 * Shows per-group queue state and recent IPC event timeline.
 */
export function renderIpcInspector(state: WebStateProvider): string {
  const stats = state.getQueueStats();
  const queueDetails = state.getQueueDetails();
  const events = state.getIpcEvents(50);

  // Build group rows
  const groupRows = queueDetails
    .map((g) => {
      const msgStatus = g.messageLane.idle
        ? 'idle'
        : g.messageLane.active
          ? 'active'
          : 'off';
      const taskStatus = g.taskLane.active ? 'active' : 'off';
      const taskInfo = g.taskLane.activeTask
        ? `${escapeHtml(g.taskLane.activeTask.taskId)} (${formatDuration(g.taskLane.activeTask.runningMs)})`
        : '—';
      return `<tr>
        <td class="folder-key">${escapeHtml(g.folderKey)}</td>
        <td><span class="lane-badge lane-${msgStatus}">${msgStatus}</span></td>
        <td>${g.messageLane.pendingCount}</td>
        <td><span class="lane-badge lane-${taskStatus}">${taskStatus}</span></td>
        <td>${g.taskLane.pendingCount}</td>
        <td class="task-info">${taskInfo}</td>
        <td>${g.retryCount > 0 ? `<span class="retry-count">${g.retryCount}</span>` : '—'}</td>
      </tr>`;
    })
    .join('\n');

  // Build event rows
  const eventRows = events
    .map((e) => {
      const kindClass =
        e.kind.includes('error') || e.kind.includes('blocked')
          ? 'event-error'
          : e.kind.includes('suppressed')
            ? 'event-warn'
            : 'event-ok';
      const time = new Date(e.timestamp).toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      return `<tr class="${kindClass}">
        <td class="event-time">${time}</td>
        <td><span class="event-kind-badge">${escapeHtml(e.kind)}</span></td>
        <td class="event-source">${escapeHtml(e.sourceGroup)}</td>
        <td class="event-summary">${escapeHtml(e.summary)}</td>
      </tr>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OmniClaw — IPC Inspector</title>
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
    --blue: #60a5fa;
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
  header nav { display: flex; gap: 0.5rem; margin-left: 1rem; }
  header nav a {
    color: var(--text-dim);
    text-decoration: none;
    font-size: 0.8rem;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    transition: all 0.15s;
  }
  header nav a:hover { color: var(--text); background: var(--surface); }
  header nav a.active { color: var(--accent); background: var(--surface); }
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

  /* Stats grid */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
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

  /* Sections */
  section { margin-bottom: 2rem; }
  section h2 { font-size: 1rem; font-weight: 600; margin-bottom: 0.75rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }

  /* Tables */
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
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
    border-bottom: 1px solid var(--border);
    background: var(--bg);
  }
  td {
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  tr:last-child td { border-bottom: none; }

  /* Lane badges */
  .lane-badge {
    display: inline-block;
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    text-transform: uppercase;
  }
  .lane-active { color: var(--green); background: rgba(34,197,94,0.12); }
  .lane-idle { color: var(--yellow); background: rgba(234,179,8,0.12); }
  .lane-off { color: var(--text-dim); background: rgba(139,143,163,0.08); }

  .folder-key { font-family: 'SF Mono', 'Cascadia Code', monospace; font-size: 0.8rem; }
  .task-info { font-family: 'SF Mono', 'Cascadia Code', monospace; font-size: 0.75rem; color: var(--text-dim); max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .retry-count { color: var(--yellow); font-weight: 600; }

  /* Event timeline */
  .event-time { font-family: 'SF Mono', 'Cascadia Code', monospace; font-size: 0.75rem; color: var(--text-dim); white-space: nowrap; }
  .event-source { font-family: 'SF Mono', 'Cascadia Code', monospace; font-size: 0.75rem; color: var(--blue); }
  .event-summary { font-size: 0.8rem; max-width: 500px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .event-kind-badge {
    display: inline-block;
    font-size: 0.65rem;
    font-weight: 600;
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
    white-space: nowrap;
  }
  tr.event-ok .event-kind-badge { color: var(--green); background: rgba(34,197,94,0.12); }
  tr.event-warn .event-kind-badge { color: var(--yellow); background: rgba(234,179,8,0.12); }
  tr.event-error .event-kind-badge { color: var(--red); background: rgba(239,68,68,0.12); }
  tr.event-error td { color: var(--red); }
  tr.event-warn td.event-summary { color: var(--yellow); }

  .empty-state {
    padding: 2rem;
    text-align: center;
    color: var(--text-dim);
    font-size: 0.85rem;
  }
</style>
</head>
<body>
<header>
  <h1>OmniClaw</h1>
  <nav>
    <a href="/">Dashboard</a>
    <a href="/conversations">Conversations</a>
    <a href="/ipc" class="active">IPC</a>
  </nav>
  <span id="ws-status" class="ws-status disconnected">disconnected</span>
</header>
<main>
  <div class="stats-grid">
    <div class="stat-card"><div class="label">Processing</div><div class="value" id="stat-processing">${Math.max(0, stats.activeContainers - stats.idleContainers)}/${stats.maxActive}</div></div>
    <div class="stat-card"><div class="label">Idle</div><div class="value" id="stat-idle">${stats.idleContainers}/${stats.maxIdle}</div></div>
    <div class="stat-card"><div class="label">Groups Tracked</div><div class="value" id="stat-groups">${queueDetails.length}</div></div>
    <div class="stat-card"><div class="label">Recent Events</div><div class="value" id="stat-events">${events.length}</div></div>
  </div>

  <section>
    <h2>Group Queue State</h2>
    ${
      queueDetails.length > 0
        ? `<table id="queue-table">
      <thead><tr>
        <th>Group</th>
        <th>Messages</th>
        <th>Msg Queue</th>
        <th>Tasks</th>
        <th>Task Queue</th>
        <th>Running Task</th>
        <th>Retries</th>
      </tr></thead>
      <tbody id="queue-body">${groupRows}</tbody>
    </table>`
        : '<div class="empty-state">No groups currently tracked in the queue.</div>'
    }
  </section>

  <section>
    <h2>IPC Event Timeline</h2>
    ${
      events.length > 0
        ? `<table id="events-table">
      <thead><tr>
        <th>Time</th>
        <th>Kind</th>
        <th>Source</th>
        <th>Summary</th>
      </tr></thead>
      <tbody id="events-body">${eventRows}</tbody>
    </table>`
        : '<div class="empty-state">No IPC events recorded yet. Events will appear here as the orchestrator processes IPC messages and tasks.</div>'
    }
  </section>
</main>

<script>
(function() {
  const wsStatus = document.getElementById('ws-status');
  let ws;
  let reconnectTimer;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');

    ws.onopen = function() {
      wsStatus.textContent = 'connected';
      wsStatus.className = 'ws-status connected';
      ws.send(JSON.stringify({ subscribe: ['stats', 'ipc_event'] }));
    };

    ws.onclose = function() {
      wsStatus.textContent = 'disconnected';
      wsStatus.className = 'ws-status disconnected';
      reconnectTimer = setTimeout(connect, 3000);
    };

    ws.onerror = function() {
      ws.close();
    };

    ws.onmessage = function(evt) {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'stats' && msg.data) {
          const s = msg.data;
          const processing = Math.max(0, (s.activeContainers || 0) - (s.idleContainers || 0));
          document.getElementById('stat-processing').textContent = processing + '/' + (s.maxActive || 0);
          document.getElementById('stat-idle').textContent = (s.idleContainers || 0) + '/' + (s.maxIdle || 0);
        }
        if (msg.type === 'ipc_event' && msg.data) {
          addEventRow(msg.data);
        }
      } catch(e) { /* ignore parse errors */ }
    };
  }

  function addEventRow(e) {
    const tbody = document.getElementById('events-body');
    if (!tbody) {
      // Table might not exist yet (was empty-state), reload
      location.reload();
      return;
    }
    const kindClass = (e.kind || '').includes('error') || (e.kind || '').includes('blocked')
      ? 'event-error'
      : (e.kind || '').includes('suppressed')
        ? 'event-warn'
        : 'event-ok';
    const time = new Date(e.timestamp).toLocaleTimeString('en-US', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const tr = document.createElement('tr');
    tr.className = kindClass;
    tr.innerHTML =
      '<td class="event-time">' + esc(time) + '</td>' +
      '<td><span class="event-kind-badge">' + esc(e.kind || '') + '</span></td>' +
      '<td class="event-source">' + esc(e.sourceGroup || '') + '</td>' +
      '<td class="event-summary">' + esc(e.summary || '') + '</td>';
    tbody.insertBefore(tr, tbody.firstChild);

    // Cap at 100 rows in the DOM
    while (tbody.children.length > 100) {
      tbody.removeChild(tbody.lastChild);
    }

    // Update event count
    const evCount = document.getElementById('stat-events');
    if (evCount) evCount.textContent = String(tbody.children.length);
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // Auto-refresh queue table every 5 seconds
  setInterval(function() {
    fetch('/api/ipc/queue')
      .then(function(r) { return r.json(); })
      .then(function(details) {
        const tbody = document.getElementById('queue-body');
        if (!tbody) return;
        document.getElementById('stat-groups').textContent = String(details.length);
        if (details.length === 0) {
          tbody.innerHTML = '';
          return;
        }
        tbody.innerHTML = details.map(function(g) {
          const msgStatus = g.messageLane.idle ? 'idle' : g.messageLane.active ? 'active' : 'off';
          const taskStatus = g.taskLane.active ? 'active' : 'off';
          const taskInfo = g.taskLane.activeTask
            ? esc(g.taskLane.activeTask.taskId) + ' (' + formatMs(g.taskLane.activeTask.runningMs) + ')'
            : '\\u2014';
          return '<tr>' +
            '<td class="folder-key">' + esc(g.folderKey) + '</td>' +
            '<td><span class="lane-badge lane-' + msgStatus + '">' + msgStatus + '</span></td>' +
            '<td>' + g.messageLane.pendingCount + '</td>' +
            '<td><span class="lane-badge lane-' + taskStatus + '">' + taskStatus + '</span></td>' +
            '<td>' + g.taskLane.pendingCount + '</td>' +
            '<td class="task-info">' + taskInfo + '</td>' +
            '<td>' + (g.retryCount > 0 ? '<span class="retry-count">' + g.retryCount + '</span>' : '\\u2014') + '</td>' +
            '</tr>';
        }).join('');
      })
      .catch(function() { /* ignore */ });
  }, 5000);

  function formatMs(ms) {
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return (ms / 60000).toFixed(1) + 'm';
  }

  connect();
})();
</script>
</body>
</html>`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
