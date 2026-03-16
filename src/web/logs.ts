/**
 * Logs page — dedicated full-page log viewer with search, filtering, and export.
 * Consumes the existing SSE log stream on the client side.
 * The sidebar logs show a compact view; this page provides full-width viewing,
 * regex search, per-source filtering, and export.
 */

import { renderShell, escapeHtml } from './shared.js';
import { allPageScripts } from './page-scripts.js';
import type { WebStateProvider } from './types.js';

/** Render the logs page content (no shell wrapper — for SPA nav). */
export function renderLogsContent(state: WebStateProvider): string {
  // Gather known agent/source names for the source filter dropdown
  const agents = Object.values(state.getAgents());
  const sourceOptions = agents
    .map(
      (a) =>
        `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`,
    )
    .join('');

  return (
    `<div data-init="window.__initPage && window.__initPage('logs')">` +
    `<div class="logs-page">` +
    // Header toolbar
    `<div class="logs-toolbar">` +
    `<div class="logs-toolbar-left">` +
    `<h2>Logs</h2>` +
    `<span class="logs-line-count" id="logs-line-count">0 lines</span>` +
    `</div>` +
    `<div class="logs-toolbar-center">` +
    // Search input
    `<div class="logs-search">` +
    `<input type="text" id="logs-search-input" placeholder="Search logs (regex supported)…" spellcheck="false" autocomplete="off">` +
    `<label class="logs-search-option"><input type="checkbox" id="logs-regex-toggle"> regex</label>` +
    `</div>` +
    `</div>` +
    `<div class="logs-toolbar-right">` +
    // Level filters
    `<div class="logs-level-filters" id="logs-level-filters">` +
    `<button class="filter-btn active" data-log-level="debug">dbg</button>` +
    `<button class="filter-btn active" data-log-level="info">info</button>` +
    `<button class="filter-btn active" data-log-level="warn">warn</button>` +
    `<button class="filter-btn active" data-log-level="error">err</button>` +
    `</div>` +
    // Source filter
    `<select id="logs-source-filter" class="logs-source-select">` +
    `<option value="">all sources</option>` +
    sourceOptions +
    `</select>` +
    // Actions
    `<button class="btn btn-sm" id="logs-btn-autoscroll" title="Auto-scroll">\u2193 auto</button>` +
    `<button class="btn btn-sm" id="logs-btn-export" title="Export logs as text">export</button>` +
    `<button class="btn btn-sm btn-danger" id="logs-btn-clear" title="Clear all logs">clear</button>` +
    `</div>` +
    `</div>` +
    // Log output area
    `<div class="logs-output" id="logs-output"></div>` +
    // Status bar
    `<div class="logs-status-bar">` +
    `<span id="logs-status-text">Connecting…</span>` +
    `<span id="logs-filter-status"></span>` +
    `</div>` +
    `</div></div>`
  );
}

/** Full logs page with SPA shell. */
export function renderLogs(state: WebStateProvider): string {
  return renderShell(
    '/logs',
    'Logs',
    renderLogsContent(state),
    allPageScripts(),
  );
}
