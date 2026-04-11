import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  Show,
} from 'solid-js';
import { api, type MessageInfo } from '~/lib/api';
import type { LiveMessage } from '~/lib/stores/messages';

const MAX_TEXT_LENGTH = 2000;

function isFromMe(msg: MessageInfo | LiveMessage): boolean {
  return msg.sender === 'me' || msg.sender === 'bot';
}

export default function MessageList(props: {
  chatJid: string | null;
  chatName: string;
  messages: MessageInfo[];
  liveMessages: LiveMessage[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  let containerRef: HTMLDivElement | undefined;

  function scrollToBottom() {
    if (containerRef) {
      containerRef.scrollTop = containerRef.scrollHeight;
    }
  }

  /** Merge loaded messages with live SSE messages, deduplicating by id. */
  const allMessages = createMemo(() => {
    const loaded = props.messages;
    const live = props.liveMessages;
    if (live.length === 0) return loaded;
    const loadedIds = new Set(loaded.map((m) => m.id));
    const newLive = live.filter((m) => !loadedIds.has(m.id));
    if (newLive.length === 0) return loaded;
    return [
      ...loaded,
      ...newLive.map((m) => ({
        ...m,
        chat_jid: m.chat_jid,
        sender_name: m.sender_name,
      })),
    ];
  });

  // Auto-scroll when new live messages arrive
  createEffect(
    on(
      () => props.liveMessages.length,
      () => {
        if (!containerRef) return;
        // Only auto-scroll if user is near the bottom
        const { scrollTop, scrollHeight, clientHeight } = containerRef;
        const nearBottom = scrollHeight - scrollTop - clientHeight < 80;
        if (nearBottom) {
          requestAnimationFrame(scrollToBottom);
        }
      },
    ),
  );

  return (
    <main class="flex-1 flex flex-col min-w-0">
      <Show
        when={props.chatJid}
        fallback={
          <div class="flex-1 flex items-center justify-center text-text-dim text-xs">
            Select a conversation to view messages
          </div>
        }
      >
        <div class="px-3 py-2 border-b border-border flex items-center gap-2 bg-surface shrink-0">
          <h2 class="text-[13px] font-semibold text-text-bright">
            {props.chatName}
          </h2>
          <span class="text-[10px] text-text-dim">{props.chatJid}</span>
          <span class="text-[10px] text-text-dim ml-auto">
            {allMessages().length} msg{allMessages().length !== 1 ? 's' : ''}
            <Show when={props.liveMessages.length > 0}>
              {' '}
              <span class="text-green-400" title="Live messages from SSE">
                +{props.liveMessages.length} live
              </span>
            </Show>
          </span>
          <Show when={allMessages().length > 0}>
            <ExportDropdown chatJid={props.chatJid!} />
          </Show>
        </div>

        <Show when={props.hasMore}>
          <div class="flex justify-center py-2 border-b border-border">
            <button
              class="px-3 py-1 text-[11px] bg-surface-2 border border-border rounded text-text hover:bg-accent/10 hover:border-accent transition-colors"
              onClick={() => props.onLoadMore()}
            >
              Load older
            </button>
          </div>
        </Show>

        <Show when={props.loading}>
          <div class="flex-1 flex items-center justify-center text-text-dim text-xs">
            Loading…
          </div>
        </Show>
        <Show when={!props.loading}>
          <div
            ref={(el) => {
              containerRef = el;
              requestAnimationFrame(scrollToBottom);
            }}
            class="flex-1 overflow-y-auto p-3 flex flex-col gap-2"
          >
            <Show
              when={allMessages().length > 0}
              fallback={
                <div class="text-text-dim text-xs text-center py-4">
                  No messages
                </div>
              }
            >
              <For each={allMessages()}>
                {(msg) => {
                  const fromMe = isFromMe(msg);
                  const displayText = () => {
                    const text = msg.content || '';
                    return text.length > MAX_TEXT_LENGTH
                      ? text.slice(0, MAX_TEXT_LENGTH) + '… [truncated]'
                      : text;
                  };

                  return (
                    <div
                      class={`flex gap-2 max-w-[80%] ${fromMe ? 'self-end flex-row-reverse' : ''}`}
                    >
                      <div
                        class={`border rounded-md px-2.5 py-1.5 min-w-0 ${
                          fromMe
                            ? 'bg-accent/10 border-accent/20'
                            : 'bg-surface border-border'
                        }`}
                      >
                        <div
                          class={`text-[10px] font-semibold mb-0.5 ${
                            fromMe
                              ? 'text-accent-hover text-right'
                              : 'text-accent'
                          }`}
                        >
                          {msg.sender_name || msg.sender || 'Unknown'}
                        </div>
                        <div class="text-xs whitespace-pre-wrap break-words">
                          {displayText()}
                        </div>
                        <div
                          class={`text-[9px] text-text-dim mt-0.5 ${fromMe ? 'text-right' : ''}`}
                        >
                          {new Date(msg.timestamp).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  );
                }}
              </For>
            </Show>
          </div>
        </Show>
      </Show>
    </main>
  );
}

function ExportDropdown(props: { chatJid: string }) {
  const [open, setOpen] = createSignal(false);

  function download(format: 'json' | 'text') {
    const url = api.getExportUrl(props.chatJid, format);
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setOpen(false);
  }

  return (
    <div class="relative">
      <button
        class="px-2 py-0.5 text-[10px] rounded bg-surface-2 border border-border text-text-dim hover:text-text hover:border-accent/40 transition-colors"
        title="Export conversation"
        onClick={() => setOpen(!open())}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      >
        Export
      </button>
      <Show when={open()}>
        <div class="absolute right-0 top-full mt-1 bg-surface border border-border rounded shadow-lg z-10 min-w-[120px]">
          <button
            class="w-full text-left px-3 py-1.5 text-[11px] text-text hover:bg-surface-2 transition-colors"
            onMouseDown={() => download('json')}
          >
            JSON
          </button>
          <button
            class="w-full text-left px-3 py-1.5 text-[11px] text-text hover:bg-surface-2 transition-colors border-t border-border"
            onMouseDown={() => download('text')}
          >
            Plain text
          </button>
        </div>
      </Show>
    </div>
  );
}
