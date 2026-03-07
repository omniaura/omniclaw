import type { WebStateProvider } from './types.js';
import { BASE_CSS, renderNav, escapeHtml } from './shared.js';

/**
 * Render a self-contained HTML dashboard page.
 * Uses inline CSS and vanilla JS — no build step, no external dependencies.
 * Data is bootstrapped server-side; live updates come via WebSocket.
 * Stats are polled every 10s for semi-live numbers.
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
  ${BASE_CSS}
  body { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  main { flex: 1; display: flex; flex-direction: column; padding: 0.75rem 1.5rem; gap: 0.75rem; overflow: hidden; }
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.5rem;
    flex-shrink: 0;
  }
  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
  }
  .stat-card .label { font-size: 0.65rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-card .value { font-size: 1.25rem; font-weight: 700; margin-top: 0.1rem; }
  .tables-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
    flex-shrink: 0;
    max-height: 40vh;
    overflow: hidden;
  }
  .table-section { display: flex; flex-direction: column; overflow: hidden; }
  .table-section h2 { font-size: 0.75rem; font-weight: 600; margin-bottom: 0.35rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }
  .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.35rem; }
  .section-header h2 { margin-bottom: 0; }
  .table-wrap { overflow: auto; flex: 1; border-radius: 6px; border: 1px solid var(--border); }
  table {
    width: 100%;
    border-collapse: collapse;
    background: var(--surface);
    font-size: 0.75rem;
  }
  th {
    text-align: left;
    padding: 0.35rem 0.5rem;
    background: var(--border);
    font-weight: 600;
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
    position: sticky;
    top: 0;
    z-index: 1;
  }
  td {
    padding: 0.3rem 0.5rem;
    border-top: 1px solid var(--border);
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  td.channels { white-space: normal; font-size: 0.65rem; color: var(--text-dim); }
  td.actions { white-space: nowrap; }
  .badge {
    display: inline-block;
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
    font-size: 0.6rem;
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
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    font-size: 0.7rem;
    font-weight: 500;
    transition: background 0.15s, border-color 0.15s;
  }
  .btn:hover { border-color: var(--accent); background: #1e2030; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn-primary:hover { background: #4f46e5; }
  .btn-sm { padding: 0.15rem 0.35rem; font-size: 0.6rem; }
  .btn-danger { color: var(--red); border-color: #5c1818; }
  .btn-danger:hover { background: #2a0f0f; border-color: var(--red); }
  .btn-toggle { color: var(--yellow); border-color: #5c4a08; }
  .btn-toggle:hover { background: #2a2208; border-color: var(--yellow); }
  .log-section { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .log-section h2 { font-size: 0.75rem; font-weight: 600; margin-bottom: 0.25rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; flex-shrink: 0; }
  .log-toolbar {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin-bottom: 0.35rem;
    flex-wrap: wrap;
    flex-shrink: 0;
  }
  .log-toolbar .filter-btn {
    padding: 0.15rem 0.4rem;
    font-size: 0.65rem;
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
  .log-toolbar .log-count { font-size: 0.65rem; color: var(--text-dim); }
  #log-container {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem;
    flex: 1;
    overflow-y: auto;
    font-family: 'SF Mono', 'Cascadia Code', monospace;
    font-size: 0.7rem;
    line-height: 1.5;
  }
  .log-line { color: var(--text-dim); display: flex; gap: 0.35rem; }
  .log-line .ts { color: var(--text-dim); flex-shrink: 0; }
  .log-line .level-badge { flex-shrink: 0; font-weight: 600; font-size: 0.6rem; text-transform: uppercase; padding: 0 0.2rem; border-radius: 2px; }
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
  @media (max-width: 900px) {
    .stats-grid { grid-template-columns: repeat(2, 1fr); }
    .tables-grid { grid-template-columns: 1fr; max-height: none; }
    main { overflow-y: auto; }
  }
  @media (max-width: 500px) {
    .stats-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
${renderNav('/')}
<main>
  <div class="stats-grid">
    <div class="stat-card"><div class="label">Agents</div><div class="value" id="stat-agents">${agents.length}</div></div>
    <div class="stat-card"><div class="label">Active Containers</div><div class="value" id="stat-active">${Math.max(0, stats.activeContainers - stats.idleContainers)}/${stats.maxActive}</div></div>
    <div class="stat-card"><div class="label">Idle Containers</div><div class="value" id="stat-idle">${stats.idleContainers}/${stats.maxIdle}</div></div>
    <div class="stat-card"><div class="label">Active Tasks</div><div class="value" id="stat-tasks">${tasks.filter((t) => t.status === 'active').length}</div></div>
  </div>

  <div class="tables-grid">
    <div class="table-section">
      <h2>Agents</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>Name</th><th>Backend</th><th>Runtime</th><th>Role</th><th>Channels</th></tr></thead>
          <tbody id="agents-tbody">${agentRows}</tbody>
        </table>
      </div>
    </div>

    <div class="table-section">
      <div class="section-header">
        <h2>Scheduled Tasks</h2>
        <button class="btn btn-primary btn-sm" id="btn-create-task">+ New</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>Agent</th><th>Status</th><th>Schedule</th><th>Prompt</th><th>Next Run</th><th>Last Run</th><th>Actions</th></tr></thead>
          <tbody id="tasks-tbody">${taskRows}</tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="log-section">
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
  </div>
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
  var sseUrl = '/api/events?channels=logs,stats';
  var statusEl = document.getElementById('ws-status');
  var logContainer = document.getElementById('log-container');
  var logCountEl = document.getElementById('log-count');
  var MAX_LOG_LINES = 500;
  var logCount = 0;
  var autoScroll = true;

  // Level filter state
  var levelFilters = { debug: true, info: true, warn: true, error: true, fatal: true };
  var ws = null;
  var sse = null;

  function setConnectedStatus(mode) {
    statusEl.textContent = mode === 'sse' ? 'connected (sse)' : 'connected';
    statusEl.className = 'ws-status connected';
  }

  function setDisconnectedStatus() {
    statusEl.textContent = 'disconnected';
    statusEl.className = 'ws-status disconnected';
  }

  function resetLogs() {
    logContainer.innerHTML = '';
    logCount = 0;
    logCountEl.textContent = '0 lines';
  }

  function appendLog(d) {
    var lvl = d.level || 'info';

    var line = document.createElement('div');
    line.className = 'log-line' + (lvl === 'error' || lvl === 'fatal' ? ' error' : lvl === 'warn' ? ' warn' : '');
    line.setAttribute('data-level', lvl);
    if (!levelFilters[lvl]) line.style.display = 'none';

    var ts = new Date(d.ts).toLocaleTimeString();
    var parts = '<span class="ts">' + ts + '</span>';
    parts += '<span class="level-badge ' + escapeHtmlJs(lvl) + '">' + escapeHtmlJs(lvl) + '</span>';

    var ctx = d.container || d.group;
    if (ctx) parts += '<span class="context">' + escapeHtmlJs(String(ctx)) + '</span>';
    if (d.op) parts += '<span class="op">[' + escapeHtmlJs(String(d.op)) + ']</span>';

    var msg = d.msg || '';
    if (d.durationMs != null) msg += ' (' + d.durationMs + 'ms)';
    if (d.costUsd != null) msg += ' $' + d.costUsd;
    parts += '<span class="msg">' + escapeHtmlJs(msg) + '</span>';
    if (d.err) parts += '<span class="err-detail">' + escapeHtmlJs(String(d.err)) + '</span>';

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

  function updateStats(s) {
    var el = function(id) { return document.getElementById(id); };
    if (s.activeContainers != null && s.idleContainers != null && s.maxActive != null) {
      el('stat-active').textContent = Math.max(0, s.activeContainers - s.idleContainers) + '/' + s.maxActive;
    }
    if (s.idleContainers != null && s.maxIdle != null) {
      el('stat-idle').textContent = s.idleContainers + '/' + s.maxIdle;
    }
  }

  function handleEvent(evt) {
    if (!evt || !evt.type) return;
    if (evt.type === 'log') appendLog(evt.data || {});
    if (evt.type === 'agent_status') updateStats(evt.data || {});
  }

  function connectSse() {
    if (sse) return;
    sse = new EventSource(sseUrl);
    sse.onopen = function() {
      setConnectedStatus('sse');
    };
    sse.onerror = function() {
      setDisconnectedStatus();
    };
    sse.addEventListener('log', function(e) {
      try { handleEvent(JSON.parse(e.data)); } catch (ex) {}
    });
    sse.addEventListener('agent_status', function(e) {
      try { handleEvent(JSON.parse(e.data)); } catch (ex) {}
    });
  }

  function disconnectSse() {
    if (!sse) return;
    sse.close();
    sse = null;
  }

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = function() {
      disconnectSse();
      setConnectedStatus('ws');
      resetLogs();
      ws.send(JSON.stringify({ subscribe: ['logs', 'stats'] }));
    };
    ws.onclose = function() {
      setDisconnectedStatus();
      connectSse();
      setTimeout(connect, 3000);
    };
    ws.onerror = function() { ws.close(); };
    ws.onmessage = function(e) {
      try {
        handleEvent(JSON.parse(e.data));
      } catch(ex) {}
    };
  }

  function escapeHtmlJs(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  connect();

  // ---- Stats polling (semi-live) ----
  setInterval(function() {
    fetch('/api/stats')
      .then(function(r) { return r.json(); })
      .then(function(s) {
        document.getElementById('stat-agents').textContent = String(s.agents || 0);
        document.getElementById('stat-active').textContent = Math.max(0, (s.activeContainers || 0) - (s.idleContainers || 0)) + '/' + (s.maxActive || 0);
        document.getElementById('stat-idle').textContent = (s.idleContainers || 0) + '/' + (s.maxIdle || 0);
        document.getElementById('stat-tasks').textContent = String(s.activeTasks || 0);
      })
      .catch(function() {});
  }, 10000);

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
