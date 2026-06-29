/**
 * SPA shell: persistent layout with live-log sidebar and Datastar SSE navigation.
 * All pages render inside this shell; navigating between them patches #content
 * via SSE without losing the log stream or sidebar state.
 */

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', page: 'dashboard' },
  { href: '/agents-list', label: 'Agents', page: 'agents' },
  { href: '/tasks', label: 'Tasks', page: 'tasks' },
  { href: '/logs', label: 'Logs', page: 'logs' },
  { href: '/conversations', label: 'Conversations', page: 'conversations' },
  { href: '/context', label: 'Context', page: 'context' },
  { href: '/ipc', label: 'IPC', page: 'ipc' },
  { href: '/network', label: 'Network', page: 'network' },
  { href: '/system', label: 'System', page: 'system' },
  { href: '/settings', label: 'Settings', page: 'settings' },
];

export function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function escapeJsonForHtml(json: string): string {
  return json
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Format a millisecond duration as a compact human-readable string for
 * operator surfaces. Unit progression: `<1s` \u2192 ms, `<1m` \u2192 seconds (1 dp),
 * `<1h` \u2192 minutes (1 dp), else hours (1 dp).
 */
export function formatDurationCompact(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Render just the nav link elements (used for SSE patching of active state). */
export function renderNavLinks(activePath: string): string {
  return NAV_ITEMS.map(
    (item) =>
      `<a href="${item.href}" data-nav data-page="${item.page}" ` +
      `data-on:click__prevent="history.pushState({page: el.dataset.page}, '', el.getAttribute('href')); @get('/api/page/' + el.dataset.page)" ` +
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
    `<button id="btn-hamburger" class="hamburger" title="Menu" aria-label="Toggle navigation" aria-expanded="false">\u2261</button>` +
    `<div class="brand">omniclaw</div>` +
    `<nav id="nav-links">${renderNavLinks(activePath)}</nav>` +
    `<div class="header-right">` +
    `<button id="btn-theme-toggle" class="theme-toggle" title="Toggle theme" aria-label="Toggle theme: dark" aria-pressed="false">\u263E</button>` +
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
    `<title id="page-title">OmniClaw${title ? ' \u2014 ' + escapeHtml(title) : ''}</title>` +
    `<link rel="preconnect" href="https://fonts.googleapis.com">` +
    `<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">` +
    `<style>${shellCSS()}</style>` +
    `<script type="module" src="https://cdn.jsdelivr.net/gh/starfederation/datastar@1.0.0-RC.8/bundles/datastar.js"></scr` +
    `ipt>` +
    `</head><body>` +
    // Inline theme init to prevent FOUC (data-theme-init prevents test regex match)
    `<scr` +
    `ipt data-theme-init>(function(){var t=null;try{t=localStorage.getItem("omniclaw_theme")}catch(e){}if(!t){t=matchMedia("(prefers-color-scheme:light)").matches?"light":"dark";}if(t==="light")document.documentElement.setAttribute("data-theme","light");})()</scr` +
    `ipt>` +
    // Persistent SSE connector (outside #content so it survives navigation)
    `<div id="sse-init" style="display:none" data-init="@get('/api/events?channels=logs,stats,agents,tasks')"></div>` +
    renderNav(activePath) +
    `<div class="nav-backdrop" id="nav-backdrop"></div>` +
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
    `<div class="toast-container" id="toast-container" aria-live="polite"></div>` +
    shortcutHelpModal() +
    commandPaletteHtml() +
    `<scr` +
    `ipt>${shellScript(pageScripts)}</scr` +
    `ipt>` +
    `</body></html>`
  );
}

export function renderPagePatch(
  activePath: string,
  title: string,
  contentHtml: string,
): string {
  return (
    `<title id="page-title">OmniClaw${title ? ' \u2014 ' + escapeHtml(title) : ''}</title>` +
    `<nav id="nav-links">${renderNavLinks(activePath)}</nav>` +
    `<main id="content">${contentHtml}</main>`
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
    // --- Light theme overrides ---
    `[data-theme="light"]{`,
    `--bg:#f5f5f7;--surface:#ffffff;--surface-2:#ebedf0;`,
    `--border:#d1d5db;--border-bright:#b0b6c3;`,
    `--text:#1f2937;--text-dim:#6b7280;--text-bright:#111827;`,
    `--accent:#6366f1;--accent-hover:#4f46e5;--accent-dim:rgba(99,102,241,.1);`,
    `--green:#059669;--yellow:#d97706;--red:#dc2626;--blue:#2563eb;--cyan:#0891b2}`,
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
    `.badge-cursor-sdk{background:rgba(245,158,11,.12);color:var(--yellow)}`,
    `.badge-sm{font-size:9px;padding:0 5px}`,
    `.badge-preprocess{background:color-mix(in srgb,var(--accent) 22%,transparent);color:var(--accent);cursor:help}`,
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
    `.toast-container{position:fixed;bottom:1rem;right:1rem;z-index:200;display:flex;flex-direction:column-reverse;gap:8px;pointer-events:none}`,
    `.toast{pointer-events:auto;display:flex;align-items:center;gap:8px;padding:8px 14px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:12px;animation:toastIn .2s ease-out;max-width:400px;box-shadow:0 4px 12px rgba(0,0,0,.3)}`,
    `.toast[role="alert"]{outline:none}`,
    `.toast.removing{animation:toastOut .15s ease-in forwards}`,
    `.toast-icon{flex-shrink:0;font-size:14px;line-height:1}`,
    `.toast-msg{flex:1;line-height:1.4}`,
    `.toast-close{flex-shrink:0;background:none;border:none;color:inherit;opacity:.5;cursor:pointer;font-size:14px;padding:0 2px;line-height:1;transition:opacity .12s}`,
    `.toast-close:hover{opacity:1}`,
    `.toast.success{border-color:var(--green);color:var(--green)}`,
    `.toast.error{border-color:var(--red);color:var(--red)}`,
    `.toast.warning{border-color:var(--yellow);color:var(--yellow)}`,
    `.toast.info{border-color:var(--blue);color:var(--blue)}`,
    `@keyframes toastIn{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:translateX(0)}}`,
    `@keyframes toastOut{to{opacity:0;transform:translateX(16px)}}`,

    // --- Command Palette ---
    `.cmd-palette-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:300;align-items:flex-start;justify-content:center;padding-top:min(20vh,120px)}`,
    `.cmd-palette-overlay.open{display:flex}`,
    `.cmd-palette{background:var(--surface);border:1px solid var(--border-bright);border-radius:10px;width:520px;max-width:90vw;max-height:min(60vh,420px);display:flex;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,.5);animation:cmdSlideIn .12s ease-out}`,
    `@keyframes cmdSlideIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}`,
    `.cmd-input-wrap{display:flex;align-items:center;padding:10px 14px;border-bottom:1px solid var(--border);gap:8px}`,
    `.cmd-input-wrap .cmd-icon{color:var(--text-dim);font-size:14px;flex-shrink:0}`,
    `.cmd-input{flex:1;background:none;border:none;color:var(--text-bright);font-family:var(--mono);font-size:13px;outline:none}`,
    `.cmd-input::placeholder{color:var(--text-dim)}`,
    `.cmd-input-wrap kbd{font-family:var(--mono);font-size:10px;color:var(--text-dim);background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:1px 5px;flex-shrink:0}`,
    `.cmd-results{flex:1;overflow-y:auto;padding:4px}`,
    `.cmd-group-label{font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim);padding:6px 12px 2px}`,
    `.cmd-item{display:flex;align-items:center;gap:8px;padding:6px 12px;border-radius:4px;cursor:pointer;transition:background .08s;font-size:12px}`,
    `.cmd-item:hover,.cmd-item.selected{background:var(--accent-dim)}`,
    `.cmd-item.selected{outline:1px solid rgba(129,140,248,.3)}`,
    `.cmd-item .cmd-item-icon{font-size:14px;width:20px;text-align:center;flex-shrink:0;color:var(--text-dim)}`,
    `.cmd-item .cmd-item-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}`,
    `.cmd-item.selected .cmd-item-label{color:var(--text-bright)}`,
    `.cmd-item .cmd-item-hint{font-size:10px;color:var(--text-dim);flex-shrink:0}`,
    `.cmd-item mark{background:none;color:var(--accent);font-weight:600}`,
    `.cmd-empty{padding:24px;text-align:center;color:var(--text-dim);font-size:12px}`,
    `.cmd-footer{display:flex;align-items:center;gap:12px;padding:6px 12px;border-top:1px solid var(--border);font-size:10px;color:var(--text-dim)}`,
    `.cmd-footer kbd{font-family:var(--mono);font-size:9px;background:var(--bg);border:1px solid var(--border);border-radius:2px;padding:0 4px}`,

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
    `.form-hint{font-size:10px;color:var(--text-dim);margin-top:4px;line-height:1.4}`,
    `.form-optional{text-transform:none;letter-spacing:0;color:var(--text-dim);font-weight:normal}`,

    // --- Keyboard Shortcut Help ---
    `.shortcut-modal{width:480px}`,
    `.shortcut-modal-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem}`,
    `.shortcut-modal-header h3{font-size:14px;font-weight:600;margin:0}`,
    `.shortcut-sections{display:flex;flex-direction:column;gap:1rem}`,
    `.shortcut-section-title{font-size:10px;font-weight:600;color:var(--accent);text-transform:lowercase;letter-spacing:.06em;margin-bottom:.5rem;padding-bottom:4px;border-bottom:1px solid var(--border)}`,
    `.shortcut-row{display:flex;align-items:center;justify-content:space-between;padding:3px 0}`,
    `.shortcut-keys{display:flex;align-items:center;gap:4px}`,
    `.shortcut-keys kbd{display:inline-block;min-width:20px;text-align:center;padding:2px 6px;background:var(--bg);border:1px solid var(--border-bright);border-radius:3px;font-family:var(--mono);font-size:11px;font-weight:500;color:var(--text-bright);box-shadow:0 1px 0 var(--border)}`,
    `.shortcut-then{font-size:9px;color:var(--text-dim);padding:0 2px}`,
    `.shortcut-desc{font-size:12px;color:var(--text-dim)}`,

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
    `.chat-name-row{display:flex;align-items:center;gap:6px;margin-bottom:2px;min-width:0}`,
    `.chat-name{font-size:12px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:6px}`,
    `.chat-meta{font-size:10px;color:var(--text-dim)}`,
    `.chat-platform{flex-shrink:0}`,
    `.platform-discord{background:rgba(88,101,242,.12);color:#7983f5}`,
    `.platform-telegram{background:rgba(34,158,217,.12);color:#3aa9d6}`,
    `.platform-whatsapp{background:rgba(37,211,102,.12);color:#34c47a}`,
    `.platform-slack{background:rgba(228,79,144,.12);color:#e57bb4}`,
    `.platform-unknown{background:var(--surface-2);color:var(--text-dim)}`,
    `.chat-activity-badge{font-size:9px;font-weight:600;color:var(--accent);background:var(--accent-dim);border-radius:8px;padding:1px 6px;line-height:1.4;letter-spacing:.02em}`,
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
    `.msg-md{white-space:normal}`,
    `.msg-md p{margin:0 0 4px}`,
    `.msg-md p:last-child{margin-bottom:0}`,
    `.msg-md code{background:rgba(255,255,255,.06);padding:1px 4px;border-radius:3px;font-size:11px}`,
    `.msg-md pre{background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:4px;padding:8px;margin:4px 0;overflow-x:auto;white-space:pre}`,
    `.msg-md pre code{background:none;padding:0;font-size:11px}`,
    `.msg-md ul,.msg-md ol{margin:2px 0;padding-left:18px}`,
    `.msg-md li{margin-bottom:1px}`,
    `.msg-md blockquote{border-left:2px solid var(--accent);margin:4px 0;padding:2px 8px;color:var(--text-dim)}`,
    `.msg-md h1,.msg-md h2,.msg-md h3{font-size:12px;font-weight:700;margin:4px 0 2px}`,
    `.msg-md a{color:var(--accent);text-decoration:underline}`,
    `.msg-md hr{border:none;border-top:1px solid var(--border);margin:6px 0}`,
    `.msg-md table{border-collapse:collapse;margin:4px 0;font-size:11px}`,
    `.msg-md th,.msg-md td{border:1px solid var(--border);padding:2px 6px}`,
    `.msg-md th{background:rgba(255,255,255,.04);font-weight:600}`,
    `.msg-time{font-size:9px;color:var(--text-dim);margin-top:3px}`,
    `.msg-row.from-me .msg-time{text-align:right}`,
    `.load-more-bar{text-align:center;padding:8px;flex-shrink:0}`,
    `.load-more-bar button{font-family:var(--mono)}`,
    `.conv-search-tabs{display:flex;gap:0;margin-bottom:6px}`,
    `.conv-tab{flex:1;padding:4px 0;font-size:10px;font-family:var(--mono);background:var(--bg);border:1px solid var(--border);color:var(--text-dim);cursor:pointer;transition:all .12s}`,
    `.conv-tab:first-child{border-radius:4px 0 0 4px}`,
    `.conv-tab:last-child{border-radius:0 4px 4px 0;border-left:none}`,
    `.conv-tab.active{background:var(--accent-dim);color:var(--accent);border-color:var(--accent)}`,
    `.search-results{flex:1;overflow-y:auto}`,
    `.search-result{padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--border);transition:background .12s}`,
    `.search-result:hover{background:var(--accent-dim)}`,
    `.search-result-chat{font-size:10px;color:var(--accent);font-weight:600;margin-bottom:2px}`,
    `.search-result-text{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`,
    `.search-result-text mark{background:var(--accent-dim);color:var(--accent);border-radius:2px;padding:0 2px}`,
    `.search-result-meta{font-size:9px;color:var(--text-dim);margin-top:2px}`,
    `.search-count{font-size:10px;color:var(--text-dim);padding:6px 10px;border-bottom:1px solid var(--border)}`,
    `.search-filters{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}`,
    `.search-filter-select,.search-filter-input{font-family:var(--mono);font-size:10px;padding:3px 6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;width:100%}`,
    `.search-filter-select:focus,.search-filter-input:focus,.search-filter-date:focus{outline:none;border-color:var(--accent)}`,
    `.search-date-row{display:flex;align-items:center;gap:4px;width:100%}`,
    `.search-filter-date{font-family:var(--mono);font-size:10px;padding:3px 6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;flex:1;min-width:0}`,
    `.search-date-sep{color:var(--text-dim);font-size:10px;flex-shrink:0}`,
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
    `.lane-reason{display:inline-block;font-size:9px;font-weight:500;padding:1px 5px;margin-left:4px;border-radius:3px;color:var(--text-dim);background:rgba(99,106,126,.06);letter-spacing:.04em}`,
    `.reason-running{color:var(--green);background:rgba(52,211,153,.1)}`,
    `.reason-cooling-down{color:var(--yellow);background:rgba(251,191,36,.08)}`,
    `.reason-back-pressure{color:var(--blue);background:rgba(96,165,250,.1)}`,
    `.reason-retrying{color:var(--red);background:rgba(248,113,113,.1)}`,
    `.reason-no-work{color:var(--text-dim);background:rgba(99,106,126,.06)}`,
    `.folder-key{font-size:11px}`,
    `.task-info{font-size:10px;color:var(--text-dim);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
    `.retry-count{color:var(--yellow);font-weight:600}`,
    `.lane-age{display:inline-block;font-size:9px;font-weight:500;padding:1px 5px;margin-left:4px;border-radius:3px;color:var(--text-dim);background:rgba(99,106,126,.08);font-variant-numeric:tabular-nums}`,
    `.last-error{font-size:11px;max-width:320px;display:flex;flex-direction:column;gap:2px}`,
    `.last-error-link{display:flex;align-items:baseline;gap:6px;color:var(--red);text-decoration:none;max-width:100%}`,
    `.last-error-link:hover .last-error-text{text-decoration:underline}`,
    `.last-error-lane{flex-shrink:0;font-size:9px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim);border:1px solid var(--border);border-radius:3px;padding:0 3px}`,
    `.last-error-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}`,
    `.last-error-age{flex-shrink:0;font-variant-numeric:tabular-nums;color:var(--text-dim);font-size:10px}`,
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

    // --- Page: Task Manager ---
    `.tasks-page{padding:12px 16px;flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column}`,
    `.tasks-header{flex-shrink:0;margin-bottom:12px}`,
    `.tasks-title-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}`,
    `.tasks-title-row h2{font-size:14px;font-weight:600;color:var(--text-bright);letter-spacing:.03em}`,
    `.tasks-stats{display:flex;gap:12px;margin-bottom:8px}`,
    `.tasks-stat{font-size:11px;color:var(--text-dim);font-variant-numeric:tabular-nums}`,
    `.tasks-stat.stat-active{color:var(--green)}`,
    `.tasks-stat.stat-executing{color:var(--blue)}`,
    `.tasks-stat.stat-paused{color:var(--yellow)}`,
    `.tasks-stat.stat-completed{color:var(--text-dim)}`,
    `.tasks-filters{display:flex;gap:3px}`,
    `.tasks-table-wrap{flex:1;overflow:auto;border:1px solid var(--border);border-radius:6px}`,
    `.tasks-table{width:100%;border-collapse:collapse;font-size:12px}`,
    `.tasks-table th{text-align:left;padding:6px 10px;background:var(--bg);font-weight:600;font-size:10px;text-transform:lowercase;letter-spacing:.05em;color:var(--text-dim);position:sticky;top:0;z-index:1;border-bottom:1px solid var(--border)}`,
    `.tasks-table td{padding:5px 10px;border-top:1px solid var(--border);vertical-align:middle}`,
    `.tasks-table tbody tr{transition:background .08s}`,
    `.tasks-table tbody tr:hover{background:var(--surface)}`,
    `.tasks-table tbody tr.hidden{display:none}`,
    `.td-agent{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}`,
    `.td-prompt{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
    `.td-sched{white-space:nowrap}`,
    `.sched-label{font-size:11px;color:var(--text-dim)}`,
    `.td-time{font-size:11px;color:var(--text-dim);white-space:nowrap;font-variant-numeric:tabular-nums}`,
    `.td-actions{white-space:nowrap}`,
    `.td-actions .btn{margin-right:2px}`,
    `.tasks-empty{padding:2rem;text-align:center;color:var(--text-dim);font-size:12px}`,
    `.tm-run-panel{border:1px solid var(--border);border-radius:6px;margin-top:8px;background:var(--surface);flex-shrink:0;max-height:300px;overflow-y:auto}`,
    `.tm-run-header{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--surface);z-index:1}`,
    `.tm-run-header h3{font-size:12px;font-weight:600;color:var(--text-bright)}`,
    `.tm-delete-msg{font-size:12px;color:var(--text);margin-bottom:.75rem}`,
    `.schedule-preview{font-size:10px;color:var(--accent);margin-top:3px;min-height:14px}`,
    `.schedule-preview.warning{color:var(--yellow)}`,
    `.interval-row{display:flex;gap:6px}`,
    `.interval-num{flex:1}`,
    `.interval-unit{width:auto;min-width:90px}`,
    `.datetime-input{width:100%}`,

    // --- Page: Logs ---
    `.logs-page{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}`,
    `.logs-toolbar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap;background:var(--surface)}`,
    `.logs-toolbar-left{display:flex;align-items:center;gap:8px;flex-shrink:0}`,
    `.logs-toolbar-left h2{font-size:13px;font-weight:600;color:var(--text-bright);letter-spacing:.03em;white-space:nowrap}`,
    `.logs-line-count{font-size:10px;color:var(--text-dim);font-variant-numeric:tabular-nums;white-space:nowrap}`,
    `.logs-toolbar-center{flex:1;min-width:200px;max-width:400px}`,
    `.logs-search{display:flex;align-items:center;gap:6px}`,
    `.logs-search input{flex:1;padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:var(--mono);font-size:11px}`,
    `.logs-search input:focus{outline:none;border-color:var(--accent)}`,
    `.logs-search-option{display:flex;align-items:center;gap:3px;font-size:10px;color:var(--text-dim);cursor:pointer;white-space:nowrap;user-select:none}`,
    `.logs-search-option input{width:12px;height:12px;accent-color:var(--accent)}`,
    `.logs-toolbar-right{display:flex;align-items:center;gap:4px;flex-shrink:0;flex-wrap:wrap}`,
    `.logs-level-filters{display:flex;gap:2px}`,
    `.logs-source-select{padding:3px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:var(--mono);font-size:10px;max-width:160px}`,
    `.logs-source-select:focus{outline:none;border-color:var(--accent)}`,
    `.logs-output{flex:1;overflow-y:auto;padding:2px 0;font-size:11px;line-height:1.6;background:var(--bg)}`,
    `.logs-output .log-line{padding:0 12px}`,
    `.logs-output .log-line.search-match{background:rgba(129,140,248,.08)}`,
    `.logs-output .log-line .search-highlight{background:rgba(251,191,36,.3);border-radius:2px;padding:0 1px}`,
    `.logs-status-bar{display:flex;align-items:center;justify-content:space-between;padding:4px 12px;border-top:1px solid var(--border);flex-shrink:0;background:var(--surface);font-size:10px;color:var(--text-dim)}`,

    // --- Agents Page ---
    `.agents-page{padding:12px 16px;flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column}`,
    `.ap-header{flex-shrink:0;margin-bottom:12px}`,
    `.ap-title-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}`,
    `.ap-title-row h2{font-size:14px;font-weight:600;color:var(--text-bright);letter-spacing:.03em}`,
    `.ap-counts{display:flex;gap:12px}`,
    `.ap-count{font-size:11px;color:var(--text-dim);font-variant-numeric:tabular-nums}`,
    `.ap-filters{display:flex;gap:6px;flex-wrap:wrap}`,
    `.ap-search{background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:11px;padding:4px 8px;width:200px;font-family:inherit}`,
    `.ap-search::placeholder{color:var(--text-dim)}`,
    `.ap-filter-select{background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:11px;padding:4px 6px;font-family:inherit}`,
    `.ap-table-wrap{flex:1;overflow:auto;border:1px solid var(--border);border-radius:6px}`,
    `.ap-table{width:100%;border-collapse:collapse;font-size:12px}`,
    `.ap-table th{text-align:left;padding:6px 10px;background:var(--bg);font-weight:600;font-size:10px;text-transform:lowercase;letter-spacing:.05em;color:var(--text-dim);position:sticky;top:0;z-index:1;border-bottom:1px solid var(--border)}`,
    `.ap-table .th-center{text-align:center}`,
    `.ap-table td{padding:5px 10px;border-top:1px solid var(--border);vertical-align:middle}`,
    `.ap-table .td-center{text-align:center;font-variant-numeric:tabular-nums}`,
    `.ap-table tbody tr{transition:background .08s}`,
    `.ap-table tbody tr:hover{background:var(--surface)}`,
    `.ap-agent-link{display:flex;align-items:center;gap:8px;color:var(--text);text-decoration:none}`,
    `.ap-agent-link:hover .ap-name{color:var(--accent)}`,
    `.ap-avatar-wrap{flex-shrink:0;width:24px;height:24px}`,
    `.ap-avatar{width:24px;height:24px;border-radius:50%;object-fit:cover}`,
    `.ap-avatar-ph{display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--surface-2);color:var(--text-dim);font-size:11px;font-weight:600}`,
    `.ap-name{font-weight:500;white-space:nowrap}`,
    `.badge-remote{background:var(--surface-2);color:var(--blue)}`,
    `.badge-model{background:rgba(139,92,246,.1);color:#a78bfa;font-family:var(--mono)}`,
    `.exec-executing{background:rgba(52,211,153,.15);color:var(--green);animation:exec-pulse 2s ease-in-out infinite}`,
    `.exec-task{background:rgba(96,165,250,.15);color:var(--blue);animation:exec-pulse 2s ease-in-out infinite}`,
    `.exec-idle{background:rgba(251,191,36,.1);color:var(--yellow)}`,
    `.exec-queued{background:rgba(34,211,238,.1);color:var(--cyan)}`,
    `.exec-offline{background:var(--surface-2);color:var(--text-dim)}`,
    `.exec-disabled{background:rgba(220,38,38,.12);color:var(--red,#ef4444)}`,
    `.td-queue-depth .qd-zero{color:var(--text-dim)}`,
    `.td-queue-depth.qd-nonzero{font-weight:600}`,
    `.td-queue-depth .qd-msgs{color:var(--cyan)}`,
    `.td-queue-depth .qd-tasks{color:var(--blue);margin-left:6px}`,
    `tr[data-disabled="true"] .ap-name{opacity:.55}`,
    `@keyframes exec-pulse{0%,100%{opacity:1}50%{opacity:.6}}`,
    `.ap-empty{padding:2rem;text-align:center;color:var(--text-dim);font-size:12px}`,

    // --- Light theme tweaks for hardcoded rgba/colors ---
    `[data-theme="light"] .msg-md code{background:rgba(0,0,0,.06)}`,
    `[data-theme="light"] .msg-md pre{background:rgba(0,0,0,.04);border-color:var(--border)}`,
    `[data-theme="light"] .msg-md th{background:rgba(0,0,0,.03)}`,
    `[data-theme="light"] .msg-row.from-me .msg-bubble{background:rgba(99,102,241,.08);border-color:rgba(99,102,241,.2)}`,
    `[data-theme="light"] .status-badge.connected{background:rgba(5,150,105,.08)}`,
    `[data-theme="light"] .status-badge.disconnected{background:rgba(220,38,38,.08)}`,
    `[data-theme="light"] .badge-apple-container{background:rgba(37,99,235,.08)}`,
    `[data-theme="light"] .badge-docker{background:rgba(5,150,105,.08)}`,
    `[data-theme="light"] .badge-cursor-sdk{background:rgba(217,119,6,.1)}`,
    `[data-theme="light"] .badge-admin{background:rgba(124,58,237,.08);color:#7c3aed}`,
    `[data-theme="light"] .badge-model{background:rgba(124,58,237,.08);color:#7c3aed}`,
    `[data-theme="light"] .exec-executing{background:rgba(5,150,105,.1)}`,
    `[data-theme="light"] .exec-task{background:rgba(37,99,235,.1)}`,
    `[data-theme="light"] .exec-idle{background:rgba(217,119,6,.08)}`,
    `[data-theme="light"] .exec-queued{background:rgba(8,145,178,.08)}`,
    `[data-theme="light"] .cmd-palette{box-shadow:0 16px 48px rgba(0,0,0,.15)}`,
    `[data-theme="light"] .cmd-palette-overlay{background:rgba(0,0,0,.25)}`,
    `[data-theme="light"] .modal-overlay{background:rgba(0,0,0,.3)}`,
    `[data-theme="light"] .topo-tooltip{box-shadow:0 4px 12px rgba(0,0,0,.12)}`,
    `.theme-toggle{background:none;border:1px solid transparent;color:var(--text-dim);cursor:pointer;font-size:14px;width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:4px;transition:all .12s}`,
    `.theme-toggle:hover{color:var(--text);background:var(--surface-2);border-color:var(--border)}`,

    // --- Hamburger button (hidden on desktop) ---
    `.hamburger{display:none;background:none;border:1px solid transparent;color:var(--text-dim);cursor:pointer;font-size:18px;width:32px;height:32px;align-items:center;justify-content:center;border-radius:4px;transition:all .12s;flex-shrink:0;-webkit-tap-highlight-color:transparent}`,
    `.hamburger:hover{color:var(--text);background:var(--surface-2);border-color:var(--border)}`,

    // --- Mobile nav overlay backdrop ---
    `.nav-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:89}`,
    `.nav-backdrop.visible{display:block}`,

    // --- Responsive: tablet (<=768px) ---
    `@media(max-width:900px){.stats-grid{grid-template-columns:repeat(2,1fr)}.tables-grid{grid-template-columns:1fr}.system-grid{grid-template-columns:1fr}}`,
    `@media(max-width:768px){`,
    // Header: show hamburger, collapse nav into dropdown
    `.hamburger{display:flex}`,
    `nav#nav-links{display:none;position:fixed;top:40px;left:0;right:0;background:var(--surface);border-bottom:1px solid var(--border);flex-direction:column;padding:8px;gap:2px;z-index:90;box-shadow:0 8px 24px rgba(0,0,0,.3);max-height:calc(100vh - 40px);overflow-y:auto}`,
    `nav#nav-links.open{display:flex}`,
    `.nav-link{padding:10px 12px;font-size:12px;border-radius:6px}`,
    // Workspace: hide sidebar by default, overlay when open
    `.workspace{grid-template-columns:1fr !important;grid-template-areas:"content" !important}`,
    `.workspace .resize-handle{display:none !important}`,
    `.log-sidebar{display:none;position:fixed;top:40px;right:0;bottom:0;width:min(85vw,380px);z-index:80;border-left:1px solid var(--border);box-shadow:-4px 0 16px rgba(0,0,0,.3)}`,
    `.workspace.sidebar-left .log-sidebar{right:auto;left:0;border-left:none;border-right:1px solid var(--border);box-shadow:4px 0 16px rgba(0,0,0,.3)}`,
    `.workspace:not(.sidebar-collapsed) .log-sidebar{display:flex}`,
    `.sidebar-reopen{display:block !important;top:48px}`,
    `.workspace:not(.sidebar-collapsed)~.sidebar-reopen{display:none !important}`,
    // Conversation layout: stack vertically
    `.conv-layout{flex-direction:column}`,
    `.conv-sidebar{width:100%;max-height:35vh;border-right:none;border-bottom:1px solid var(--border)}`,
    `.chat-item{padding:10px 12px}`,
    `.msg-row{max-width:95%}`,
    // Context viewer: stack vertically
    `.ctx-layout{flex-direction:column}`,
    `.ctx-sidebar{width:100%;min-width:0;max-height:30vh;border-right:none;border-bottom:1px solid var(--border);overflow-y:auto}`,
    // Dashboard
    `.dash-layout{flex-direction:column}`,
    `.tables-grid{grid-template-columns:1fr}`,
    // Agent detail
    `.ad-info-grid{grid-template-columns:1fr 1fr}`,
    `.ad-header{flex-wrap:wrap}`,
    // Tasks table
    `.tasks-table td,.tasks-table th{padding:5px 6px;font-size:11px}`,
    `.td-prompt{max-width:140px}`,
    `.td-agent{max-width:80px}`,
    // Agents table
    `.ap-table td,.ap-table th{padding:5px 6px;font-size:11px}`,
    `.ap-filters{flex-direction:column;gap:4px}`,
    `.ap-search{width:100%}`,
    // General
    `.btn{padding:6px 10px;min-height:36px}`,
    `.btn-sm{min-height:28px}`,
    `.filter-btn{padding:4px 8px;min-height:28px}`,
    `.modal{width:95vw;max-width:95vw}`,
    `.cmd-palette{width:95vw}`,
    `.toast-container{left:.5rem;right:.5rem;bottom:.5rem}`,
    `.toast{max-width:100%}`,
    `}`,

    // --- Responsive: small mobile (<=480px) ---
    `@media(max-width:480px){`,
    `.stats-grid{grid-template-columns:1fr}`,
    `.stat-card .value{font-size:16px}`,
    `header{padding:0 .5rem;gap:.5rem}`,
    `.brand{font-size:11px}`,
    `.header-right .status-badge{display:none}`,
    `.ad-info-grid{grid-template-columns:1fr}`,
    `.tasks-stats{flex-wrap:wrap;gap:6px}`,
    `.tasks-title-row{flex-direction:column;align-items:flex-start;gap:6px}`,
    `.ap-title-row{flex-direction:column;align-items:flex-start;gap:6px}`,
    `.message-header{flex-wrap:wrap}`,
    `.message-header .msg-count{margin-left:0}`,
    `.search-filters{flex-direction:column}`,
    `.logs-toolbar{flex-direction:column;align-items:stretch;gap:6px}`,
    `.logs-toolbar-center{max-width:100%;min-width:0}`,
    `.conv-sidebar{max-height:30vh}`,
    `}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Keyboard Shortcuts
// ---------------------------------------------------------------------------

/** Build the keyboard shortcut help modal HTML (appended after workspace). */
function shortcutHelpModal(): string {
  return (
    `<div class="modal-overlay" id="shortcut-help-modal">` +
    `<div class="modal shortcut-modal">` +
    `<div class="shortcut-modal-header">` +
    `<h3>keyboard shortcuts</h3>` +
    `<button class="icon-btn" id="shortcut-close">\u2715</button>` +
    `</div>` +
    `<div class="shortcut-sections">` +
    `<div class="shortcut-section">` +
    `<div class="shortcut-section-title">navigation</div>` +
    shortcutRow('g d', 'Dashboard') +
    shortcutRow('g a', 'Agents') +
    shortcutRow('g t', 'Tasks') +
    shortcutRow('g l', 'Logs') +
    shortcutRow('g c', 'Conversations') +
    shortcutRow('g x', 'Context') +
    shortcutRow('g i', 'IPC Inspector') +
    shortcutRow('g n', 'Network') +
    shortcutRow('g y', 'System') +
    shortcutRow('g e', 'Settings') +
    `</div>` +
    `<div class="shortcut-section">` +
    `<div class="shortcut-section-title">actions</div>` +
    shortcutRow('\u2318 K', 'Command palette') +
    shortcutRow('/', 'Focus search') +
    shortcutRow('Esc', 'Close modal / blur') +
    shortcutRow('?', 'Show this help') +
    shortcutRow('t', 'Toggle theme') +
    `</div>` +
    `</div>` +
    `</div></div>`
  );
}

function shortcutRow(keys: string, description: string): string {
  const keyParts = keys.split(' ');
  const kbdHtml = keyParts
    .map((k) => `<kbd>${escapeHtml(k)}</kbd>`)
    .join('<span class="shortcut-then">then</span>');
  return (
    `<div class="shortcut-row">` +
    `<div class="shortcut-keys">${kbdHtml}</div>` +
    `<div class="shortcut-desc">${escapeHtml(description)}</div>` +
    `</div>`
  );
}

export { shortcutHelpModal };

function commandPaletteHtml(): string {
  return (
    `<div class="cmd-palette-overlay" id="cmd-palette">` +
    `<div class="cmd-palette">` +
    `<div class="cmd-input-wrap">` +
    `<span class="cmd-icon">\u2315</span>` +
    `<input class="cmd-input" id="cmd-input" type="text" placeholder="Search pages, agents, tasks\u2026" autocomplete="off" spellcheck="false">` +
    `<kbd>esc</kbd>` +
    `</div>` +
    `<div class="cmd-results" id="cmd-results"></div>` +
    `<div class="cmd-footer">` +
    `<span><kbd>\u2191</kbd><kbd>\u2193</kbd> navigate</span>` +
    `<span><kbd>\u21b5</kbd> open</span>` +
    `<span><kbd>esc</kbd> close</span>` +
    `</div>` +
    `</div></div>`
  );
}

/** Client-side keyboard shortcut handler script. */
function keyboardShortcutScript(): string {
  // Navigation map: second key -> page path and data-page name
  const navMap: Record<string, [string, string]> = {
    d: ['/', 'dashboard'],
    a: ['/agents-list', 'agents'],
    t: ['/tasks', 'tasks'],
    l: ['/logs', 'logs'],
    c: ['/conversations', 'conversations'],
    x: ['/context', 'context'],
    i: ['/ipc', 'ipc'],
    n: ['/network', 'network'],
    y: ['/system', 'system'],
    e: ['/settings', 'settings'],
  };

  const navEntries = Object.entries(navMap)
    .map(([key, [href, page]]) => `"${key}":["${href}","${page}"]`)
    .join(',');

  return [
    '// ---- Keyboard Shortcuts ----',
    'var __kbGPrefix=false;var __kbGTimer=null;',
    `var __kbNav={${navEntries}};`,
    '',
    'function __kbIsInput(el){',
    '  if(!el||!el.tagName)return false;',
    '  var tag=el.tagName;',
    '  return tag==="INPUT"||tag==="TEXTAREA"||tag==="SELECT"||el.isContentEditable;',
    '}',
    '',
    'function __kbNavigate(href,page){',
    '  history.pushState({page:page},"",href);',
    '  var link=document.querySelector("nav a[data-page=\\""+page+"\\"]");',
    '  if(link)link.click();',
    '}',
    '',
    'function __kbToggleHelp(show){',
    '  var modal=document.getElementById("shortcut-help-modal");',
    '  if(!modal)return;',
    '  if(show===undefined)show=!modal.classList.contains("open");',
    '  if(show)modal.classList.add("open");else modal.classList.remove("open");',
    '}',
    '',
    'document.addEventListener("keydown",function(e){',
    '  // Cmd+K / Ctrl+K -> command palette (works even in inputs)',
    '  if(e.key==="k"&&(e.metaKey||e.ctrlKey)){',
    '    e.preventDefault();',
    '    if(window.__cmdPalette)window.__cmdPalette.toggle();',
    '    return;',
    '  }',
    '  // Skip when typing in inputs (unless Escape)',
    '  if(e.key==="Escape"){',
    '    __kbGPrefix=false;',
    '    // Close command palette first',
    '    var cmdPal=document.getElementById("cmd-palette");',
    '    if(cmdPal&&cmdPal.classList.contains("open")){',
    '      if(window.__cmdPalette)window.__cmdPalette.close();',
    '      e.preventDefault();return;',
    '    }',
    '    // Close any open modal',
    '    var openModal=document.querySelector(".modal-overlay.open");',
    '    if(openModal){openModal.classList.remove("open");e.preventDefault();return;}',
    '    // Blur focused input',
    '    if(document.activeElement&&__kbIsInput(document.activeElement)){document.activeElement.blur();e.preventDefault();return;}',
    '    return;',
    '  }',
    '  if(__kbIsInput(e.target))return;',
    '  if(e.ctrlKey||e.metaKey||e.altKey)return;',
    '',
    '  // ? -> help modal',
    '  if(e.key==="?"||e.key==="/"){',
    '    if(e.key==="?"){e.preventDefault();__kbToggleHelp();return;}',
    '    // / -> focus search',
    '    e.preventDefault();',
    '    var search=document.querySelector(".ap-search")',
    '      ||document.querySelector("#chat-search")',
    '      ||document.querySelector(".logs-search input")',
    '      ||document.querySelector("#msg-search");',
    '    if(search){search.focus();search.select();}',
    '    return;',
    '  }',
    '',
    '  // t -> toggle theme',
    '  if(e.key==="t"&&!__kbGPrefix){',
    '    e.preventDefault();if(window.__toggleTheme)window.__toggleTheme();return;',
    '  }',
    '',
    '  // g prefix for navigation',
    '  if(e.key==="g"&&!__kbGPrefix){',
    '    __kbGPrefix=true;',
    '    if(__kbGTimer)clearTimeout(__kbGTimer);',
    '    __kbGTimer=setTimeout(function(){__kbGPrefix=false;},800);',
    '    return;',
    '  }',
    '',
    '  if(__kbGPrefix){',
    '    __kbGPrefix=false;',
    '    if(__kbGTimer){clearTimeout(__kbGTimer);__kbGTimer=null;}',
    '    var nav=__kbNav[e.key];',
    '    if(nav){e.preventDefault();__kbNavigate(nav[0],nav[1]);}',
    '    return;',
    '  }',
    '});',
    '',
    '// Close help modal via button',
    'var scClose=document.getElementById("shortcut-close");',
    'if(scClose)scClose.addEventListener("click",function(){__kbToggleHelp(false);});',
    'var scOverlay=document.getElementById("shortcut-help-modal");',
    'if(scOverlay)scOverlay.addEventListener("click",function(e){',
    '  if(e.target===scOverlay)__kbToggleHelp(false);',
    '});',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Command Palette Script
// ---------------------------------------------------------------------------

function commandPaletteScript(): string {
  return [
    '// ---- Command Palette ----',
    'window.__cmdPalette=(function(){',
    '  var overlay=document.getElementById("cmd-palette");',
    '  var input=document.getElementById("cmd-input");',
    '  var resultsEl=document.getElementById("cmd-results");',
    '  if(!overlay||!input||!resultsEl)return{open:function(){},close:function(){},toggle:function(){}};',
    '',
    '  var selectedIdx=-1;',
    '  var items=[];',
    '  var cachedAgents=null;',
    '  var cachedTasks=null;',
    '',
    '  // Static page entries',
    '  var pages=[',
    '    {type:"page",icon:"\u25a3",label:"Dashboard",hint:"g d",href:"/",page:"dashboard"},',
    '    {type:"page",icon:"\u25a3",label:"Agents",hint:"g a",href:"/agents-list",page:"agents"},',
    '    {type:"page",icon:"\u25a3",label:"Tasks",hint:"g t",href:"/tasks",page:"tasks"},',
    '    {type:"page",icon:"\u25a3",label:"Logs",hint:"g l",href:"/logs",page:"logs"},',
    '    {type:"page",icon:"\u25a3",label:"Conversations",hint:"g c",href:"/conversations",page:"conversations"},',
    '    {type:"page",icon:"\u25a3",label:"Context",hint:"g x",href:"/context",page:"context"},',
    '    {type:"page",icon:"\u25a3",label:"IPC Inspector",hint:"g i",href:"/ipc",page:"ipc"},',
    '    {type:"page",icon:"\u25a3",label:"Network",hint:"g n",href:"/network",page:"network"},',
    '    {type:"page",icon:"\u25a3",label:"System",hint:"g y",href:"/system",page:"system"},',
    '    {type:"page",icon:"\u25a3",label:"Settings",hint:"g e",href:"/settings",page:"settings"}',
    '  ];',
    '',
    '  function fuzzyMatch(query,text){',
    '    var q=query.toLowerCase();',
    '    var t=text.toLowerCase();',
    '    if(t.indexOf(q)!==-1)return{match:true,score:t.indexOf(q)===0?2:1,ranges:[]};',
    '    var qi=0;var ranges=[];var start=-1;',
    '    for(var ti=0;ti<t.length&&qi<q.length;ti++){',
    '      if(t[ti]===q[qi]){',
    '        if(start===-1)start=ti;',
    '        qi++;',
    '      }else if(start!==-1){',
    '        ranges.push([start,ti]);start=-1;',
    '      }',
    '    }',
    '    if(qi<q.length)return{match:false,score:0,ranges:[]};',
    '    if(start!==-1)ranges.push([start,t.length]);',
    '    return{match:true,score:0,ranges:ranges};',
    '  }',
    '',
    '  function highlight(text,query){',
    '    if(!query)return window.__esc(text);',
    '    var q=query.toLowerCase();',
    '    var t=text.toLowerCase();',
    '    var idx=t.indexOf(q);',
    '    if(idx!==-1){',
    '      return window.__esc(text.slice(0,idx))+"<mark>"+window.__esc(text.slice(idx,idx+q.length))+"</mark>"+window.__esc(text.slice(idx+q.length));',
    '    }',
    '    return window.__esc(text);',
    '  }',
    '',
    '  function buildItems(query){',
    '    var all=[];',
    '    // Pages',
    '    pages.forEach(function(p){',
    '      var m=query?fuzzyMatch(query,p.label):{match:true,score:2};',
    '      if(m.match)all.push({type:p.type,icon:p.icon,label:p.label,hint:p.hint,href:p.href,page:p.page,score:m.score+10});',
    '    });',
    '    // Agents',
    '    if(cachedAgents){',
    '      cachedAgents.forEach(function(a){',
    '        var m=query?fuzzyMatch(query,a.name):{match:true,score:1};',
    '        if(m.match)all.push({type:"agent",icon:"\u2b22",label:a.name,hint:a.backend||"",href:"/agents?id="+encodeURIComponent(a.folder),page:"agent-detail",agentId:a.folder,score:m.score+5});',
    '      });',
    '    }',
    '    // Tasks',
    '    if(cachedTasks){',
    '      cachedTasks.forEach(function(t){',
    '        var promptShort=t.prompt.length>50?t.prompt.slice(0,47)+"\u2026":t.prompt;',
    '        var m=query?fuzzyMatch(query,t.prompt)||fuzzyMatch(query,t.group_folder):{match:true,score:0};',
    '        if(m&&m.match)all.push({type:"task",icon:"\u23f0",label:promptShort,hint:t.status,href:"/tasks",page:"tasks",score:m.score});',
    '      });',
    '    }',
    '    // Actions',
    '    var actions=[{type:"action",icon:"\u263E",label:"Toggle theme",hint:"t",action:"theme"}];',
    '    actions.forEach(function(a){',
    '      var m=query?fuzzyMatch(query,a.label):{match:true,score:1};',
    '      if(m.match)all.push({type:a.type,icon:a.icon,label:a.label,hint:a.hint,action:a.action,score:m.score+3});',
    '    });',
    '    // Sort by score descending, then alphabetically',
    '    all.sort(function(a,b){return b.score-a.score||(a.label<b.label?-1:a.label>b.label?1:0);});',
    '    return all.slice(0,20);',
    '  }',
    '',
    '  function render(query){',
    '    items=buildItems(query);',
    '    if(items.length===0){',
    '      resultsEl.innerHTML="<div class=\\"cmd-empty\\">No results found</div>";',
    '      selectedIdx=-1;return;',
    '    }',
    '    selectedIdx=0;',
    '    var groups={page:[],agent:[],task:[],action:[]};',
    '    items.forEach(function(it){(groups[it.type]||(groups[it.type]=[])).push(it);});',
    '    var html="";',
    '    var idx=0;',
    '    var labels={page:"Pages",agent:"Agents",task:"Tasks",action:"Actions"};',
    '    ["page","agent","task","action"].forEach(function(g){',
    '      if(!groups[g]||!groups[g].length)return;',
    '      html+="<div class=\\"cmd-group-label\\">"+labels[g]+"</div>";',
    '      groups[g].forEach(function(it){',
    '        var sel=idx===selectedIdx?" selected":"";',
    '        html+="<div class=\\"cmd-item"+sel+"\\" data-cmd-idx=\\""+idx+"\\">"',
    '          +"<span class=\\"cmd-item-icon\\">"+it.icon+"</span>"',
    '          +"<span class=\\"cmd-item-label\\">"+highlight(it.label,query)+"</span>"',
    '          +"<span class=\\"cmd-item-hint\\">"+window.__esc(it.hint)+"</span>"',
    '          +"</div>";',
    '        idx++;',
    '      });',
    '    });',
    '    resultsEl.innerHTML=html;',
    '  }',
    '',
    '  function selectItem(idx){',
    '    var prev=resultsEl.querySelector(".cmd-item.selected");',
    '    if(prev)prev.classList.remove("selected");',
    '    selectedIdx=idx;',
    '    var el=resultsEl.querySelector("[data-cmd-idx=\\""+idx+"\\"]");',
    '    if(el){el.classList.add("selected");el.scrollIntoView({block:"nearest"});}',
    '  }',
    '',
    '  function executeItem(idx){',
    '    var item=items[idx];if(!item)return;',
    '    closePalette();',
    '    if(item.action==="theme"&&window.__toggleTheme){window.__toggleTheme();return;}',
    '    if(item.page&&item.href){',
    '      history.pushState({page:item.page},"",item.href);',
    '      var link=document.querySelector("nav a[data-page=\\""+item.page+"\\"]");',
    '      if(link)link.click();',
    '      else{var ev=new PopStateEvent("popstate",{state:{page:item.page}});window.dispatchEvent(ev);}',
    '    }',
    '  }',
    '',
    '  function openPalette(){',
    '    cachedAgents=null;cachedTasks=null;',
    '    // Fetch agents and tasks in parallel',
    '    fetch("/api/agents").then(function(r){return r.json();}).then(function(d){cachedAgents=d;render(input.value);}).catch(function(){});',
    '    fetch("/api/tasks").then(function(r){return r.json();}).then(function(d){cachedTasks=d;render(input.value);}).catch(function(){});',
    '    overlay.classList.add("open");',
    '    input.value="";',
    '    render("");',
    '    setTimeout(function(){input.focus();},10);',
    '  }',
    '',
    '  function closePalette(){',
    '    overlay.classList.remove("open");',
    '    input.blur();',
    '  }',
    '',
    '  function toggle(){',
    '    if(overlay.classList.contains("open"))closePalette();else openPalette();',
    '  }',
    '',
    '  // Input handler',
    '  input.addEventListener("input",function(){render(input.value);});',
    '',
    '  // Keyboard navigation inside palette',
    '  input.addEventListener("keydown",function(e){',
    '    if(e.key==="ArrowDown"){',
    '      e.preventDefault();',
    '      if(selectedIdx<items.length-1)selectItem(selectedIdx+1);',
    '    }else if(e.key==="ArrowUp"){',
    '      e.preventDefault();',
    '      if(selectedIdx>0)selectItem(selectedIdx-1);',
    '    }else if(e.key==="Enter"){',
    '      e.preventDefault();',
    '      if(selectedIdx>=0)executeItem(selectedIdx);',
    '    }',
    '  });',
    '',
    '  // Click on results',
    '  resultsEl.addEventListener("click",function(e){',
    '    var el=e.target.closest("[data-cmd-idx]");',
    '    if(el)executeItem(parseInt(el.getAttribute("data-cmd-idx"),10));',
    '  });',
    '',
    '  // Click overlay to close',
    '  overlay.addEventListener("click",function(e){',
    '    if(e.target===overlay)closePalette();',
    '  });',
    '',
    '  return{open:openPalette,close:closePalette,toggle:toggle};',
    '})();',
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

  parts.push('window.addEventListener("popstate",function(e){');
  parts.push(
    '  if(window.__cleanup){window.__cleanup();window.__cleanup=null;}',
  );
  parts.push(
    '  location.href=location.pathname+location.search+location.hash;',
  );
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

  // ---- Theme toggle ----
  parts.push('(function(){');
  parts.push('  var themeBtn=document.getElementById("btn-theme-toggle");');
  parts.push(
    '  function getTheme(){return document.documentElement.getAttribute("data-theme")||"dark";}',
  );
  parts.push('  function updateThemeToggle(t){');
  parts.push('    if(!themeBtn)return;');
  parts.push('    themeBtn.textContent=t==="light"?"\\u2600":"\\u263E";');
  parts.push(
    '    themeBtn.title=t==="light"?"Switch to dark mode":"Switch to light mode";',
  );
  parts.push(
    '    themeBtn.setAttribute("aria-label",t==="light"?"Toggle theme: light":"Toggle theme: dark");',
  );
  parts.push(
    '    themeBtn.setAttribute("aria-pressed",t==="light"?"true":"false");',
  );
  parts.push('  }');
  parts.push('  function setTheme(t){');
  parts.push(
    '    if(t==="light"){document.documentElement.setAttribute("data-theme","light");}',
  );
  parts.push(
    '    else{document.documentElement.removeAttribute("data-theme");}',
  );
  parts.push('    try{localStorage.setItem("omniclaw_theme",t)}catch(e){}');
  parts.push('    updateThemeToggle(t);');
  parts.push('  }');
  parts.push('  updateThemeToggle(getTheme());');
  parts.push(
    '  if(themeBtn)themeBtn.addEventListener("click",function(){setTheme(getTheme()==="dark"?"light":"dark");});',
  );
  parts.push(
    '  window.__toggleTheme=function(){setTheme(getTheme()==="dark"?"light":"dark");};',
  );
  parts.push('})();');

  // ---- Mobile hamburger menu ----
  parts.push('(function(){');
  parts.push('  var hamburger=document.getElementById("btn-hamburger");');
  parts.push('  var nav=document.getElementById("nav-links");');
  parts.push('  var backdrop=document.getElementById("nav-backdrop");');
  parts.push('  if(!hamburger||!nav)return;');
  parts.push(
    '  function closeNav(){nav.classList.remove("open");backdrop.classList.remove("visible");hamburger.setAttribute("aria-expanded","false");}',
  );
  parts.push(
    '  function openNav(){nav.classList.add("open");backdrop.classList.add("visible");hamburger.setAttribute("aria-expanded","true");}',
  );
  parts.push('  hamburger.addEventListener("click",function(){');
  parts.push(
    '    if(nav.classList.contains("open")){closeNav();}else{openNav();}',
  );
  parts.push('  });');
  parts.push('  backdrop.addEventListener("click",closeNav);');
  parts.push('  nav.addEventListener("click",function(e){');
  parts.push('    if(e.target.closest(".nav-link"))closeNav();');
  parts.push('  });');
  // Close nav on resize back to desktop
  parts.push('  window.addEventListener("resize",function(){');
  parts.push('    if(window.innerWidth>768)closeNav();');
  parts.push('  });');
  parts.push('})();');

  // Also auto-collapse sidebar on mobile on first load
  parts.push('(function(){');
  parts.push('  if(window.innerWidth<=768&&workspace&&prefs.collapsed==null){');
  parts.push('    workspace.classList.add("sidebar-collapsed");');
  parts.push('  }');
  parts.push('})();');

  // ---- Toast helper (used by multiple pages) ----
  parts.push('(function(){');
  parts.push(
    'var TOAST_ICONS={success:"\\u2713",error:"\\u2717",warning:"\\u26a0",info:"\\u2139"};',
  );
  parts.push('var TOAST_MAX=5;');
  parts.push('var container=document.getElementById("toast-container");');
  parts.push('window.__toast=function(msg,type,durationMs){');
  parts.push('  if(!container)return;');
  parts.push('  type=type||"success";');
  parts.push('  durationMs=durationMs||5000;');
  parts.push('  var el=document.createElement("div");');
  parts.push('  el.className="toast "+type;');
  parts.push('  el.setAttribute("role","alert");');
  parts.push(
    '  var icon=document.createElement("span");icon.className="toast-icon";icon.textContent=TOAST_ICONS[type]||TOAST_ICONS.info;',
  );
  parts.push(
    '  var msgEl=document.createElement("span");msgEl.className="toast-msg";msgEl.textContent=msg;',
  );
  parts.push(
    '  var close=document.createElement("button");close.className="toast-close";close.textContent="\\u2715";close.setAttribute("aria-label","Dismiss");',
  );
  parts.push(
    '  el.appendChild(icon);el.appendChild(msgEl);el.appendChild(close);',
  );
  parts.push('  container.appendChild(el);');
  parts.push('  function dismiss(){');
  parts.push('    if(el.classList.contains("removing"))return;');
  parts.push('    el.classList.add("removing");');
  parts.push(
    '    el.addEventListener("animationend",function(){el.remove();});',
  );
  parts.push('  }');
  parts.push('  close.addEventListener("click",dismiss);');
  parts.push('  var timer=setTimeout(dismiss,durationMs);');
  parts.push(
    '  el.addEventListener("mouseenter",function(){clearTimeout(timer);});',
  );
  parts.push(
    '  el.addEventListener("mouseleave",function(){timer=setTimeout(dismiss,2000);});',
  );
  parts.push(
    '  while(container.children.length>TOAST_MAX){container.firstElementChild.remove();}',
  );
  parts.push('};');
  parts.push('})();');

  // ---- Command Palette ----
  parts.push(commandPaletteScript());

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
  parts.push('        return "<div class=\\"task-run-row "+cls+"\\">"');
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
  parts.push(
    'window.__sanitizeUrl=function(url){if(!url)return"";var v=String(url).trim();if(!v)return"";if(v[0]==="#"||v[0]==="/")return v;try{var p=new URL(v,window.location.origin).protocol.toLowerCase();if(p==="http:"||p==="https:"||p==="mailto:"||p==="tel:")return v;}catch{}return"";};',
  );
  parts.push(
    'window.__sanitizeHtml=function(html){if(!html)return"";var allowed={A:["href","title"],BLOCKQUOTE:[],BR:[],CODE:[],DEL:[],EM:[],H1:[],H2:[],H3:[],H4:[],H5:[],H6:[],HR:[],LI:[],OL:[],P:[],PRE:[],STRONG:[],TABLE:[],TBODY:[],TD:[],TH:[],THEAD:[],TR:[],UL:[]};var blocked={BUTTON:1,EMBED:1,FORM:1,IFRAME:1,IMG:1,INPUT:1,LINK:1,MATH:1,META:1,OBJECT:1,SCRIPT:1,SELECT:1,STYLE:1,SVG:1,TEXTAREA:1,VIDEO:1};var t=document.createElement("template");t.innerHTML=html;function walk(node){Array.from(node.childNodes).forEach(function(child){if(child.nodeType===Node.COMMENT_NODE){child.remove();return;}if(child.nodeType!==Node.ELEMENT_NODE)return;var tag=child.tagName.toUpperCase();if(blocked[tag]){child.remove();return;}if(!allowed[tag]){var frag=document.createDocumentFragment();while(child.firstChild)frag.appendChild(child.firstChild);walk(frag);child.replaceWith(frag);return;}Array.from(child.attributes).forEach(function(attr){var name=attr.name.toLowerCase();if(allowed[tag].indexOf(attr.name)===-1&&allowed[tag].indexOf(name)===-1)child.removeAttribute(attr.name);});if(tag==="A"){var href=window.__sanitizeUrl(child.getAttribute("href")||"");if(!href){child.removeAttribute("href");}else{child.setAttribute("href",href);child.setAttribute("rel","noopener noreferrer");child.setAttribute("target","_blank");}}walk(child);});}walk(t.content);return t.innerHTML;};',
  );

  // ---- Keyboard shortcuts ----
  parts.push(keyboardShortcutScript());

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
