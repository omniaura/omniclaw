import { createSignal, createMemo, onMount, For, Show } from 'solid-js';
import type { ChatInfo, MessageInfo } from '~/lib/api';

type TabMode = 'filter' | 'search';

export default function ChatList(props: {
  chats: ChatInfo[];
  selectedJid: string | null;
  initialSearchQuery?: string | null;
  onSelect: (jid: string) => void;
  onSearch: (query: string) => Promise<MessageInfo[]>;
  onSearchQueryChange?: (query: string | null) => void;
}) {
  const hasInitQuery = !!props.initialSearchQuery;
  const [mode, setMode] = createSignal<TabMode>(hasInitQuery ? 'search' : 'filter');
  const [filterText, setFilterText] = createSignal('');
  const [searchText, setSearchText] = createSignal(props.initialSearchQuery ?? '');
  const [searchResults, setSearchResults] = createSignal<MessageInfo[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [searchDone, setSearchDone] = createSignal(false);

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchToken = 0;

  const filteredChats = createMemo(() => {
    const q = filterText().toLowerCase();
    if (!q) return props.chats;
    return props.chats.filter(
      (c) =>
        (c.name || c.jid).toLowerCase().includes(q) ||
        c.jid.toLowerCase().includes(q),
    );
  });

  function doSearch(query: string) {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResults([]);
      setSearchDone(false);
      return;
    }
    searchToken += 1;
    const token = searchToken;
    setSearching(true);
    setSearchDone(false);
    props
      .onSearch(trimmed)
      .then((results) => {
        if (token !== searchToken) return;
        setSearchResults(results);
        setSearchDone(true);
      })
      .catch(() => {
        if (token !== searchToken) return;
        setSearchResults([]);
        setSearchDone(true);
      })
      .finally(() => {
        if (token === searchToken) setSearching(false);
      });
  }

  onMount(() => {
    if (hasInitQuery) doSearch(props.initialSearchQuery!);
  });

  function handleSearchInput(value: string) {
    setSearchText(value);
    props.onSearchQueryChange?.(value.trim() || null);
    if (searchTimer) clearTimeout(searchTimer);
    if (!value.trim()) {
      setSearchResults([]);
      setSearchDone(false);
      return;
    }
    searchTimer = setTimeout(() => doSearch(value), 300);
  }

  function handleSearchKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (searchTimer) clearTimeout(searchTimer);
      doSearch(searchText());
    }
  }

  function handleResultClick(jid: string) {
    setMode('filter');
    props.onSearchQueryChange?.(null);
    props.onSelect(jid);
  }

  function buildSnippet(text: string, query: string): string {
    const lower = text.toLowerCase();
    const ql = query.toLowerCase();
    const idx = lower.indexOf(ql);
    if (idx === -1) return text.length > 120 ? text.slice(0, 117) + '\u2026' : text;
    const start = Math.max(0, idx - 40);
    const end = Math.min(text.length, start + 120);
    let snippet = text.slice(start, end);
    if (start > 0) snippet = '\u2026' + snippet;
    if (end < text.length) snippet = snippet + '\u2026';
    return snippet;
  }

  return (
    <aside class="w-64 shrink-0 border-r border-border flex flex-col bg-surface">
      <div class="p-2 border-b border-border">
        <div class="flex mb-1.5">
          <button
            class={`flex-1 py-1 text-[10px] font-mono border border-border cursor-pointer transition-all rounded-l ${
              mode() === 'filter'
                ? 'bg-accent/10 text-accent border-accent'
                : 'bg-bg text-text-dim'
            }`}
            onClick={() => setMode('filter')}
          >
            filter
          </button>
          <button
            class={`flex-1 py-1 text-[10px] font-mono border border-border border-l-0 cursor-pointer transition-all rounded-r ${
              mode() === 'search'
                ? 'bg-accent/10 text-accent border-accent'
                : 'bg-bg text-text-dim'
            }`}
            onClick={() => setMode('search')}
          >
            search
          </button>
        </div>
        <Show when={mode() === 'filter'}>
          <input
            type="text"
            placeholder="filter chats\u2026"
            class="w-full py-1 px-2 bg-bg border border-border rounded text-text font-mono text-[11px] focus:outline-none focus:border-accent"
            value={filterText()}
            onInput={(e) => setFilterText(e.currentTarget.value)}
          />
        </Show>
        <Show when={mode() === 'search'}>
          <input
            type="text"
            placeholder="search messages\u2026"
            class="w-full py-1 px-2 bg-bg border border-border rounded text-text font-mono text-[11px] focus:outline-none focus:border-accent"
            value={searchText()}
            onInput={(e) => handleSearchInput(e.currentTarget.value)}
            onKeyDown={handleSearchKeyDown}
          />
        </Show>
      </div>

      <Show when={mode() === 'filter'}>
        <div class="text-[10px] text-text-dim px-2.5 py-1.5 border-b border-border">
          {filteredChats().length} chat{filteredChats().length !== 1 ? 's' : ''}
        </div>
        <div class="flex-1 overflow-y-auto">
          <For each={filteredChats()} fallback={<div class="p-3 text-text-dim text-xs">No chats found</div>}>
            {(chat) => (
              <div
                class={`px-2.5 py-2 cursor-pointer border-b border-border transition-colors hover:bg-accent/5 ${
                  props.selectedJid === chat.jid
                    ? 'bg-accent/5 border-l-2 border-l-accent'
                    : ''
                }`}
                tabindex="0"
                onClick={() => props.onSelect(chat.jid)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') props.onSelect(chat.jid);
                }}
              >
                <div class="text-xs font-semibold text-text-bright truncate">{chat.name || chat.jid}</div>
                <div class="text-[10px] text-text-dim truncate">{chat.jid}</div>
                <div class="text-[10px] text-text-dim">
                  {chat.last_message_time
                    ? new Date(chat.last_message_time).toLocaleString()
                    : '\u2014'}
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={mode() === 'search'}>
        <div class="flex-1 overflow-y-auto">
          <Show when={searching()}>
            <div class="text-[10px] text-text-dim px-2.5 py-1.5">searching\u2026</div>
          </Show>
          <Show when={searchDone() && !searching()}>
            <div class="text-[10px] text-text-dim px-2.5 py-1.5">
              {searchResults().length} result{searchResults().length !== 1 ? 's' : ''}
            </div>
          </Show>
          <For each={searchResults()}>
            {(result) => {
              const snippet = () => buildSnippet(result.content || '', searchText());
              return (
                <div
                  class="px-2.5 py-2 cursor-pointer border-b border-border transition-colors hover:bg-accent/5"
                  tabindex="0"
                  role="button"
                  onClick={() => handleResultClick(result.chat_jid)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleResultClick(result.chat_jid);
                    }
                  }}
                >
                  <div class="text-[10px] text-accent font-semibold mb-0.5">
                    {result.sender_name || result.sender || 'Unknown'} in {result.chat_jid}
                  </div>
                  <div class="text-[11px] truncate">{snippet()}</div>
                  <div class="text-[9px] text-text-dim mt-0.5">
                    {new Date(result.timestamp).toLocaleString()}
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </aside>
  );
}
