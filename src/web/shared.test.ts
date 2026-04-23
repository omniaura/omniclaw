import { describe, expect, it } from 'bun:test';

import {
  escapeHtml,
  renderNav,
  renderNavLinks,
  renderPagePatch,
  renderShell,
  shortcutHelpModal,
} from './shared.js';

describe('escapeHtml', () => {
  it('escapes the HTML-sensitive characters used by the web UI', () => {
    expect(escapeHtml('&<>"')).toBe('&amp;&lt;&gt;&quot;');
    expect(escapeHtml("it's fine")).toBe("it's fine");
    expect(escapeHtml('')).toBe('');
  });
});

describe('renderNavLinks', () => {
  it('marks only the active path as active and includes datastar navigation hooks', () => {
    const html = renderNavLinks('/tasks');

    expect(html).toContain('href="/tasks"');
    expect(html).toContain('class="nav-link active">Tasks</a>');
    expect(html).toContain("@get('/api/page/' + el.dataset.page)");
    expect(html).not.toContain(
      'href="/" data-nav data-page="dashboard" class="nav-link active"',
    );
  });
});

describe('renderNav', () => {
  it('renders the shell header with the active navigation state', () => {
    const html = renderNav('/network');

    expect(html).toContain('<div class="brand">omniclaw</div>');
    expect(html).toContain('href="/network"');
    expect(html).toContain('class="nav-link active">Network</a>');
    expect(html).toContain('id="ws-status"');
  });
});

describe('renderShell', () => {
  it('renders the persistent SPA shell with escaped title and embedded page scripts', () => {
    const html = renderShell(
      '/context',
      'Context <Viewer> & "Editor"',
      '<section>body</section>',
      {
        context: 'window.contextInit = true;',
        tasks: 'window.tasksInit = true;',
      },
    );

    expect(html).toContain(
      '<title id="page-title">OmniClaw — Context &lt;Viewer&gt; &amp; &quot;Editor&quot;</title>',
    );
    expect(html).toContain('<main id="content"><section>body</section></main>');
    expect(html).toContain(
      "@get('/api/events?channels=logs,stats,agents,tasks')",
    );
    expect(html).toContain(
      'https://cdn.jsdelivr.net/gh/starfederation/datastar@1.0.0-RC.8/bundles/datastar.js',
    );
    expect(html).toContain('window.contextInit = true;');
    expect(html).toContain('window.tasksInit = true;');
    expect(html).toContain('window.__sanitizeHtml=function(html){');
    expect(html).toContain('window.__sanitizeUrl=function(url){');
    expect(html).toContain('class="nav-link active">Context</a>');
  });
});

describe('renderPagePatch', () => {
  it('patches the title, nav, and content for SSE navigation', () => {
    const html = renderPagePatch(
      '/logs',
      'Logs & <Alerts>',
      '<div>patched</div>',
    );

    expect(html).toContain(
      '<title id="page-title">OmniClaw — Logs &amp; &lt;Alerts&gt;</title>',
    );
    expect(html).toContain('<nav id="nav-links">');
    expect(html).toContain('class="nav-link active">Logs</a>');
    expect(html).toContain('<main id="content"><div>patched</div></main>');
  });
});

describe('shortcutHelpModal', () => {
  it('renders the keyboard shortcut help modal overlay', () => {
    const html = shortcutHelpModal();

    expect(html).toContain('id="shortcut-help-modal"');
    expect(html).toContain('class="modal-overlay"');
    expect(html).toContain('keyboard shortcuts');
  });

  it('includes all navigation shortcut keys', () => {
    const html = shortcutHelpModal();
    const pages = [
      'Dashboard',
      'Agents',
      'Tasks',
      'Logs',
      'Conversations',
      'Context',
      'IPC Inspector',
      'Network',
      'System',
      'Settings',
    ];
    for (const page of pages) {
      expect(html).toContain(page);
    }
  });

  it('includes action shortcuts', () => {
    const html = shortcutHelpModal();

    expect(html).toContain('Focus search');
    expect(html).toContain('Close modal');
    expect(html).toContain('Show this help');
  });

  it('renders kbd elements for shortcut keys', () => {
    const html = shortcutHelpModal();

    expect(html).toContain('<kbd>g</kbd>');
    expect(html).toContain('<kbd>d</kbd>');
    expect(html).toContain('<kbd>/</kbd>');
    expect(html).toContain('<kbd>Esc</kbd>');
    expect(html).toContain('<kbd>?</kbd>');
  });

  it('renders "then" separators for multi-key shortcuts', () => {
    const html = shortcutHelpModal();

    // g then d, g then a, etc.
    expect(html).toContain('<span class="shortcut-then">then</span>');
  });

  it('includes the close button', () => {
    const html = shortcutHelpModal();

    expect(html).toContain('id="shortcut-close"');
  });
});

describe('renderShell keyboard shortcuts', () => {
  it('embeds the shortcut help modal in the shell HTML', () => {
    const html = renderShell('/', 'Dashboard', '<div>content</div>', {});

    expect(html).toContain('id="shortcut-help-modal"');
  });

  it('embeds the keyboard shortcut handler script', () => {
    const html = renderShell('/', 'Dashboard', '<div>content</div>', {});

    expect(html).toContain('__kbGPrefix');
    expect(html).toContain('__kbNav');
    expect(html).toContain('__kbNavigate');
    expect(html).toContain('__kbToggleHelp');
  });

  it('includes the navigation key map in the script', () => {
    const html = renderShell('/', 'Dashboard', '<div>content</div>', {});

    expect(html).toContain('"d":["/","dashboard"]');
    expect(html).toContain('"a":["/agents-list","agents"]');
    expect(html).toContain('"t":["/tasks","tasks"]');
    expect(html).toContain('"l":["/logs","logs"]');
    expect(html).toContain('"c":["/conversations","conversations"]');
  });

  it('includes shortcut CSS styles', () => {
    const html = renderShell('/', 'Dashboard', '<div>content</div>', {});

    expect(html).toContain('.shortcut-modal');
    expect(html).toContain('.shortcut-row');
    expect(html).toContain('.shortcut-keys kbd');
  });

  it('includes markdown message styles', () => {
    const html = renderShell('/', 'Dashboard', '<div>content</div>', {});

    expect(html).toContain('.msg-md');
    expect(html).toContain('.msg-md code');
    expect(html).toContain('.msg-md pre');
    expect(html).toContain('.msg-md blockquote');
    expect(html).toContain('.msg-md table');
  });
});

describe('command palette', () => {
  it('embeds the command palette overlay in the shell HTML', () => {
    const html = renderShell('/', 'Dashboard', '<div>content</div>', {});

    expect(html).toContain('id="cmd-palette"');
    expect(html).toContain('class="cmd-palette-overlay"');
    expect(html).toContain('id="cmd-input"');
    expect(html).toContain('id="cmd-results"');
  });

  it('includes the command palette CSS', () => {
    const html = renderShell('/', 'Dashboard', '<div>content</div>', {});

    expect(html).toContain('.cmd-palette-overlay');
    expect(html).toContain('.cmd-palette{');
    expect(html).toContain('.cmd-input');
    expect(html).toContain('.cmd-results');
    expect(html).toContain('.cmd-item');
    expect(html).toContain('.cmd-group-label');
    expect(html).toContain('.cmd-footer');
    expect(html).toContain('@keyframes cmdSlideIn');
  });

  it('embeds the command palette script with core functions', () => {
    const html = renderShell('/', 'Dashboard', '<div>content</div>', {});

    expect(html).toContain('window.__cmdPalette');
    expect(html).toContain('fuzzyMatch');
    expect(html).toContain('openPalette');
    expect(html).toContain('closePalette');
  });

  it('includes Cmd+K handler in keyboard shortcuts', () => {
    const html = renderShell('/', 'Dashboard', '<div>content</div>', {});

    // Should intercept Cmd+K / Ctrl+K
    expect(html).toContain('e.key==="k"');
    expect(html).toContain('e.metaKey||e.ctrlKey');
    expect(html).toContain('window.__cmdPalette');
  });

  it('includes static page entries in the palette script', () => {
    const html = renderShell('/', 'Dashboard', '<div>content</div>', {});

    expect(html).toContain('"Dashboard"');
    expect(html).toContain('"Agents"');
    expect(html).toContain('"Tasks"');
    expect(html).toContain('"Logs"');
    expect(html).toContain('"Conversations"');
    expect(html).toContain('"Context"');
    expect(html).toContain('"IPC Inspector"');
    expect(html).toContain('"Network"');
    expect(html).toContain('"System"');
    expect(html).toContain('"Settings"');
  });

  it('fetches agents and tasks data on palette open', () => {
    const html = renderShell('/', 'Dashboard', '<div>content</div>', {});

    expect(html).toContain('fetch("/api/agents")');
    expect(html).toContain('fetch("/api/tasks")');
  });

  it('renders the input with placeholder text', () => {
    const html = renderShell('/', 'Dashboard', '<div>content</div>', {});

    expect(html).toContain('placeholder="Search pages, agents, tasks\u2026"');
  });

  it('renders keyboard navigation hints in footer', () => {
    const html = renderShell('/', 'Dashboard', '<div>content</div>', {});

    expect(html).toContain('class="cmd-footer"');
    expect(html).toContain('navigate');
    expect(html).toContain('open');
    expect(html).toContain('close');
  });

  it('adds command palette to the shortcut help modal', () => {
    const html = shortcutHelpModal();

    expect(html).toContain('Command palette');
  });

  it('includes toggle theme action in command palette', () => {
    const html = renderShell('/', 'Dashboard', '<div>content</div>', {});

    expect(html).toContain('"Toggle theme"');
    expect(html).toContain('action:"theme"');
    expect(html).toContain('__toggleTheme');
  });
});

describe('dark mode / theme toggle', () => {
  it('includes the theme toggle button in the header', () => {
    const html = renderNav('/');

    expect(html).toContain('id="btn-theme-toggle"');
    expect(html).toContain('class="theme-toggle"');
    expect(html).toContain('aria-label="Toggle theme: dark"');
    expect(html).toContain('aria-pressed="false"');
  });

  it('includes light theme CSS variables', () => {
    const html = renderShell('/', 'Dashboard', '<div>content</div>', {});

    expect(html).toContain('[data-theme="light"]');
    expect(html).toContain('--bg:#f5f5f7');
    expect(html).toContain('--surface:#ffffff');
    expect(html).toContain('--text:#1f2937');
  });

  it('includes theme toggle CSS class', () => {
    const html = renderShell('/', 'Dashboard', '<div>content</div>', {});

    expect(html).toContain('.theme-toggle{');
    expect(html).toContain('.theme-toggle:hover{');
  });

  it('includes light theme overrides for rgba colors', () => {
    const html = renderShell('/', 'Dashboard', '<div>content</div>', {});

    expect(html).toContain('[data-theme="light"] .msg-md code');
    expect(html).toContain('[data-theme="light"] .cmd-palette{');
    expect(html).toContain('[data-theme="light"] .modal-overlay');
  });

  it('includes FOUC prevention script before body content', () => {
    const html = renderShell('/', 'Dashboard', '<div>content</div>', {});

    // Script with data-theme-init attribute should appear before SSE init
    expect(html).toContain('data-theme-init');
    expect(html).toContain('omniclaw_theme');
    expect(html).toContain('prefers-color-scheme:light');

    // FOUC script should come before the SSE connector
    const fouc = html.indexOf('data-theme-init');
    const sse = html.indexOf('sse-init');
    expect(fouc).toBeLessThan(sse);
  });

  it('includes theme toggle script with localStorage persistence', () => {
    const html = renderShell('/', 'Dashboard', '<div>content</div>', {});

    expect(html).toContain('btn-theme-toggle');
    expect(html).toContain('omniclaw_theme');
    expect(html).toContain('window.__toggleTheme');
    expect(html).toContain('try{t=localStorage.getItem("omniclaw_theme")}catch(e){}');
    expect(html).toContain('try{localStorage.setItem("omniclaw_theme",t)}catch(e){}');
    expect(html).toContain('themeBtn.setAttribute("aria-label"');
    expect(html).toContain('themeBtn.setAttribute("aria-pressed"');
  });

  it('adds theme toggle to shortcut help modal', () => {
    const html = shortcutHelpModal();

    expect(html).toContain('Toggle theme');
    expect(html).toContain('<kbd>t</kbd>');
  });

  it('includes t key handler in keyboard shortcuts', () => {
    const html = renderShell('/', 'Dashboard', '<div>content</div>', {});

    // t key should trigger theme toggle
    expect(html).toContain('e.key==="t"');
    expect(html).toContain('window.__toggleTheme');
  });

  it('keeps dark theme as default (no data-theme attribute)', () => {
    const html = renderShell('/', 'Dashboard', '<div>content</div>', {});

    // The html element should NOT have data-theme set by default
    // (FOUC script only sets it if localStorage or prefers-color-scheme says light)
    expect(html).toContain('<html lang="en">');
    expect(html).not.toContain('<html lang="en" data-theme');
  });
});
