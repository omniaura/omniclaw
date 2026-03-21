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
    expect(html).toContain(
      '<span class="shortcut-then">then</span>',
    );
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
});
