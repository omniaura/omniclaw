import type { WebStateProvider } from './types.js';
import { renderShell } from './shared.js';
import { allPageScripts } from './page-scripts.js';
import { buildAgentChannelData, renderAgentGroups } from './agent-channels.js';
import type { RemotePeerAgents } from '../discovery/types.js';

/** Render context viewer content (no shell). */
export function renderContextViewerContent(
  state: WebStateProvider,
  remotePeers: RemotePeerAgents[] = [],
): string {
  const agentData = buildAgentChannelData(state, remotePeers).filter(
    (agent) => !!agent.remoteInstanceId,
  );
  const localAgentData = buildAgentChannelData(state);
  const sidebarHtml = renderAgentGroups(agentData, {
    includeContextAttrs: true,
  });
  const localSidebarHtml = renderAgentGroups(localAgentData, {
    includeContextAttrs: true,
  });

  return (
    '<div data-init="window.__initPage && window.__initPage(\'context\')">' +
    '<div class="ctx-layout">' +
    '<aside class="ctx-sidebar">' +
    '<div class="ctx-sidebar-title">agents &amp; channels</div>' +
    localSidebarHtml +
    '<div class="ctx-sidebar-title" style="margin-top:1rem">remote agents</div>' +
    '<div id="remote-agent-groups" style="display:flex;flex-direction:column;gap:0.5rem">' +
    (sidebarHtml ||
      '<div class="empty-state" style="padding:1rem;font-size:0.85rem">Trusted remote agents will appear here.</div>') +
    '</div>' +
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
  return renderContextViewerWithRemote(state, []);
}

export function renderContextViewerWithRemote(
  state: WebStateProvider,
  remotePeers: RemotePeerAgents[],
): string {
  return renderShell(
    '/context',
    'Context',
    renderContextViewerContent(state, remotePeers),
    allPageScripts(),
  );
}
