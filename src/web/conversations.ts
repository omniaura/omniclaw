import type { WebStateProvider } from './types.js';
import { renderShell, escapeHtml } from './shared.js';
import { allPageScripts } from './page-scripts.js';

/** Render conversations content (no shell). */
export function renderConversationsContent(state: WebStateProvider): string {
  const chats = state.getChats();

  const chatListItems = chats
    .map((c) => {
      const lastTime = c.last_message_time
        ? new Date(c.last_message_time).toLocaleString()
        : '\u2014';
      return (
        `<div class="chat-item" data-jid="${escapeHtml(c.jid)}" tabindex="0">` +
        `<div class="chat-name">${escapeHtml(c.name || c.jid)}</div>` +
        `<div class="chat-meta">${escapeHtml(c.jid)}</div>` +
        `<div class="chat-meta">${lastTime}</div>` +
        `</div>`
      );
    })
    .join('\n');

  return (
    `<div data-init="window.__initPage && window.__initPage('conversations')">` +
    `<div class="conv-layout">` +
    `<aside class="conv-sidebar">` +
    `<div class="conv-sidebar-header">` +
    `<div class="conv-search-tabs">` +
    `<button class="conv-tab active" id="tab-filter" data-conv-tab="filter">filter</button>` +
    `<button class="conv-tab" id="tab-search" data-conv-tab="search">search</button>` +
    `</div>` +
    `<div id="filter-input-wrap"><input id="chat-search" type="text" placeholder="filter chats\u2026"></div>` +
    `<div id="search-input-wrap" style="display:none">` +
    `<input id="msg-search" type="text" placeholder="search messages\u2026">` +
    `</div>` +
    `</div>` +
    `<div class="chat-count" id="chat-count">${chats.length} chat${chats.length !== 1 ? 's' : ''}</div>` +
    `<div class="chat-list" id="chat-list">${chatListItems || '<div class="loading">No chats found</div>'}</div>` +
    `<div class="search-results" id="search-results" style="display:none"></div>` +
    `</aside>` +
    `<main class="conv-content" id="conv-content">` +
    `<div class="conv-empty" id="conv-empty">Select a conversation to view messages</div>` +
    `</main>` +
    `</div></div>`
  );
}

/** Full conversations page with shell. */
export function renderConversations(state: WebStateProvider): string {
  return renderShell(
    '/conversations',
    'Conversations',
    renderConversationsContent(state),
    allPageScripts(),
  );
}
