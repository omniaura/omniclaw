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
        <td><span class="badge ${a.backend === 'apple-container' ? 'badge-apple-container' : a.backend === 'docker' ? 'badge-docker' : ''}">${escapeHtml(a.backend)}</span></td>
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
      const nextRun = t.next_run ? new Date(t.next_run).toLocaleString() : '—';
      const lastRun = t.last_run ? new Date(t.last_run).toLocaleString() : '—';
      const toggleLabel = t.status === 'active' ? 'Pause' : 'Resume';
      const toggleStatus = t.status === 'active' ? 'paused' : 'active';
      return `<tr data-task-id="${escapeHtml(t.id)}">
        <td title="${escapeHtml(t.id)}">${escapeHtml(t.id.slice(0, 8))}…</td>
        <td>${escapeHtml(t.group_folder)}</td>
        <td><span class="badge ${statusClass}">${escapeHtml(t.status)}</span></td>
        <td>${escapeHtml(t.schedule_type)}: ${escapeHtml(t.schedule_value)}</td>
        <td title="${escapeHtml(t.prompt)}">${escapeHtml(t.prompt.slice(0, 80))}${t.prompt.length > 80 ? '…' : ''}</td>
        <td>${nextRun}</td>
        <td>${lastRun}</td>
        <td class="actions">
          <button class="btn btn-sm btn-toggle" data-action="toggle" data-status="${toggleStatus}" title="${toggleLabel}">${toggleLabel}</button>
          <button class="btn btn-sm btn-danger" data-action="delete" title="Delete">Delete</button>
        </td>
      </tr>`;
    })
    .join('\n');

  // Build agent options for the create-task form dropdown
  const agentOptions = agents
    .map((a) => {
      const jids = Object.entries(subs)
        .filter(([, s]) => s.some((sub) => sub.agentId === a.id))
        .map(([jid]) => jid);
      return jids.map(
        (jid) =>
          `<option value="${escapeHtml(a.folder)}|${escapeHtml(jid)}">${escapeHtml(a.name)} (${escapeHtml(jid)})</option>`,
      );
    })
    .flat()
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
  .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; }
  .section-header h2 { margin-bottom: 0; }
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
  td.actions { white-space: nowrap; }
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
  .btn {
    padding: 0.375rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    font-size: 0.75rem;
    font-weight: 500;
    transition: background 0.15s, border-color 0.15s;
  }
  .btn:hover { border-color: var(--accent); background: #1e2030; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn-primary:hover { background: #4f46e5; }
  .btn-sm { padding: 0.2rem 0.5rem; font-size: 0.7rem; }
  .btn-danger { color: var(--red); border-color: #5c1818; }
  .btn-danger:hover { background: #2a0f0f; border-color: var(--red); }
  .btn-toggle { color: var(--yellow); border-color: #5c4a08; }
  .btn-toggle:hover { background: #2a2208; border-color: var(--yellow); }
  .log-toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
    flex-wrap: wrap;
  }
  .log-toolbar .filter-btn {
    padding: 0.2rem 0.5rem;
    font-size: 0.7rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface);
    color: var(--text-dim);
    cursor: pointer;
    transition: all 0.15s;
  }
  .log-toolbar .filter-btn.active { border-color: var(--accent); color: var(--text); background: #1e2030; }
  .log-toolbar .filter-btn:hover { border-color: var(--accent); }
  .log-toolbar .spacer { flex: 1; }
  .log-toolbar .log-count { font-size: 0.7rem; color: var(--text-dim); }
  #log-container {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem;
    max-height: 500px;
    overflow-y: auto;
    font-family: 'SF Mono', 'Cascadia Code', monospace;
    font-size: 0.75rem;
    line-height: 1.6;
  }
  .log-line { color: var(--text-dim); display: flex; gap: 0.5rem; }
  .log-line .ts { color: var(--text-dim); flex-shrink: 0; }
  .log-line .level-badge { flex-shrink: 0; font-weight: 600; font-size: 0.65rem; text-transform: uppercase; padding: 0 0.25rem; border-radius: 2px; }
  .log-line .level-badge.info { color: var(--green); }
  .log-line .level-badge.debug { color: var(--text-dim); }
  .log-line .level-badge.warn { color: var(--yellow); }
  .log-line .level-badge.error { color: var(--red); }
  .log-line .level-badge.fatal { color: #fff; background: var(--red); }
  .log-line .context { color: #60a5fa; flex-shrink: 0; }
  .log-line .op { color: var(--accent); flex-shrink: 0; }
  .log-line .msg { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .log-line .err-detail { color: var(--red); }
  .log-line.error { color: var(--red); }
  .log-line.error .msg { color: var(--red); }
  .log-line.warn .msg { color: var(--yellow); }
  /* Modal */
  .modal-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 100;
    align-items: center;
    justify-content: center;
  }
  .modal-overlay.open { display: flex; }
  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1.5rem;
    width: 480px;
    max-width: 90vw;
    max-height: 90vh;
    overflow-y: auto;
  }
  .modal h3 { font-size: 1rem; font-weight: 600; margin-bottom: 1rem; }
  .form-group { margin-bottom: 0.75rem; }
  .form-group label {
    display: block;
    font-size: 0.75rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.25rem;
  }
  .form-group input,
  .form-group select,
  .form-group textarea {
    width: 100%;
    padding: 0.5rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: inherit;
    font-size: 0.85rem;
  }
  .form-group textarea { min-height: 80px; resize: vertical; }
  .form-group input:focus,
  .form-group select:focus,
  .form-group textarea:focus { outline: none; border-color: var(--accent); }
  .form-actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1rem; }
  .form-error { color: var(--red); font-size: 0.75rem; margin-top: 0.25rem; }
  .toast {
    position: fixed;
    bottom: 1.5rem;
    right: 1.5rem;
    padding: 0.75rem 1rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 0.8rem;
    z-index: 200;
    animation: fadeIn 0.2s;
  }
  .toast.success { border-color: var(--green); color: var(--green); }
  .toast.error { border-color: var(--red); color: var(--red); }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
</style>
</head>
<body>
<header>
  <h1>OmniClaw</h1>
  <nav style="display:flex;gap:0.5rem;margin-left:1rem">
    <a href="/" style="color:var(--accent);text-decoration:none;font-size:0.8rem;padding:0.25rem 0.5rem;border-radius:4px;background:var(--surface)">Dashboard</a>
    <a href="/conversations" style="color:var(--text-dim);text-decoration:none;font-size:0.8rem;padding:0.25rem 0.5rem;border-radius:4px" onmouseover="this.style.color='var(--text)';this.style.background='var(--surface)'" onmouseout="this.style.color='var(--text-dim)';this.style.background='transparent'">Conversations</a>
    <a href="/ipc" style="color:var(--text-dim);text-decoration:none;font-size:0.8rem;padding:0.25rem 0.5rem;border-radius:4px" onmouseover="this.style.color='var(--text)';this.style.background='var(--surface)'" onmouseout="this.style.color='var(--text-dim)';this.style.background='transparent'">IPC</a>
  </nav>
  <span id="ws-status" class="ws-status disconnected">disconnected</span>
</header>
<main>
  <div class="stats-grid">
    <div class="stat-card"><div class="label">Agents</div><div class="value" id="stat-agents">${agents.length}</div></div>
    <div class="stat-card"><div class="label">Active Containers</div><div class="value" id="stat-active">${Math.max(0, stats.activeContainers - stats.idleContainers)}/${stats.maxActive}</div></div>
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
    <div class="section-header">
      <h2>Scheduled Tasks</h2>
      <button class="btn btn-primary" id="btn-create-task">+ New Task</button>
    </div>
    <table>
      <thead><tr><th>ID</th><th>Agent</th><th>Status</th><th>Schedule</th><th>Prompt</th><th>Next Run</th><th>Last Run</th><th>Actions</th></tr></thead>
      <tbody id="tasks-tbody">${taskRows}</tbody>
    </table>
  </section>

  <section>
    <h2>Live Logs</h2>
    <div class="log-toolbar">
      <button class="filter-btn active" data-level="all">All</button>
      <button class="filter-btn active" data-level="debug">Debug</button>
      <button class="filter-btn active" data-level="info">Info</button>
      <button class="filter-btn active" data-level="warn">Warn</button>
      <button class="filter-btn active" data-level="error">Error</button>
      <div class="spacer"></div>
      <span class="log-count" id="log-count">0 lines</span>
      <button class="filter-btn active" id="btn-autoscroll">Auto-scroll</button>
      <button class="filter-btn" id="btn-clear-logs">Clear</button>
    </div>
    <div id="log-container"><div class="log-line"><span class="msg">Waiting for WebSocket connection…</span></div></div>
  </section>
</main>

<!-- Create Task Modal -->
<div class="modal-overlay" id="create-task-modal">
  <div class="modal">
    <h3>Create Scheduled Task</h3>
    <form id="create-task-form">
      <div class="form-group">
        <label for="ct-agent">Agent / Channel</label>
        <select id="ct-agent" required>
          <option value="">Select agent…</option>
          ${agentOptions}
        </select>
      </div>
      <div class="form-group">
        <label for="ct-prompt">Prompt</label>
        <textarea id="ct-prompt" placeholder="What should the agent do?" required></textarea>
      </div>
      <div class="form-group">
        <label for="ct-schedule-type">Schedule Type</label>
        <select id="ct-schedule-type" required>
          <option value="cron">Cron</option>
          <option value="interval">Interval (ms)</option>
          <option value="once">Once (ISO timestamp)</option>
        </select>
      </div>
      <div class="form-group">
        <label for="ct-schedule-value">Schedule Value</label>
        <input id="ct-schedule-value" type="text" placeholder="0 9 * * * (cron) | 3600000 (ms) | 2026-03-02T15:00:00" required>
      </div>
      <div class="form-group">
        <label for="ct-context-mode">Context Mode</label>
        <select id="ct-context-mode">
          <option value="isolated">Isolated (fresh session)</option>
          <option value="group">Group (with chat history)</option>
        </select>
      </div>
      <div id="ct-error" class="form-error"></div>
      <div class="form-actions">
        <button type="button" class="btn" id="ct-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="ct-submit">Create</button>
      </div>
    </form>
  </div>
</div>

<script>
(function() {
  // ---- WebSocket ----
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var wsUrl = proto + '//' + location.host + '/ws';
  var statusEl = document.getElementById('ws-status');
  var logContainer = document.getElementById('log-container');
  var logCountEl = document.getElementById('log-count');
  var MAX_LOG_LINES = 500;
  var logCount = 0;
  var autoScroll = true;

  // Level filter state
  var levelFilters = { debug: true, info: true, warn: true, error: true, fatal: true };

  function connect() {
    var ws = new WebSocket(wsUrl);
    ws.onopen = function() {
      statusEl.textContent = 'connected';
      statusEl.className = 'ws-status connected';
      logContainer.innerHTML = '';
      logCount = 0;
      logCountEl.textContent = '0 lines';
      ws.send(JSON.stringify({ subscribe: ['logs', 'stats'] }));
    };
    ws.onclose = function() {
      statusEl.textContent = 'disconnected';
      statusEl.className = 'ws-status disconnected';
      setTimeout(connect, 3000);
    };
    ws.onerror = function() { ws.close(); };
    ws.onmessage = function(e) {
      try {
        var evt = JSON.parse(e.data);
        if (evt.type === 'log') {
          var d = evt.data;
          var lvl = d.level || 'info';

          var line = document.createElement('div');
          line.className = 'log-line' + (lvl === 'error' || lvl === 'fatal' ? ' error' : lvl === 'warn' ? ' warn' : '');
          line.setAttribute('data-level', lvl);

          // Hide if level is filtered out
          if (!levelFilters[lvl]) line.style.display = 'none';

          var ts = new Date(d.ts).toLocaleTimeString();
          var parts = '<span class="ts">' + ts + '</span>';
          parts += '<span class="level-badge ' + escapeHtml(lvl) + '">' + escapeHtml(lvl) + '</span>';

          // Context: container/group name
          var ctx = d.container || d.group;
          if (ctx) parts += '<span class="context">' + escapeHtml(String(ctx)) + '</span>';

          // Operation tag
          if (d.op) parts += '<span class="op">[' + escapeHtml(String(d.op)) + ']</span>';

          // Message
          var msg = d.msg || '';
          if (d.durationMs != null) msg += ' (' + d.durationMs + 'ms)';
          if (d.costUsd != null) msg += ' $' + d.costUsd;
          parts += '<span class="msg">' + escapeHtml(msg) + '</span>';

          // Error detail
          if (d.err) parts += '<span class="err-detail">' + escapeHtml(String(d.err)) + '</span>';

          line.innerHTML = parts;
          logContainer.appendChild(line);
          logCount++;

          while (logContainer.children.length > MAX_LOG_LINES) {
            logContainer.removeChild(logContainer.firstChild);
            logCount = Math.max(0, logCount - 1);
          }
          logCountEl.textContent = logCount + ' lines';
          if (autoScroll) logContainer.scrollTop = logContainer.scrollHeight;
        }
        if (evt.type === 'agent_status') {
          var s = evt.data;
          var el = function(id) { return document.getElementById(id); };
          if (s.activeContainers != null && s.idleContainers != null && s.maxActive != null) {
            el('stat-active').textContent = Math.max(0, s.activeContainers - s.idleContainers) + '/' + s.maxActive;
          }
          if (s.idleContainers != null && s.maxIdle != null) {
            el('stat-idle').textContent = s.idleContainers + '/' + s.maxIdle;
          }
        }
      } catch(ex) {}
    };
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  connect();

  // ---- Log toolbar: level filters ----
  document.querySelectorAll('.log-toolbar .filter-btn[data-level]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var level = btn.getAttribute('data-level');
      if (level === 'all') {
        // Toggle all on/off
        var allActive = Object.keys(levelFilters).every(function(k) { return levelFilters[k]; });
        var newState = !allActive;
        Object.keys(levelFilters).forEach(function(k) { levelFilters[k] = newState; });
        document.querySelectorAll('.log-toolbar .filter-btn[data-level]').forEach(function(b) {
          if (newState) b.classList.add('active'); else b.classList.remove('active');
        });
      } else {
        levelFilters[level] = !levelFilters[level];
        if (levelFilters[level]) btn.classList.add('active'); else btn.classList.remove('active');
        // Update "All" button state
        var allBtn = document.querySelector('.filter-btn[data-level="all"]');
        var allOn = Object.keys(levelFilters).every(function(k) { return levelFilters[k]; });
        if (allOn) allBtn.classList.add('active'); else allBtn.classList.remove('active');
      }
      // Apply filter to existing lines
      logContainer.querySelectorAll('.log-line[data-level]').forEach(function(line) {
        var lvl = line.getAttribute('data-level');
        line.style.display = levelFilters[lvl] ? '' : 'none';
      });
    });
  });

  // ---- Auto-scroll toggle ----
  document.getElementById('btn-autoscroll').addEventListener('click', function() {
    autoScroll = !autoScroll;
    this.classList.toggle('active', autoScroll);
  });

  // ---- Clear logs ----
  document.getElementById('btn-clear-logs').addEventListener('click', function() {
    logContainer.innerHTML = '';
    logCount = 0;
    logCountEl.textContent = '0 lines';
  });

  // ---- Toast notifications ----
  function showToast(message, type) {
    var existing = document.querySelector('.toast');
    if (existing) existing.remove();
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'success');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function() { el.remove(); }, 3000);
  }

  // ---- Task actions (pause/resume/delete) ----
  var tasksTable = document.getElementById('tasks-tbody');
  tasksTable.addEventListener('click', function(e) {
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    var row = btn.closest('tr');
    var taskId = row.getAttribute('data-task-id');
    var action = btn.getAttribute('data-action');

    if (action === 'toggle') {
      var newStatus = btn.getAttribute('data-status');
      btn.disabled = true;
      fetch('/api/tasks/' + encodeURIComponent(taskId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      }).then(function(res) {
        if (!res.ok) return res.json().then(function(d) { throw new Error(d.error); });
        return res.json();
      }).then(function(task) {
        showToast('Task ' + (newStatus === 'paused' ? 'paused' : 'resumed'));
        location.reload();
      }).catch(function(err) {
        showToast(err.message || 'Failed', 'error');
        btn.disabled = false;
      });
    }

    if (action === 'delete') {
      if (!confirm('Delete this task? This cannot be undone.')) return;
      btn.disabled = true;
      fetch('/api/tasks/' + encodeURIComponent(taskId), {
        method: 'DELETE'
      }).then(function(res) {
        if (!res.ok) return res.json().then(function(d) { throw new Error(d.error); });
        return res.json();
      }).then(function() {
        showToast('Task deleted');
        row.remove();
      }).catch(function(err) {
        showToast(err.message || 'Failed', 'error');
        btn.disabled = false;
      });
    }
  });

  // ---- Create task modal ----
  var modal = document.getElementById('create-task-modal');
  var form = document.getElementById('create-task-form');
  var errorEl = document.getElementById('ct-error');

  document.getElementById('btn-create-task').addEventListener('click', function() {
    modal.classList.add('open');
    errorEl.textContent = '';
  });
  document.getElementById('ct-cancel').addEventListener('click', function() {
    modal.classList.remove('open');
  });
  modal.addEventListener('click', function(e) {
    if (e.target === modal) modal.classList.remove('open');
  });

  form.addEventListener('submit', function(e) {
    e.preventDefault();
    errorEl.textContent = '';
    var submitBtn = document.getElementById('ct-submit');
    submitBtn.disabled = true;

    var agentVal = document.getElementById('ct-agent').value;
    if (!agentVal) { errorEl.textContent = 'Select an agent'; submitBtn.disabled = false; return; }
    var parts = agentVal.split('|');
    var groupFolder = parts[0];
    var chatJid = parts[1];

    var payload = {
      group_folder: groupFolder,
      chat_jid: chatJid,
      prompt: document.getElementById('ct-prompt').value,
      schedule_type: document.getElementById('ct-schedule-type').value,
      schedule_value: document.getElementById('ct-schedule-value').value,
      context_mode: document.getElementById('ct-context-mode').value
    };

    fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function(res) {
      if (!res.ok) return res.json().then(function(d) { throw new Error(d.error); });
      return res.json();
    }).then(function(task) {
      showToast('Task created: ' + task.id.slice(0, 12));
      modal.classList.remove('open');
      form.reset();
      location.reload();
    }).catch(function(err) {
      errorEl.textContent = err.message || 'Failed to create task';
      submitBtn.disabled = false;
    });
  });
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
