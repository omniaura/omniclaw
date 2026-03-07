import type { WebStateProvider } from './types.js';

/**
 * Render a self-contained conversations viewer page.
 * Chat list in left sidebar, message thread on the right.
 * Messages are fetched client-side via /api/messages/:jid for pagination.
 */
export function renderConversations(state: WebStateProvider): string {
  const chats = state.getChats();

  const chatListItems = chats
    .map((c) => {
      const lastTime = c.last_message_time
        ? new Date(c.last_message_time).toLocaleString()
        : '—';
      return `<div class="chat-item" data-jid="${escapeHtml(c.jid)}" tabindex="0">
        <div class="chat-name">${escapeHtml(c.name || c.jid)}</div>
        <div class="chat-meta">${escapeHtml(c.jid)}</div>
        <div class="chat-meta">${lastTime}</div>
      </div>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OmniClaw — Conversations</title>
<style>
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --border: #2a2d3a;
    --text: #e1e4ed;
    --text-dim: #8b8fa3;
    --accent: #6366f1;
    --green: #22c55e;
    --yellow: #eab308;
    --red: #ef4444;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  header {
    padding: 0.75rem 1.5rem;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-shrink: 0;
  }
  header h1 { font-size: 1.25rem; font-weight: 600; }
  header nav { display: flex; gap: 0.5rem; margin-left: 1rem; }
  header nav a {
    color: var(--text-dim);
    text-decoration: none;
    font-size: 0.8rem;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    transition: color 0.15s, background 0.15s;
  }
  header nav a:hover { color: var(--text); background: var(--surface); }
  header nav a.active { color: var(--accent); background: var(--surface); }
  .layout {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  /* Sidebar — chat list */
  .sidebar {
    width: 280px;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    background: var(--surface);
  }
  .sidebar-header {
    padding: 0.75rem;
    border-bottom: 1px solid var(--border);
  }
  .sidebar-header input {
    width: 100%;
    padding: 0.4rem 0.6rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-size: 0.8rem;
  }
  .sidebar-header input:focus { outline: none; border-color: var(--accent); }
  .chat-list {
    flex: 1;
    overflow-y: auto;
  }
  .chat-item {
    padding: 0.6rem 0.75rem;
    cursor: pointer;
    border-bottom: 1px solid var(--border);
    transition: background 0.15s;
  }
  .chat-item:hover { background: rgba(99, 102, 241, 0.08); }
  .chat-item.selected { background: rgba(99, 102, 241, 0.15); border-left: 3px solid var(--accent); }
  .chat-item:focus { outline: 2px solid var(--accent); outline-offset: -2px; }
  .chat-name { font-size: 0.85rem; font-weight: 600; margin-bottom: 0.15rem; }
  .chat-meta { font-size: 0.7rem; color: var(--text-dim); }
  .chat-count {
    font-size: 0.7rem;
    color: var(--text-dim);
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border);
  }
  /* Main content — messages */
  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .content-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-dim);
    font-size: 0.9rem;
  }
  .message-header {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 0.75rem;
    background: var(--surface);
    flex-shrink: 0;
  }
  .message-header h2 { font-size: 0.95rem; font-weight: 600; }
  .message-header .jid-label { font-size: 0.7rem; color: var(--text-dim); }
  .message-header .msg-count { font-size: 0.7rem; color: var(--text-dim); margin-left: auto; }
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .msg-row {
    display: flex;
    gap: 0.5rem;
    max-width: 85%;
  }
  .msg-row.from-me { align-self: flex-end; flex-direction: row-reverse; }
  .msg-bubble {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
    max-width: 100%;
    min-width: 0;
  }
  .msg-row.from-me .msg-bubble {
    background: rgba(99, 102, 241, 0.15);
    border-color: rgba(99, 102, 241, 0.3);
  }
  .msg-sender {
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--accent);
    margin-bottom: 0.15rem;
  }
  .msg-row.from-me .msg-sender { color: #a5b4fc; text-align: right; }
  .msg-text {
    font-size: 0.8rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .msg-time {
    font-size: 0.6rem;
    color: var(--text-dim);
    margin-top: 0.25rem;
  }
  .msg-row.from-me .msg-time { text-align: right; }
  .load-more-bar {
    text-align: center;
    padding: 0.5rem;
    flex-shrink: 0;
  }
  .load-more-bar button {
    padding: 0.3rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface);
    color: var(--text-dim);
    cursor: pointer;
    font-size: 0.75rem;
  }
  .load-more-bar button:hover { border-color: var(--accent); color: var(--text); }
  .load-more-bar button:disabled { opacity: 0.5; cursor: not-allowed; }
  .loading {
    text-align: center;
    padding: 2rem;
    color: var(--text-dim);
    font-size: 0.85rem;
  }
</style>
</head>
<body>
<header>
  <h1>OmniClaw</h1>
  <nav>
    <a href="/">Dashboard</a>
    <a href="/conversations" class="active">Conversations</a>
    <a href="/ipc">IPC</a>
  </nav>
</header>
<div class="layout">
  <aside class="sidebar">
    <div class="sidebar-header">
      <input id="chat-search" type="text" placeholder="Filter chats…">
    </div>
    <div class="chat-count" id="chat-count">${chats.length} chat${chats.length !== 1 ? 's' : ''}</div>
    <div class="chat-list" id="chat-list">
      ${chatListItems || '<div class="loading">No chats found</div>'}
    </div>
  </aside>
  <main class="content" id="content">
    <div class="content-empty" id="empty-state">Select a conversation to view messages</div>
  </main>
</div>

<script>
(function() {
  var chatList = document.getElementById('chat-list');
  var content = document.getElementById('content');
  var emptyState = document.getElementById('empty-state');
  var searchInput = document.getElementById('chat-search');
  var chatCountEl = document.getElementById('chat-count');
  var currentJid = null;
  var messageCache = {};
  var PAGE_SIZE = 100;

  // ---- Chat search/filter ----
  searchInput.addEventListener('input', function() {
    var q = this.value.toLowerCase();
    var items = chatList.querySelectorAll('.chat-item');
    var visible = 0;
    items.forEach(function(item) {
      var name = item.querySelector('.chat-name').textContent.toLowerCase();
      var jid = item.getAttribute('data-jid').toLowerCase();
      var show = name.indexOf(q) !== -1 || jid.indexOf(q) !== -1;
      item.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    chatCountEl.textContent = visible + ' chat' + (visible !== 1 ? 's' : '');
  });

  // ---- Chat selection ----
  chatList.addEventListener('click', function(e) {
    var item = e.target.closest('.chat-item');
    if (!item) return;
    selectChat(item.getAttribute('data-jid'));
  });
  chatList.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      var item = e.target.closest('.chat-item');
      if (item) selectChat(item.getAttribute('data-jid'));
    }
  });

  function selectChat(jid) {
    if (jid === currentJid) return;
    currentJid = jid;

    // Highlight active chat
    chatList.querySelectorAll('.chat-item').forEach(function(el) {
      el.classList.toggle('selected', el.getAttribute('data-jid') === jid);
    });

    // Show loading state
    content.innerHTML = '<div class="loading">Loading messages…</div>';

    loadMessages(jid);
  }

  function loadMessages(jid) {
    fetch('/api/messages/' + encodeURIComponent(jid) + '?limit=' + PAGE_SIZE)
      .then(function(res) {
        if (!res.ok) throw new Error('Failed to load messages');
        return res.json();
      })
      .then(function(messages) {
        if (!Array.isArray(messages)) throw new Error('Invalid messages payload');
        if (currentJid !== jid) return; // stale response
        messageCache[jid] = messages;
        renderMessages(jid, messages);
      })
      .catch(function() {
        if (currentJid !== jid) return;
        content.innerHTML = '<div class="loading">Failed to load messages</div>';
      });
  }

  function renderMessages(jid, messages) {
    // Find chat name from the sidebar
    var chatItem = chatList.querySelector('[data-jid="' + CSS.escape(jid) + '"]');
    var chatName = chatItem ? chatItem.querySelector('.chat-name').textContent : jid;

    var headerHtml = '<div class="message-header">'
      + '<h2>' + escapeHtml(chatName) + '</h2>'
      + '<span class="jid-label">' + escapeHtml(jid) + '</span>'
      + '<span class="msg-count">' + messages.length + ' message' + (messages.length !== 1 ? 's' : '') + '</span>'
      + '</div>';

    var loadMoreHtml = messages.length >= PAGE_SIZE
      ? '<div class="load-more-bar"><button id="btn-load-more">Load older messages</button></div>'
      : '';

    var msgsHtml = '<div class="messages" id="messages-container">';
    if (messages.length === 0) {
      msgsHtml += '<div class="loading">No messages in this conversation</div>';
    } else {
      for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        var isFromMe = m.sender === 'me' || m.sender === 'bot' || m.is_from_me;
        var rowClass = 'msg-row' + (isFromMe ? ' from-me' : '');
        var time = new Date(m.timestamp).toLocaleString();
        var senderDisplay = m.sender_name || m.sender || 'Unknown';
        var text = m.content || '';
        // Truncate very long messages in the view
        var displayText = text.length > 2000 ? text.slice(0, 2000) + '… [truncated]' : text;

        msgsHtml += '<div class="' + rowClass + '">'
          + '<div class="msg-bubble">'
          + '<div class="msg-sender">' + escapeHtml(senderDisplay) + '</div>'
          + '<div class="msg-text">' + escapeHtml(displayText) + '</div>'
          + '<div class="msg-time">' + escapeHtml(time) + '</div>'
          + '</div></div>';
      }
    }
    msgsHtml += '</div>';

    content.innerHTML = headerHtml + loadMoreHtml + msgsHtml;

    // Scroll to bottom (most recent messages)
    var container = document.getElementById('messages-container');
    if (container) container.scrollTop = container.scrollHeight;

    // Load more handler
    var loadMoreBtn = document.getElementById('btn-load-more');
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', function() {
        var oldest = messages[0];
        if (!oldest) return;
        loadMoreBtn.disabled = true;
        loadMoreBtn.textContent = 'Loading…';
        // Fetch messages older than the oldest we have
        // Use since=epoch and limit to get all, then filter client-side
        // (The API uses "since" as a floor, so we pass epoch to get everything up to oldest)
        fetch('/api/messages/' + encodeURIComponent(jid) + '?limit=500')
          .then(function(res) {
            if (!res.ok) throw new Error('Failed to load older messages');
            return res.json();
          })
          .then(function(allMsgs) {
            if (!Array.isArray(allMsgs)) throw new Error('Invalid messages payload');
            if (currentJid !== jid) return;
            messageCache[jid] = allMsgs;
            renderMessages(jid, allMsgs);
          })
          .catch(function() {
            loadMoreBtn.disabled = false;
            loadMoreBtn.textContent = 'Load older messages';
          });
      });
    }
  }

  function escapeHtml(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }
})();
</script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
