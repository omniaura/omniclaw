import { For, Show } from 'solid-js';
import type { MessageInfo } from '~/lib/api';

const MAX_TEXT_LENGTH = 2000;

function isFromMe(msg: MessageInfo): boolean {
  return msg.sender === 'me' || msg.sender === 'bot';
}

export default function MessageList(props: {
  chatJid: string | null;
  chatName: string;
  messages: MessageInfo[];
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
            {props.messages.length} msg{props.messages.length !== 1 ? 's' : ''}
          </span>
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
            Loading\u2026
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
              when={props.messages.length > 0}
              fallback={
                <div class="text-text-dim text-xs text-center py-4">
                  No messages
                </div>
              }
            >
              <For each={props.messages}>
                {(msg) => {
                  const fromMe = isFromMe(msg);
                  const displayText = () => {
                    const text = msg.content || '';
                    return text.length > MAX_TEXT_LENGTH
                      ? text.slice(0, MAX_TEXT_LENGTH) + '\u2026 [truncated]'
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
