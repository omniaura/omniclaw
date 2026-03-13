/**
 * SPA shell: persistent layout with live-log sidebar and Datastar SSE navigation.
 * All pages render inside this shell; navigating between them patches #content
 * via SSE without losing the log stream or sidebar state.
 */

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', page: 'dashboard' },
  { href: '/conversations', label: 'Conversations', page: 'conversations' },
  { href: '/context', label: 'Context', page: 'context' },
  { href: '/ipc', label: 'IPC', page: 'ipc' },
  { href: '/network', label: 'Network', page: 'network' },
  { href: '/system', label: 'System', page: 'system' },
];

export function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render just the nav link elements (used for SSE patching of active state). */
export function renderNavLinks(activePath: string): string {
  return NAV_ITEMS.map(
    (item) =>
      `<a href="${item.href}" data-nav data-page="${item.page}" ` +
      `class="nav-link${item.href === activePath ? ' active' : ''}">${item.label}</a>`,
  ).join('');
}

/** Render the full header bar. */
export function renderNav(
  activePath: string,
  _options?: { wsStatus?: boolean },
): string {
  return (
    `<header>` +
    `<div class="brand">omniclaw</div>` +
    `<nav id="nav-links">${renderNavLinks(activePath)}</nav>` +
    `<div class="header-right">` +
    `<span id="ws-status" class="status-badge disconnected">disconnected</span>` +
    `</div>` +
    `</header>`
  );
}

/**
 * Render the complete SPA shell wrapping the given page content.
 * @param activePath  Current route (e.g. '/', '/conversations')
 * @param title       Page title suffix
 * @param contentHtml Inner HTML for #content
 * @param pageScripts Map of page name -> init script string (all embedded in the shell)
 */
export function renderShell(
  activePath: string,
  title: string,
  contentHtml: string,
  pageScripts: Record<string, string>,
): string {
  return (
    `<!DOCTYPE html><html lang="en"><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>OmniClaw${title ? ' \u2014 ' + escapeHtml(title) : ''}</title>` +
    `<link rel="preconnect" href="https://fonts.googleapis.com">` +
    `<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">` +
    `<style>${shellCSS()}</style>` +
    `<script type="module" src="https://cdn.jsdelivr.net/gh/starfederation/datastar@1.0.0-RC.8/bundles/datastar.js"></scr` +
    `ipt>` +
    `</head><body>` +
    // Persistent SSE connector (outside #content so it survives navigation)
    `<div id="sse-init" style="display:none" data-init="@get('/api/events?channels=logs,stats,agents,tasks')"></div>` +
    renderNav(activePath) +
    `<div class="workspace" id="workspace">` +
    `<main id="content">${contentHtml}</main>` +
    `<div class="resize-handle" id="resize-handle"><div class="resize-grip"></div></div>` +
    `<aside class="log-sidebar" id="log-sidebar">` +
    `<div class="sidebar-head">` +
    `<div class="sidebar-tabs">` +
    `<button class="sidebar-tab active" data-sidebar-tab="logs">logs</button>` +
    `<button class="sidebar-tab" data-sidebar-tab="tasks">tasks</button>` +
    `</div>` +
    `<div class="sidebar-actions">` +
    `<button id="btn-toggle-side" class="icon-btn" title="Move to other side">\u21c4</button>` +
    `<button id="btn-collapse" class="icon-btn" title="Toggle sidebar">\u2715</button>` +
    `</div></div>` +
    // Logs panel
    `<div class="sidebar-panel active" id="panel-logs">` +
    `<div class="log-toolbar" id="log-toolbar">` +
    `<button class="filter-btn active" data-level="all">all</button>` +
    `<button class="filter-btn active" data-level="debug">dbg</button>` +
    `<button class="filter-btn active" data-level="info">info</button>` +
    `<button class="filter-btn active" data-level="warn">warn</button>` +
    `<button class="filter-btn active" data-level="error">err</button>` +
    `<span class="spacer"></span>` +
    `<span class="log-count" id="log-count">0</span>` +
    `<button class="filter-btn active" id="btn-autoscroll" title="Auto-scroll">\u2193</button>` +
    `<button class="filter-btn" id="btn-clear-logs" title="Clear">clr</button>` +
    `</div>` +
    `<div id="log-container" class="log-stream"></div>` +
    `</div>` +
    // Tasks panel
    `<div class="sidebar-panel" id="panel-tasks">` +
    `<div class="tasks-toolbar">` +
    `<button class="btn btn-primary btn-sm" id="btn-create-task">+ new task</button>` +
    `</div>` +
    `<div class="task-list" id="sidebar-tasks"></div>` +
    `</div>` +
    `</aside>` +
    `</div>` +
    `<button class="sidebar-reopen" id="btn-reopen-sidebar" title="Show logs">\u2261 logs</button>` +
    `<scr` +
    `ipt>${shellScript(pageScripts)}</scr` +
    `ipt>` +
    `</body></html>`
  );
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

function shellCSS(): string {
  return [
    // --- Variables & Reset ---
    `:root{`,
    `--bg:#0c0f16;--surface:#141821;--surface-2:#1c2030;`,
    `--border:#232839;--border-bright:#2e3450;`,
    `--text:#cdd2dc;--text-dim:#636a7e;--text-bright:#ebeef5;`,
    `--accent:#818cf8;--accent-hover:#a5b4fc;--accent-dim:rgba(129,140,248,.12);`,
    `--green:#34d399;--yellow:#fbbf24;--red:#f87171;--blue:#60a5fa;--cyan:#22d3ee;`,
    `--mono:'JetBrains Mono','SF Mono','Cascadia Code','Fira Code','Menlo',monospace;`,
    `--sidebar-w:380px}`,
    `*{margin:0;padding:0;box-sizing:border-box}`,
    `html,body{height:100%;overflow:hidden}`,
    `body{font-family:var(--mono);background:var(--bg);color:var(--text);font-size:13px;line-height:1.5}`,
    `::selection{background:var(--accent-dim);color:var(--text-bright)}`,
    `::-webkit-scrollbar{width:6px;height:6px}`,
    `::-webkit-scrollbar-track{background:transparent}`,
    `::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}`,
    `::-webkit-scrollbar-thumb:hover{background:var(--border-bright)}`,

    // --- Header ---
    `header{display:flex;align-items:center;gap:.75rem;padding:0 1rem;height:40px;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--surface)}`,
    `.brand{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:lowercase;color:var(--accent);opacity:.8}`,
    `nav{display:flex;gap:2px;margin-left:.5rem}`,
    `.nav-link{color:var(--text-dim);text-decoration:none;font-size:11px;font-weight:500;padding:4px 10px;border-radius:4px;transition:all .12s;letter-spacing:.02em}`,
    `.nav-link:hover{color:var(--text);background:var(--surface-2)}`,
    `.nav-link.active{color:var(--accent);background:var(--accent-dim)}`,
    `.header-right{margin-left:auto;display:flex;align-items:center;gap:.5rem}`,
    `.status-badge{font-size:10px;padding:2px 8px;border-radius:3px;font-weight:500;letter-spacing:.03em}`,
    `.status-badge.connected{color:var(--green);background:rgba(52,211,153,.1)}`,
    `.status-badge.disconnected{color:var(--red);background:rgba(248,113,113,.1)}`,

    // --- Workspace (sidebar + content grid) ---
    `.workspace{display:grid;grid-template-columns:1fr 5px var(--sidebar-w);grid-template-rows:1fr;grid-template-areas:"content handle sidebar";flex:1;min-height:0;overflow:hidden;height:calc(100vh - 40px)}`,
    `.workspace.sidebar-left{grid-template-columns:var(--sidebar-w) 5px 1fr;grid-template-areas:"sidebar handle content"}`,
    `.workspace.sidebar-collapsed{grid-template-columns:1fr 0 0}`,
    `.workspace.sidebar-collapsed .log-sidebar,.workspace.sidebar-collapsed .resize-handle{display:none}`,
    `.sidebar-reopen{display:none;position:fixed;top:50px;right:0;background:var(--surface);border:1px solid var(--border);border-right:none;border-radius:4px 0 0 4px;padding:6px 10px;font-family:var(--mono);font-size:10px;color:var(--text-dim);cursor:pointer;z-index:50;transition:all .15s;letter-spacing:.03em;writing-mode:horizontal-tb}`,
    `.sidebar-reopen:hover{color:var(--accent);border-color:var(--accent);background:var(--accent-dim)}`,
    `.workspace.sidebar-collapsed~.sidebar-reopen{display:block}`,
    `.workspace.sidebar-left.sidebar-collapsed~.sidebar-reopen{right:auto;left:0;border-radius:0 4px 4px 0;border-right:1px solid var(--border);border-left:none}`,
    `#content{grid-area:content;overflow:hidden;min-width:0;min-height:0;display:flex;flex-direction:column}`,
    `#content>div{display:flex;flex-direction:column;flex:1;min-height:0}`,

    // --- Resize Handle ---
    `.resize-handle{grid-area:handle;cursor:col-resize;display:flex;align-items:center;justify-content:center;background:var(--border);transition:background .15s;position:relative;z-index:5}`,
    `.resize-handle:hover,.resize-handle.dragging{background:var(--accent)}`,
    `.resize-grip{width:2px;height:24px;border-radius:1px;background:var(--text-dim);opacity:.3}`,
    `.resize-handle:hover .resize-grip{opacity:.6;background:var(--accent)}`,

    // --- Log Sidebar ---
    `.log-sidebar{grid-area:sidebar;display:flex;flex-direction:column;background:var(--bg);border-left:1px solid var(--border);min-width:0;overflow:hidden}`,
    `.workspace.sidebar-left .log-sidebar{border-left:none;border-right:1px solid var(--border)}`,
    `.sidebar-head{display:flex;align-items:center;justify-content:space-between;padding:0 4px 0 0;height:32px;flex-shrink:0;border-bottom:1px solid var(--border);background:var(--surface)}`,
    `.sidebar-tabs{display:flex;gap:0;height:100%}`,
    `.sidebar-tab{font-family:var(--mono);font-size:10px;font-weight:600;text-transform:lowercase;letter-spacing:.06em;color:var(--text-dim);background:none;border:none;border-bottom:2px solid transparent;padding:0 12px;cursor:pointer;transition:all .12s}`,
    `.sidebar-tab:hover{color:var(--text)}`,
    `.sidebar-tab.active{color:var(--accent);border-bottom-color:var(--accent)}`,
    `.sidebar-panel{display:none;flex-direction:column;flex:1;min-height:0;overflow:hidden}`,
    `.sidebar-panel.active{display:flex}`,
    `.tasks-toolbar{display:flex;align-items:center;padding:6px 8px;border-bottom:1px solid var(--border);flex-shrink:0}`,
    `.sidebar-actions{display:flex;gap:2px}`,
    `.icon-btn{background:none;border:1px solid transparent;color:var(--text-dim);cursor:pointer;font-size:12px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:3px;transition:all .12s}`,
    `.icon-btn:hover{color:var(--text);background:var(--surface-2);border-color:var(--border)}`,

    // --- Log Toolbar ---
    `.log-toolbar{display:flex;align-items:center;gap:3px;padding:4px 8px;flex-shrink:0;border-bottom:1px solid var(--border);background:var(--surface);flex-wrap:wrap}`,
    `.filter-btn{font-family:var(--mono);font-size:10px;padding:2px 6px;border:1px solid var(--border);border-radius:3px;background:transparent;color:var(--text-dim);cursor:pointer;transition:all .12s;font-weight:500;letter-spacing:.02em}`,
    `.filter-btn:hover{border-color:var(--border-bright);color:var(--text)}`,
    `.filter-btn.active{border-color:var(--accent);color:var(--accent);background:var(--accent-dim)}`,
    `.spacer{flex:1}`,
    `.log-count{font-size:10px;color:var(--text-dim);font-variant-numeric:tabular-nums}`,

    // --- Log Stream ---
    `.log-stream{flex:1;overflow-y:auto;padding:4px 0;font-size:11px;line-height:1.6}`,
    `.log-line{display:flex;gap:6px;padding:0 8px;min-height:20px;align-items:baseline;transition:background .08s}`,
    `.log-line:hover{background:var(--surface)}`,
    `.log-line .ts{color:var(--text-dim);flex-shrink:0;font-size:10px;opacity:.6}`,
    `.log-line .level-badge{flex-shrink:0;font-weight:600;font-size:9px;text-transform:uppercase;letter-spacing:.04em;padding:0 4px;border-radius:2px;min-width:28px;text-align:center}`,
    `.log-line .level-badge.info{color:var(--green)}`,
    `.log-line .level-badge.debug{color:var(--text-dim)}`,
    `.log-line .level-badge.warn{color:var(--yellow)}`,
    `.log-line .level-badge.error{color:var(--red)}`,
    `.log-line .level-badge.fatal{color:#fff;background:var(--red)}`,
    `.log-line .context{color:var(--blue);flex-shrink:0;font-size:11px}`,
    `.log-line .op{color:var(--accent);flex-shrink:0;font-size:11px}`,
    `.log-line .msg{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}`,
    `.log-line .err-detail{color:var(--red)}`,
    `.log-line.error .msg{color:var(--red)}`,
    `.log-line.warn .msg{color:var(--yellow)}`,

    // --- Common components ---
    `.badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.03em}`,
    `.badge-apple-container{background:rgba(96,165,250,.1);color:var(--blue)}`,
    `.badge-docker{background:rgba(52,211,153,.1);color:var(--green)}`,
    `.badge-sm{font-size:9px;padding:0 5px}`,
    `.badge-admin{background:rgba(167,139,250,.1);color:#a78bfa}`,
    `.status-active{background:rgba(52,211,153,.1);color:var(--green)}`,
    `.status-paused{background:rgba(251,191,36,.1);color:var(--yellow)}`,
    `.status-completed{background:rgba(99,106,126,.1);color:var(--text-dim)}`,
    `.btn{font-family:var(--mono);padding:5px 12px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);cursor:pointer;font-size:11px;font-weight:500;transition:all .12s}`,
    `.btn:hover{border-color:var(--accent);background:var(--surface-2)}`,
    `.btn:disabled{opacity:.4;cursor:not-allowed}`,
    `.btn-primary{background:var(--accent);border-color:var(--accent);color:#fff}`,
    `.btn-primary:hover{background:var(--accent-hover)}`,
    `.btn-sm{padding:3px 8px;font-size:10px}`,
    `.btn-danger{color:var(--red);border-color:rgba(248,113,113,.3)}`,
    `.btn-danger:hover{background:rgba(248,113,113,.08);border-color:var(--red)}`,
    `.btn-toggle{color:var(--yellow);border-color:rgba(251,191,36,.3)}`,
    `.btn-toggle:hover{background:rgba(251,191,36,.08);border-color:var(--yellow)}`,

    // --- Stat cards ---
    `.stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}`,
    `.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:10px 14px}`,
    `.stat-card .label{font-size:10px;color:var(--text-dim);text-transform:lowercase;letter-spacing:.06em;font-weight:500}`,
    `.stat-card .value{font-size:20px;font-weight:700;margin-top:2px;font-variant-numeric:tabular-nums}`,

    // --- Tables ---
    `table{width:100%;border-collapse:collapse;background:var(--surface);font-size:12px}`,
    `th{text-align:left;padding:6px 10px;background:var(--bg);font-weight:600;font-size:10px;text-transform:lowercase;letter-spacing:.05em;color:var(--text-dim);position:sticky;top:0;z-index:1;border-bottom:1px solid var(--border)}`,
    `td{padding:5px 10px;border-top:1px solid var(--border);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
    `td.channels{white-space:normal;font-size:10px;color:var(--text-dim)}`,
    `td.actions{white-space:nowrap}`,

    // --- Toast ---
    `.toast{position:fixed;bottom:1rem;right:1rem;padding:8px 14px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:12px;z-index:200;animation:fadeIn .2s}`,
    `.toast.success{border-color:var(--green);color:var(--green)}`,
    `.toast.error{border-color:var(--red);color:var(--red)}`,
    `@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}`,

    // --- Modal ---
    `.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;align-items:center;justify-content:center}`,
    `.modal-overlay.open{display:flex}`,
    `.modal{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1.25rem;width:440px;max-width:90vw;max-height:90vh;overflow-y:auto}`,
    `.modal h3{font-size:14px;font-weight:600;margin-bottom:.75rem}`,
    `.form-group{margin-bottom:.6rem}`,
    `.form-group label{display:block;font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}`,
    `.form-group input,.form-group select,.form-group textarea{width:100%;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:var(--mono);font-size:12px}`,
    `.form-group textarea{min-height:64px;resize:vertical}`,
    `.form-group input:focus,.form-group select:focus,.form-group textarea:focus{outline:none;border-color:var(--accent)}`,
    `.form-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:.75rem}`,
    `.form-error{color:var(--red);font-size:11px;margin-top:4px}`,

    // --- Page: Dashboard ---
    `.dash-layout{display:flex;flex:1;min-height:0;overflow:hidden}`,
    `.dash-main{flex:1;display:flex;flex-direction:column;gap:8px;padding:12px 16px;min-width:0;min-height:0;overflow:hidden}`,
    `.dash-main .stats-grid{flex-shrink:0}`,
    `.task-list{flex:1;overflow-y:auto;padding:4px}`,
    `.task-card{padding:8px 10px;border:1px solid var(--border);border-radius:4px;margin-bottom:4px;font-size:11px;background:var(--bg);transition:border-color .12s}`,
    `.task-card:hover{border-color:var(--border-bright)}`,
    `.task-top{display:flex;align-items:center;gap:5px;margin-bottom:3px}`,
    `.task-agent{font-weight:600;font-size:10px;color:var(--text)}`,
    `.task-sched{margin-left:auto;font-size:9px;color:var(--text-dim);font-variant-numeric:tabular-nums}`,
    `.task-prompt{font-size:10px;color:var(--text-dim);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
    `.task-last-run-row{font-size:9px;color:var(--text-dim);margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
    `.task-actions{display:flex;gap:4px}`,
    `.task-actions .btn{padding:1px 6px;font-size:9px}`,
    `.task-runs{margin-top:6px;border-top:1px solid var(--border);padding-top:4px}`,
    `.task-runs-loading,.task-runs-empty{font-size:10px;color:var(--text-dim);padding:4px 0}`,
    `.task-run-row{display:grid;grid-template-columns:1fr auto auto;gap:4px;padding:3px 0;font-size:10px;border-bottom:1px solid var(--border)}`,
    `.task-run-row:last-child{border-bottom:none}`,
    `.run-ts{color:var(--text-dim);font-variant-numeric:tabular-nums}`,
    `.run-dur{color:var(--text-dim);font-variant-numeric:tabular-nums;text-align:right}`,
    `.run-status{font-weight:600;text-align:right}`,
    `.run-success .run-status{color:var(--green,#4ade80)}`,
    `.run-error .run-status{color:var(--red,#f87171)}`,
    `.run-detail{grid-column:1/-1;font-size:9px;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
    `.agent-groups-wrap{border:1px solid var(--border);border-radius:4px;overflow:auto;flex:1}`,
    `.tables-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;flex:1;min-height:0;overflow:hidden}`,
    // Topology
    `.topo-section{position:relative;flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden}`,
    `.topo-section .section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}`,
    `.topo-section .section-header h2{font-size:10px;font-weight:600;color:var(--text-dim);text-transform:lowercase;letter-spacing:.06em;margin:0}`,
    `.topo-legend{display:flex;gap:12px;align-items:center}`,
    `.legend-item{display:flex;align-items:center;gap:4px;font-size:10px;color:var(--text-dim)}`,
    `.legend-dot{width:8px;height:8px;border-radius:50%}`,
    `.legend-agent{background:var(--accent);box-shadow:0 0 6px var(--accent)}`,
    `.legend-channel{background:var(--green);box-shadow:0 0 6px var(--green)}`,
    `.legend-server{background:var(--yellow);box-shadow:0 0 6px var(--yellow)}`,
    `.legend-category{background:var(--cyan);box-shadow:0 0 6px var(--cyan)}`,
    `.topo-canvas-wrap{border:1px solid var(--border);border-radius:6px;background:var(--surface);overflow:hidden;flex:1;min-height:0;position:relative}`,
    `.topo-canvas-wrap canvas{width:100%;height:100%;display:block;cursor:grab}`,
    `.topo-canvas-wrap canvas.dragging{cursor:grabbing}`,
    `.topo-tooltip{display:none;position:absolute;z-index:20;background:var(--surface-2);border:1px solid var(--border-bright);border-radius:4px;padding:6px 10px;font-size:11px;pointer-events:none;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.4)}`,
    `.topo-tooltip.visible{display:block}`,
    `.topo-tooltip .tt-name{font-weight:600;color:var(--text-bright)}`,
    `.topo-tooltip .tt-type{font-size:9px;text-transform:uppercase;letter-spacing:.04em;margin-left:6px}`,
    `.topo-tooltip .tt-type.agent{color:var(--accent)}`,
    `.topo-tooltip .tt-type.channel{color:var(--green)}`,
    `.topo-tooltip .tt-type.server{color:var(--yellow)}`,
    `.topo-tooltip .tt-detail{color:var(--text-dim);font-size:10px;margin-top:2px}`,
    `.topo-tooltip .tt-copy{color:var(--accent);font-size:9px;margin-top:2px;opacity:.6}`,
    `.tasks-section{flex-shrink:0}`,
    `.table-section{display:flex;flex-direction:column;overflow:hidden}`,
    `.table-section h2{font-size:10px;font-weight:600;margin-bottom:6px;color:var(--text-dim);text-transform:lowercase;letter-spacing:.06em}`,
    `.section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}`,
    `.section-header h2{margin-bottom:0}`,
    `.table-wrap{overflow:auto;flex:1;border-radius:4px;border:1px solid var(--border)}`,

    // --- Page: Conversations ---
    `.conv-layout{display:flex;flex:1;min-height:0;overflow:hidden}`,
    `.conv-sidebar{width:260px;flex-shrink:0;border-right:1px solid var(--border);display:flex;flex-direction:column;background:var(--surface)}`,
    `.conv-sidebar-header{padding:8px;border-bottom:1px solid var(--border)}`,
    `.conv-sidebar-header input{width:100%;padding:5px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:var(--mono);font-size:11px}`,
    `.conv-sidebar-header input:focus{outline:none;border-color:var(--accent)}`,
    `.chat-list{flex:1;overflow-y:auto}`,
    `.chat-item{padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--border);transition:background .12s}`,
    `.chat-item:hover{background:var(--accent-dim)}`,
    `.chat-item.selected{background:var(--accent-dim);border-left:2px solid var(--accent)}`,
    `.chat-name{font-size:12px;font-weight:600;margin-bottom:2px}`,
    `.chat-meta{font-size:10px;color:var(--text-dim)}`,
    `.chat-count{font-size:10px;color:var(--text-dim);padding:6px 10px;border-bottom:1px solid var(--border)}`,
    `.conv-content{flex:1;display:flex;flex-direction:column;min-width:0}`,
    `.conv-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:12px}`,
    `.message-header{padding:8px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;background:var(--surface);flex-shrink:0}`,
    `.message-header h2{font-size:13px;font-weight:600}`,
    `.message-header .jid-label{font-size:10px;color:var(--text-dim)}`,
    `.message-header .msg-count{font-size:10px;color:var(--text-dim);margin-left:auto}`,
    `.messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:4px}`,
    `.msg-row{display:flex;gap:8px;max-width:80%}`,
    `.msg-row.from-me{align-self:flex-end;flex-direction:row-reverse}`,
    `.msg-bubble{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px 10px;min-width:0}`,
    `.msg-row.from-me .msg-bubble{background:var(--accent-dim);border-color:rgba(129,140,248,.2)}`,
    `.msg-sender{font-size:10px;font-weight:600;color:var(--accent);margin-bottom:2px}`,
    `.msg-row.from-me .msg-sender{color:var(--accent-hover);text-align:right}`,
    `.msg-text{font-size:12px;white-space:pre-wrap;word-break:break-word}`,
    `.msg-time{font-size:9px;color:var(--text-dim);margin-top:3px}`,
    `.msg-row.from-me .msg-time{text-align:right}`,
    `.load-more-bar{text-align:center;padding:8px;flex-shrink:0}`,
    `.load-more-bar button{font-family:var(--mono)}`,
    `.loading{text-align:center;padding:2rem;color:var(--text-dim);font-size:12px}`,

    // --- Page: Context Viewer ---
    `.ctx-layout{display:flex;flex:1;min-height:0;overflow:hidden}`,
    `.ctx-sidebar{width:260px;min-width:260px;border-right:1px solid var(--border);display:flex;flex-direction:column;overflow-y:auto}`,
    `.ctx-sidebar-title{font-size:10px;text-transform:lowercase;letter-spacing:.06em;color:var(--text-dim);padding:10px 12px 4px;font-weight:600}`,
    `.agent-group{border-bottom:1px solid var(--border)}`,
    `.agent-header{display:flex;align-items:center;gap:6px;padding:6px 12px;cursor:pointer;transition:background .12s;user-select:none}`,
    `.agent-header:hover{background:var(--surface)}`,
    `.agent-header .chevron{font-size:9px;transition:transform .2s;color:var(--text-dim)}`,
    `.agent-header .chevron.open{transform:rotate(90deg)}`,
    `.agent-header .agent-name{font-size:12px;font-weight:500}`,
    `.agent-header .channel-count{margin-left:auto;font-size:10px;color:var(--text-dim);background:var(--border);padding:0 5px;border-radius:8px}`,
    `.channel-list{display:none}.channel-list.open{display:block}`,
    `.channel-item{padding:4px 12px 4px 24px;font-size:11px;color:var(--text-dim);cursor:pointer;transition:all .12s;display:flex;flex-direction:column}`,
    `.ch-name{font-weight:500;color:var(--text)}`,
    `.ch-jid-row{display:flex;align-items:center;gap:4px}`,
    `.ch-jid{font-size:9px;color:var(--text-dim);opacity:.6}`,
    `.copy-btn{background:none;border:1px solid transparent;color:var(--text-dim);opacity:.4;cursor:pointer;font-size:10px;padding:0 3px;border-radius:2px;transition:all .12s;line-height:1;flex-shrink:0}`,
    `.copy-btn:hover{opacity:1;color:var(--accent);border-color:var(--border)}`,
    `.copy-btn.copied{opacity:1;color:var(--green);border-color:var(--green)}`,
    `.channel-item:hover{color:var(--text);background:var(--accent-dim)}`,
    `.channel-item.active{color:var(--accent);background:var(--accent-dim)}`,
    `.ctx-content{flex:1;display:flex;flex-direction:column;overflow:hidden}`,
    `.ctx-header{padding:8px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-shrink:0}`,
    `.ctx-header .title{font-size:13px;font-weight:600}`,
    `.ctx-header .subtitle{font-size:11px;color:var(--text-dim)}`,
    `.empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-dim)}`,
    `.empty-state .icon{font-size:24px;margin-bottom:8px;opacity:.4}`,
    `.empty-state .label{font-size:12px}`,
    `.empty-state .hint{font-size:10px;margin-top:4px;color:var(--text-dim)}`,
    `.layer-tabs{display:flex;gap:0;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--surface)}`,
    `.layer-tab{padding:6px 12px;font-size:11px;font-weight:500;color:var(--text-dim);cursor:pointer;border-bottom:2px solid transparent;transition:all .12s;display:flex;align-items:center;gap:5px}`,
    `.layer-tab:hover{color:var(--text)}`,
    `.layer-tab.active{color:var(--accent);border-bottom-color:var(--accent)}`,
    `.layer-tab .dot{width:5px;height:5px;border-radius:50%}`,
    `.layer-tab .dot.exists{background:var(--green)}`,
    `.layer-tab .dot.missing{background:var(--text-dim);opacity:.3}`,
    `.editor-area{flex:1;display:flex;overflow:hidden;position:relative}`,
    `.view-toggle{position:absolute;top:6px;right:6px;z-index:10;display:flex;gap:0;border:1px solid var(--border);border-radius:4px;overflow:hidden}`,
    `.view-toggle button{font-family:var(--mono);padding:3px 8px;font-size:10px;border:none;background:var(--surface);color:var(--text-dim);cursor:pointer;transition:all .12s}`,
    `.view-toggle button:not(:last-child){border-right:1px solid var(--border)}`,
    `.view-toggle button.active{background:var(--accent);color:#fff}`,
    `.view-toggle button:hover:not(.active){color:var(--text)}`,
    `.editor-pane{flex:1;display:flex;flex-direction:column;overflow:hidden}`,
    `.editor-pane.hidden{display:none}`,
    `#editor-container{flex:1;overflow:hidden}`,
    `.preview-pane{flex:1;overflow-y:auto;padding:16px;border-left:1px solid var(--border);font-size:12px;line-height:1.7}`,
    `.preview-pane.hidden{display:none}`,
    `.preview-pane h1{font-size:18px;font-weight:700;margin:12px 0 6px}`,
    `.preview-pane h2{font-size:15px;font-weight:600;margin:12px 0 6px;color:var(--accent)}`,
    `.preview-pane h3{font-size:13px;font-weight:600;margin:8px 0 6px}`,
    `.preview-pane p{margin-bottom:8px}`,
    `.preview-pane ul,.preview-pane ol{margin-left:1.5rem;margin-bottom:8px}`,
    `.preview-pane li{margin-bottom:3px}`,
    `.preview-pane code{background:var(--border);padding:1px 5px;border-radius:3px;font-size:11px}`,
    `.preview-pane pre{background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:10px;margin-bottom:8px;overflow-x:auto}`,
    `.preview-pane pre code{background:none;padding:0}`,
    `.preview-pane strong{font-weight:600}`,
    `.preview-pane a{color:var(--accent);text-decoration:none}`,
    `.preview-pane a:hover{text-decoration:underline}`,
    `.preview-pane hr{border:none;border-top:1px solid var(--border);margin:12px 0}`,
    `.preview-pane blockquote{border-left:2px solid var(--accent);padding-left:10px;color:var(--text-dim);margin-bottom:8px}`,
    `.save-bar{display:none;padding:6px 12px;border-top:1px solid var(--border);background:var(--surface);flex-shrink:0;align-items:center;gap:8px}`,
    `.save-bar.visible{display:flex}`,
    `.save-bar .status{font-size:11px;color:var(--text-dim);flex:1}`,
    `.save-bar .status.unsaved{color:var(--yellow)}`,
    `.save-bar .status.saving{color:var(--accent)}`,
    `.save-bar .status.saved{color:var(--green)}`,
    `.save-bar .status.error{color:var(--red)}`,
    `.path-display{font-size:10px;color:var(--text-dim);padding:4px 12px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0}`,

    // --- Page: IPC Inspector ---
    `.ipc-layout{padding:12px 16px;flex:1;min-height:0;overflow-y:auto}`,
    `.ipc-layout section{margin-bottom:1.5rem}`,
    `.ipc-layout section h2{font-size:11px;font-weight:600;margin-bottom:8px;color:var(--text-dim);text-transform:lowercase;letter-spacing:.06em}`,
    `.ipc-layout table{border:1px solid var(--border);border-radius:4px;overflow:hidden}`,
    `.lane-badge{display:inline-block;font-size:10px;font-weight:600;padding:1px 6px;border-radius:3px;text-transform:uppercase}`,
    `.lane-active{color:var(--green);background:rgba(52,211,153,.1)}`,
    `.lane-idle{color:var(--yellow);background:rgba(251,191,36,.1)}`,
    `.lane-off{color:var(--text-dim);background:rgba(99,106,126,.06)}`,
    `.folder-key{font-size:11px}`,
    `.task-info{font-size:10px;color:var(--text-dim);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
    `.retry-count{color:var(--yellow);font-weight:600}`,
    `.event-time{font-size:10px;color:var(--text-dim);white-space:nowrap}`,
    `.event-source{font-size:11px;color:var(--blue)}`,
    `.event-summary{font-size:11px;max-width:500px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
    `.event-kind-badge{display:inline-block;font-size:9px;font-weight:600;padding:1px 5px;border-radius:3px;white-space:nowrap}`,
    `tr.event-ok .event-kind-badge{color:var(--green);background:rgba(52,211,153,.1)}`,
    `tr.event-warn .event-kind-badge{color:var(--yellow);background:rgba(251,191,36,.1)}`,
    `tr.event-error .event-kind-badge{color:var(--red);background:rgba(248,113,113,.1)}`,
    `tr.event-error td{color:var(--red)}`,
    `tr.event-warn td.event-summary{color:var(--yellow)}`,
    `.ipc-empty{padding:2rem;text-align:center;color:var(--text-dim);font-size:12px}`,

    // --- System Health Page ---
    `.system-page{padding:1.5rem;overflow:auto;flex:1}`,
    `.system-header{display:flex;align-items:center;gap:.75rem;margin-bottom:1.5rem}`,
    `.system-header h2{font-size:14px;font-weight:600;color:var(--text-bright);letter-spacing:.03em}`,
    `.health-badge{font-size:10px;font-weight:600;padding:2px 8px;border-radius:3px;color:var(--green);background:rgba(52,211,153,.1);letter-spacing:.03em}`,
    `.system-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem}`,
    `.metric-card{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1rem;display:flex;flex-direction:column;gap:.5rem}`,
    `.metric-card-title{font-size:11px;font-weight:600;color:var(--accent);text-transform:lowercase;letter-spacing:.05em;padding-bottom:.5rem;border-bottom:1px solid var(--border)}`,
    `.metric-row{display:flex;justify-content:space-between;align-items:center;padding:3px 0}`,
    `.metric-label{font-size:11px;color:var(--text-dim)}`,
    `.metric-value{font-size:12px;color:var(--text-bright);font-weight:500;font-variant-numeric:tabular-nums}`,
    `.metric-sub{font-size:10px;color:var(--text-dim);margin-top:.5rem;padding-top:.5rem;border-top:1px solid var(--border);letter-spacing:.03em}`,
    `.breakdown-item{display:flex;justify-content:space-between;align-items:center;padding:2px 0 2px .5rem}`,
    `.breakdown-key{font-size:11px;color:var(--text)}`,
    `.breakdown-val{font-size:11px;color:var(--text-bright);font-weight:500;font-variant-numeric:tabular-nums}`,

    // --- Page: Agent Detail ---
    `.agent-detail-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;height:100%;color:var(--text-dim);font-size:13px}`,
    `.agent-detail{padding:1.5rem;overflow:auto;flex:1}`,
    `.ad-back{margin-bottom:1rem}`,
    `.ad-header{display:flex;align-items:center;gap:1rem;margin-bottom:1.25rem}`,
    `.ad-avatar{width:56px;height:56px;border-radius:8px;object-fit:cover;background:var(--surface);border:1px solid var(--border);flex-shrink:0}`,
    `.ad-avatar-placeholder{width:56px;height:56px;border-radius:8px;background:var(--accent-dim);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:var(--accent);flex-shrink:0}`,
    `.ad-header-info{display:flex;flex-direction:column;gap:4px}`,
    `.ad-name{font-size:18px;font-weight:700;color:var(--text-bright);letter-spacing:.02em}`,
    `.ad-meta{display:flex;gap:6px;flex-wrap:wrap}`,
    `.ad-desc{font-size:12px;color:var(--text-dim);margin-top:2px}`,
    `.ad-info-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin-bottom:1.5rem;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px 16px}`,
    `.ad-info-item{display:flex;flex-direction:column;gap:2px}`,
    `.ad-info-label{font-size:10px;color:var(--text-dim);text-transform:lowercase;letter-spacing:.05em;font-weight:500}`,
    `.ad-info-value{font-size:12px;color:var(--text);word-break:break-all}`,
    `.ad-section{margin-bottom:1.25rem}`,
    `.ad-section-title{font-size:12px;font-weight:600;color:var(--text-bright);letter-spacing:.03em;margin-bottom:.5rem;display:flex;align-items:center;gap:6px}`,
    `.ad-count{font-size:10px;color:var(--text-dim);font-weight:400}`,
    `.ad-table-wrap{border:1px solid var(--border);border-radius:6px;overflow:hidden}`,
    `.ad-table-wrap table{background:var(--surface)}`,
    `.td-dim{color:var(--text-dim)}`,
    `.td-prompt{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,

    // --- Responsive ---
    `@media(max-width:900px){.stats-grid{grid-template-columns:repeat(2,1fr)}.tables-grid{grid-template-columns:1fr}.system-grid{grid-template-columns:1fr}}`,
    `@media(max-width:600px){.stats-grid{grid-template-columns:1fr}}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Shell Script
// ---------------------------------------------------------------------------

function shellScript(pageScripts: Record<string, string>): string {
  const parts: string[] = [];

  parts.push('(function(){');
  parts.push('"use strict";');

  // ---- State from localStorage ----
  parts.push('var STORAGE_KEY="omniclaw_sidebar";');
  parts.push(
    'function loadPrefs(){try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||"{}")}catch(e){return{}}}',
  );
  parts.push(
    'function savePrefs(p){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(p))}catch(e){}}',
  );
  parts.push('var prefs=loadPrefs();');
  parts.push('var workspace=document.getElementById("workspace");');
  parts.push('var sidebar=document.getElementById("log-sidebar");');
  parts.push('var handle=document.getElementById("resize-handle");');
  parts.push('var contentEl=document.getElementById("content");');

  // Apply saved prefs
  parts.push('if(prefs.side==="left")workspace.classList.add("sidebar-left");');
  parts.push(
    'if(prefs.collapsed)workspace.classList.add("sidebar-collapsed");',
  );
  parts.push(
    'if(prefs.width){document.documentElement.style.setProperty("--sidebar-w",prefs.width+"px");}',
  );

  // ---- Sidebar toggle side ----
  parts.push(
    'document.getElementById("btn-toggle-side").addEventListener("click",function(){',
  );
  parts.push('  workspace.classList.toggle("sidebar-left");');
  parts.push(
    '  prefs.side=workspace.classList.contains("sidebar-left")?"left":"right";',
  );
  parts.push('  savePrefs(prefs);');
  parts.push('});');

  // ---- Sidebar collapse ----
  parts.push(
    'document.getElementById("btn-collapse").addEventListener("click",function(){',
  );
  parts.push('  workspace.classList.toggle("sidebar-collapsed");');
  parts.push(
    '  prefs.collapsed=workspace.classList.contains("sidebar-collapsed");',
  );
  parts.push('  savePrefs(prefs);');
  parts.push('});');

  // ---- Sidebar tab switching ----
  parts.push(
    'document.querySelector(".sidebar-tabs").addEventListener("click",function(e){',
  );
  parts.push(
    '  var tab=e.target.closest("[data-sidebar-tab]");if(!tab)return;',
  );
  parts.push('  var name=tab.getAttribute("data-sidebar-tab");');
  parts.push(
    '  document.querySelectorAll(".sidebar-tab").forEach(function(t){t.classList.toggle("active",t.getAttribute("data-sidebar-tab")===name);});',
  );
  parts.push(
    '  document.querySelectorAll(".sidebar-panel").forEach(function(p){p.classList.toggle("active",p.id==="panel-"+name);});',
  );
  parts.push('});');

  // ---- Sidebar reopen button ----
  parts.push(
    'document.getElementById("btn-reopen-sidebar").addEventListener("click",function(){',
  );
  parts.push('  workspace.classList.remove("sidebar-collapsed");');
  parts.push('  prefs.collapsed=false;savePrefs(prefs);');
  parts.push('});');

  // ---- Resize handle ----
  parts.push('(function(){');
  parts.push('var dragging=false,startX=0,startW=0;');
  parts.push('handle.addEventListener("mousedown",function(e){');
  parts.push('  e.preventDefault();dragging=true;startX=e.clientX;');
  parts.push('  startW=sidebar.getBoundingClientRect().width;');
  parts.push('  handle.classList.add("dragging");');
  parts.push(
    '  document.body.style.cursor="col-resize";document.body.style.userSelect="none";',
  );
  parts.push('});');
  parts.push('document.addEventListener("mousemove",function(e){');
  parts.push('  if(!dragging)return;');
  parts.push('  var isLeft=workspace.classList.contains("sidebar-left");');
  parts.push('  var delta=isLeft?(e.clientX-startX):(startX-e.clientX);');
  parts.push('  var w=Math.max(200,Math.min(800,startW+delta));');
  parts.push(
    '  document.documentElement.style.setProperty("--sidebar-w",w+"px");',
  );
  parts.push('});');
  parts.push('document.addEventListener("mouseup",function(){');
  parts.push('  if(!dragging)return;dragging=false;');
  parts.push('  handle.classList.remove("dragging");');
  parts.push(
    '  document.body.style.cursor="";document.body.style.userSelect="";',
  );
  parts.push(
    '  prefs.width=sidebar.getBoundingClientRect().width;savePrefs(prefs);',
  );
  parts.push('});');
  parts.push('})();');

  // ---- Log filtering ----
  parts.push(
    'var levelFilters={debug:true,info:true,warn:true,error:true,fatal:true};',
  );
  parts.push('var autoScroll=true;');
  parts.push('var logContainer=document.getElementById("log-container");');
  parts.push('var logCountEl=document.getElementById("log-count");');

  // MutationObserver for auto-scroll
  parts.push('var logObs=new MutationObserver(function(){');
  parts.push('  var count=logContainer.querySelectorAll(".log-line").length;');
  parts.push('  logCountEl.textContent=count;');
  parts.push(
    '  if(autoScroll)logContainer.scrollTop=logContainer.scrollHeight;',
  );
  parts.push('});');
  parts.push('logObs.observe(logContainer,{childList:true,subtree:true});');

  // Level filter clicks
  parts.push(
    'document.getElementById("log-toolbar").addEventListener("click",function(e){',
  );
  parts.push('  var btn=e.target.closest(".filter-btn[data-level]");');
  parts.push('  if(!btn)return;');
  parts.push('  var level=btn.getAttribute("data-level");');
  parts.push('  if(level==="all"){');
  parts.push(
    '    var allOn=Object.keys(levelFilters).every(function(k){return levelFilters[k];});',
  );
  parts.push(
    '    var ns=!allOn;Object.keys(levelFilters).forEach(function(k){levelFilters[k]=ns;});',
  );
  parts.push(
    '    document.querySelectorAll("#log-toolbar .filter-btn[data-level]").forEach(function(b){',
  );
  parts.push(
    '      if(ns)b.classList.add("active");else b.classList.remove("active");',
  );
  parts.push('    });');
  parts.push('  }else{');
  parts.push('    levelFilters[level]=!levelFilters[level];');
  parts.push(
    '    if(levelFilters[level])btn.classList.add("active");else btn.classList.remove("active");',
  );
  parts.push(
    '    var allBtn=document.querySelector("#log-toolbar .filter-btn[data-level=\\"all\\"]");',
  );
  parts.push(
    '    var ao=Object.keys(levelFilters).every(function(k){return levelFilters[k];});',
  );
  parts.push(
    '    if(ao)allBtn.classList.add("active");else allBtn.classList.remove("active");',
  );
  parts.push('  }');
  parts.push(
    '  logContainer.querySelectorAll(".log-line[data-level]").forEach(function(line){',
  );
  parts.push('    var lv=line.getAttribute("data-level");');
  parts.push('    line.style.display=levelFilters[lv]?"":"none";');
  parts.push('  });');
  parts.push('});');

  // Auto-scroll toggle
  parts.push(
    'document.getElementById("btn-autoscroll").addEventListener("click",function(){',
  );
  parts.push(
    '  autoScroll=!autoScroll;this.classList.toggle("active",autoScroll);',
  );
  parts.push('});');

  // Clear logs
  parts.push(
    'document.getElementById("btn-clear-logs").addEventListener("click",function(){',
  );
  parts.push('  logContainer.innerHTML="";logCountEl.textContent="0";');
  parts.push('});');

  // ---- Agent group toggle (shared by dashboard + context) ----
  parts.push('document.addEventListener("click",function(e){');
  parts.push('  var hdr=e.target.closest("[data-toggle-agent]");');
  parts.push(
    '  if(hdr){hdr.querySelector(".chevron").classList.toggle("open");hdr.nextElementSibling.classList.toggle("open");return;}',
  );
  parts.push('  var cpBtn=e.target.closest("[data-copy]");');
  parts.push('  if(cpBtn){');
  parts.push('    var val=cpBtn.getAttribute("data-copy");');
  parts.push('    navigator.clipboard.writeText(val).then(function(){');
  parts.push(
    '      cpBtn.classList.add("copied");cpBtn.textContent="\\u2713";',
  );
  parts.push(
    '      setTimeout(function(){cpBtn.classList.remove("copied");cpBtn.textContent="\\u2398";},1200);',
  );
  parts.push('    });');
  parts.push('    e.stopPropagation();return;');
  parts.push('  }');
  parts.push('});');

  // ---- SPA Navigation via fetch ----
  parts.push('var navLoading=false;');
  parts.push('function navigateTo(pageName,href){');
  parts.push('  if(navLoading)return;navLoading=true;');
  parts.push(
    '  if(window.__cleanup){window.__cleanup();window.__cleanup=null;}',
  );
  parts.push('  var qp="";var qi=href.indexOf("?");if(qi!==-1)qp=href.slice(qi);');
  parts.push('  fetch("/api/page/"+encodeURIComponent(pageName)+qp)');
  parts.push(
    '  .then(function(r){if(!r.ok)throw new Error("nav failed");return r.json();})',
  );
  parts.push('  .then(function(data){');
  parts.push('    contentEl.innerHTML=data.html;');
  parts.push('    document.title="OmniClaw \\u2014 "+data.title;');
  parts.push('    history.pushState({page:pageName},"",data.path);');
  parts.push(
    '    document.querySelectorAll("[data-nav]").forEach(function(a){',
  );
  parts.push(
    '      a.classList.toggle("active",a.getAttribute("href")===data.path);',
  );
  parts.push('    });');
  parts.push('    window.__initPage(pageName);');
  parts.push('    navLoading=false;');
  parts.push(
    '  }).catch(function(err){console.error("SPA nav error:",err);navLoading=false;location.href=href;});',
  );
  parts.push('}');
  parts.push('document.addEventListener("click",function(e){');
  parts.push('  var link=e.target.closest("[data-nav]");if(!link)return;');
  parts.push('  e.preventDefault();');
  parts.push('  var pageName=link.getAttribute("data-page");');
  parts.push('  var href=link.getAttribute("href");');
  parts.push('  navigateTo(pageName,href);');
  parts.push('});');
  parts.push('window.addEventListener("popstate",function(e){');
  parts.push(
    '  if(e.state&&e.state.page){navigateTo(e.state.page,location.pathname);}',
  );
  parts.push('  else{location.reload();}');
  parts.push('});');

  // ---- Page init dispatch ----
  parts.push('window.__cleanup=null;');
  parts.push('window.__pageInits={};');
  parts.push('window.__initPage=function(name){');
  parts.push(
    '  if(window.__cleanup){window.__cleanup();window.__cleanup=null;}',
  );
  parts.push('  if(window.__pageInits[name])window.__pageInits[name]();');
  parts.push('};');

  // ---- Toast helper (used by multiple pages) ----
  parts.push('window.__toast=function(msg,type){');
  parts.push('  var ex=document.querySelector(".toast");if(ex)ex.remove();');
  parts.push(
    '  var el=document.createElement("div");el.className="toast "+(type||"success");',
  );
  parts.push('  el.textContent=msg;document.body.appendChild(el);');
  parts.push('  setTimeout(function(){el.remove();},3000);');
  parts.push('};');

  // ---- Task actions (in persistent sidebar) ----
  parts.push(
    'document.getElementById("sidebar-tasks").addEventListener("click",function(e){',
  );
  parts.push(
    '  var btn=e.target.closest("button[data-action]");if(!btn)return;',
  );
  parts.push(
    '  var card=btn.closest("[data-task-id]");var taskId=card.getAttribute("data-task-id");',
  );
  parts.push('  var action=btn.getAttribute("data-action");');
  parts.push('  if(action==="toggle"){');
  parts.push('    var ns=btn.getAttribute("data-status");btn.disabled=true;');
  parts.push(
    '    fetch("/api/tasks/"+encodeURIComponent(taskId),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:ns})})',
  );
  parts.push(
    '    .then(function(r){if(!r.ok)return r.json().then(function(d){throw new Error(d.error);});return r.json();})',
  );
  parts.push(
    '    .then(function(){window.__toast("Task "+(ns==="paused"?"paused":"resumed"));})',
  );
  parts.push(
    '    .catch(function(err){window.__toast(err.message||"Failed","error");btn.disabled=false;});',
  );
  parts.push('  }');
  parts.push('  if(action==="delete"){');
  parts.push('    btn.disabled=true;');
  parts.push(
    '    fetch("/api/tasks/"+encodeURIComponent(taskId),{method:"DELETE"})',
  );
  parts.push(
    '    .then(function(r){if(!r.ok)return r.json().then(function(d){throw new Error(d.error);});return r.json();})',
  );
  parts.push(
    '    .then(function(){window.__toast("Task deleted");card.remove();})',
  );
  parts.push(
    '    .catch(function(err){window.__toast(err.message||"Failed","error");btn.disabled=false;});',
  );
  parts.push('  }');
  // ---- Task run history toggle ----
  parts.push('  if(action==="runs"){');
  parts.push(
    '    var runsEl=card.querySelector(".task-runs");if(!runsEl)return;',
  );
  parts.push(
    '    if(runsEl.style.display!=="none"){runsEl.style.display="none";return;}',
  );
  parts.push(
    '    runsEl.innerHTML="<div class=\\"task-runs-loading\\">Loading…</div>";',
  );
  parts.push('    runsEl.style.display="";');
  parts.push(
    '    fetch("/api/tasks/"+encodeURIComponent(taskId)+"/runs?limit=10")',
  );
  parts.push(
    '    .then(function(r){if(!r.ok)throw new Error("Failed");return r.json();})',
  );
  parts.push('    .then(function(runs){');
  parts.push(
    '      if(!runs.length){runsEl.innerHTML="<div class=\\"task-runs-empty\\">No runs yet</div>";return;}',
  );
  parts.push('      runsEl.innerHTML=runs.map(function(r){');
  parts.push('        var d=new Date(r.run_at);var ts=d.toLocaleString();');
  parts.push(
    '        var dur=r.duration_ms<1000?r.duration_ms+"ms":(r.duration_ms/1000).toFixed(1)+"s";',
  );
  parts.push('        var cls=r.status==="success"?"run-success":"run-error";');
  parts.push(
    '        var detail=r.status==="success"?(r.result||"ok"):("Error: "+(r.error||"unknown"));',
  );
  parts.push('        if(detail.length>60)detail=detail.slice(0,57)+"…";');
  parts.push('        return "<div class=\\"task-run-row \\"+cls+"\\">"');
  parts.push(
    '          +"<span class=\\"run-ts\\">"+window.__esc(ts)+"</span>"',
  );
  parts.push(
    '          +"<span class=\\"run-dur\\">"+window.__esc(dur)+"</span>"',
  );
  parts.push(
    '          +"<span class=\\"run-status\\">"+window.__esc(r.status)+"</span>"',
  );
  parts.push(
    '          +"<div class=\\"run-detail\\" title=\\""+window.__esc(r.result||r.error||"")+"\\">"+window.__esc(detail)+"</div>"',
  );
  parts.push('          +"</div>";');
  parts.push('      }).join("");');
  parts.push('    })');
  parts.push(
    '    .catch(function(){runsEl.innerHTML="<div class=\\"task-runs-empty\\">Failed to load runs</div>";});',
  );
  parts.push('  }');
  parts.push('});');

  // Create task button opens modal (modal is in dashboard page content)
  parts.push(
    'document.getElementById("btn-create-task").addEventListener("click",function(){',
  );
  parts.push('  var modal=document.getElementById("create-task-modal");');
  parts.push(
    '  if(modal){modal.classList.add("open");var e=document.getElementById("ct-error");if(e)e.textContent="";}',
  );
  parts.push(
    '  else{window.__toast("Navigate to Dashboard to create tasks","error");}',
  );
  parts.push('});');

  // ---- Escape helper (used by page inits) ----
  parts.push(
    'window.__esc=function(s){if(!s)return"";var d=document.createElement("div");d.textContent=String(s);return d.innerHTML;};',
  );

  // ---- Embed page scripts ----
  for (const [name, script] of Object.entries(pageScripts)) {
    parts.push('// --- Page init: ' + name + ' ---');
    parts.push('window.__pageInits["' + name + '"]=function(){');
    parts.push(script);
    parts.push('};');
  }

  parts.push('})();');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Backward compat exports
// ---------------------------------------------------------------------------

export const CSS_VARS = [
  '--bg:#0c0f16',
  '--surface:#141821',
  '--border:#232839',
  '--text:#cdd2dc',
  '--text-dim:#636a7e',
  '--accent:#818cf8',
  '--green:#34d399',
  '--yellow:#fbbf24',
  '--red:#f87171',
  '--blue:#60a5fa',
].join(';');

export const BASE_CSS = `:root{${CSS_VARS}}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'JetBrains Mono','SF Mono',monospace;background:var(--bg);color:var(--text)}`;
