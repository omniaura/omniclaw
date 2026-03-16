import { describe, expect, it } from 'bun:test';

import {
  escapeHtml,
  renderNav,
  renderNavLinks,
  renderPagePatch,
  renderShell,
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
