/**
 * Shared CSS variables and nav bar used across all web UI pages.
 * Keeps the topbar consistent and avoids duplication.
 */

/** Common CSS custom properties (dark theme). */
export const CSS_VARS = [
  '--bg: #0f1117',
  '--surface: #1a1d27',
  '--border: #2a2d3a',
  '--text: #e1e4ed',
  '--text-dim: #8b8fa3',
  '--accent: #6366f1',
  '--green: #22c55e',
  '--yellow: #eab308',
  '--red: #ef4444',
  '--blue: #60a5fa',
].join(';');

/** Common CSS reset + header/nav styles shared across pages. */
export const BASE_CSS = `:root{${CSS_VARS}}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,monospace;background:var(--bg);color:var(--text);line-height:1.5}
header{padding:0.5rem 1.5rem;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:1rem;flex-shrink:0}
header h1{font-size:1.1rem;font-weight:600}
header nav{display:flex;gap:0.25rem;margin-left:0.5rem}
header nav a{color:var(--text-dim);text-decoration:none;font-size:0.8rem;padding:0.2rem 0.5rem;border-radius:4px;transition:all 0.15s}
header nav a:hover{color:var(--text);background:var(--surface)}
header nav a.active{color:var(--accent);background:var(--surface)}
header .ws-status{margin-left:auto;font-size:0.7rem;padding:0.2rem 0.4rem;border-radius:4px;background:var(--surface)}
header .ws-status.connected{color:var(--green)}
header .ws-status.disconnected{color:var(--red)}`;

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard' },
  { href: '/conversations', label: 'Conversations' },
  { href: '/context', label: 'Context' },
  { href: '/ipc', label: 'IPC' },
];

/**
 * Render the shared header with nav links.
 * @param activePath - The current route path (e.g. '/', '/conversations')
 * @param options - Optional: include WebSocket status indicator
 */
export function renderNav(
  activePath: string,
  options?: { wsStatus?: boolean },
): string {
  const links = NAV_ITEMS.map(
    (item) =>
      `<a href="${item.href}"${item.href === activePath ? ' class="active"' : ''}>${item.label}</a>`,
  ).join('');

  const wsEl =
    options?.wsStatus !== false
      ? '<span id="ws-status" class="ws-status disconnected">disconnected</span>'
      : '';

  return `<header><h1>OmniClaw</h1><nav>${links}</nav>${wsEl}</header>`;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
