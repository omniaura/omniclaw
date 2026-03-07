import type { WebStateProvider } from './types.js';
import { renderShell } from './shared.js';
import { allPageScripts } from './page-scripts.js';

/** Render context viewer content (no shell). */
export function renderContextViewerContent(state: WebStateProvider): string {
  const agents = Object.values(state.getAgents());
  const subs = state.getChannelSubscriptions();
  const chats = state.getChats();

  const chatNameMap: Record<string, string> = {};
  for (const c of chats) {
    if (c.name) chatNameMap[c.jid] = c.name;
  }

  function channelDisplayName(jid: string, channelFolder?: string): string {
    if (chatNameMap[jid]) return chatNameMap[jid];
    if (channelFolder) {
      const lastSeg = channelFolder.split('/').pop();
      if (lastSeg) return '#' + lastSeg;
    }
    return jid;
  }

  const agentData = agents.map((a) => {
    const channels: Array<{
      jid: string;
      displayName: string;
      channelFolder?: string;
      categoryFolder?: string;
    }> = [];
    for (const [jid, subList] of Object.entries(subs)) {
      const sub = subList.find((s) => s.agentId === a.id);
      if (sub) {
        channels.push({
          jid,
          displayName: channelDisplayName(jid, sub.channelFolder),
          channelFolder: sub.channelFolder,
          categoryFolder: sub.categoryFolder,
        });
      }
    }
    return {
      id: a.id,
      name: a.name,
      folder: a.folder,
      serverFolder: a.serverFolder,
      agentContextFolder: a.agentContextFolder,
      channels,
    };
  });

  const sidebarHtml = agentData
    .map(
      (a) =>
        '<div class="agent-group" data-agent-id="' +
        esc(a.id) +
        '">' +
        '<div class="agent-header" data-toggle-agent>' +
        '<span class="chevron">&#9654;</span>' +
        '<span class="agent-name">' +
        esc(a.name) +
        '</span>' +
        '<span class="channel-count">' +
        a.channels.length +
        '</span>' +
        '</div>' +
        '<div class="channel-list">' +
        a.channels
          .map(
            (ch) =>
              '<div class="channel-item"' +
              ' data-agent-id="' +
              esc(a.id) +
              '"' +
              ' data-jid="' +
              esc(ch.jid) +
              '"' +
              ' data-folder="' +
              esc(a.folder) +
              '"' +
              ' data-server-folder="' +
              esc(a.serverFolder || '') +
              '"' +
              ' data-agent-context-folder="' +
              esc(a.agentContextFolder || '') +
              '"' +
              ' data-channel-folder="' +
              esc(ch.channelFolder || '') +
              '"' +
              ' data-category-folder="' +
              esc(ch.categoryFolder || '') +
              '"' +
              ' data-select-channel>' +
              '<span class="ch-name">' +
              esc(ch.displayName) +
              '</span>' +
              '<span class="ch-jid">' +
              esc(ch.jid) +
              '</span>' +
              '</div>',
          )
          .join('') +
        '</div></div>',
    )
    .join('');

  return (
    '<div data-init="window.__initPage && window.__initPage(\'context\')">' +
    '<div class="ctx-layout">' +
    '<aside class="ctx-sidebar">' +
    '<div class="ctx-sidebar-title">agents &amp; channels</div>' +
    sidebarHtml +
    '</aside>' +
    '<div class="ctx-content">' +
    '<div id="ctx-empty" class="empty-state">' +
    '<div class="icon">&#128196;</div>' +
    '<div class="label">Select a channel to view its context layers</div>' +
    '<div class="hint">Click an agent, then choose a channel</div>' +
    '</div>' +
    '<div id="editor-view" style="display:none;flex:1;flex-direction:column;overflow:hidden">' +
    '<div class="ctx-header"><div>' +
    '<div class="title" id="ctx-title"></div>' +
    '<div class="subtitle" id="ctx-subtitle"></div>' +
    '</div></div>' +
    '<div class="layer-tabs" id="layer-tabs">' +
    '<div class="layer-tab active" data-layer="channel" data-switch-layer><span class="dot" id="dot-channel"></span>Channel</div>' +
    '<div class="layer-tab" data-layer="category" data-switch-layer><span class="dot" id="dot-category"></span>Category</div>' +
    '<div class="layer-tab" data-layer="server" data-switch-layer><span class="dot" id="dot-server"></span>Server</div>' +
    '<div class="layer-tab" data-layer="agent" data-switch-layer><span class="dot" id="dot-agent"></span>Agent</div>' +
    '</div>' +
    '<div class="path-display" id="path-display"></div>' +
    '<div class="editor-area">' +
    '<div class="view-toggle">' +
    '<button class="active" data-view="split" data-set-view>Split</button>' +
    '<button data-view="editor" data-set-view>Editor</button>' +
    '<button data-view="preview" data-set-view>Preview</button>' +
    '</div>' +
    '<div class="editor-pane" id="editor-pane"><div id="editor-container"></div></div>' +
    '<div class="preview-pane" id="preview-pane"></div>' +
    '</div>' +
    '<div class="save-bar" id="save-bar">' +
    '<span class="status" id="save-status">No changes</span>' +
    '<button class="btn" id="btn-revert" disabled>Revert</button>' +
    '<button class="btn btn-primary" id="btn-save" disabled>Save</button>' +
    '</div></div></div>' +
    '</div></div>'
  );
}

/** Full context viewer page with shell. */
export function renderContextViewer(state: WebStateProvider): string {
  return renderShell(
    '/context',
    'Context',
    renderContextViewerContent(state),
    allPageScripts(),
  );
}

const esc = (str: string): string =>
  str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
