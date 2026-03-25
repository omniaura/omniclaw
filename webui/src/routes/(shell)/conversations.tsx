import { createSignal, createResource } from 'solid-js';
import { Title } from '@solidjs/meta';
import { useSearchParams } from '@solidjs/router';

import { api, type MessageInfo } from '~/lib/api';
import ChatList from '~/components/conversations/ChatList';
import MessageList from '~/components/conversations/MessageList';

const PAGE_SIZE = 100;
const LOAD_MORE_LIMIT = 500;

/** Extract first string from a search param that may be string | string[]. */
function paramStr(val: string | string[] | undefined): string | null {
  if (Array.isArray(val)) return val[0] ?? null;
  return val ?? null;
}

export default function Conversations() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initChat = paramStr(searchParams.chat);
  const initQuery = paramStr(searchParams.q);
  const [selectedJid, setSelectedJid] = createSignal<string | null>(initChat);
  const [messageLimit, setMessageLimit] = createSignal(PAGE_SIZE);

  const [chats] = createResource(() => api.getChats());

  const [messages, messagesActions] = createResource(
    () => {
      const jid = selectedJid();
      if (!jid) return null;
      return { jid, limit: messageLimit() };
    },
    (params) => {
      if (!params) return [];
      return api.getMessages(params.jid, undefined, params.limit);
    },
  );

  function selectedChatName(): string {
    const jid = selectedJid();
    if (!jid) return '';
    const chat = chats()?.find((c) => c.jid === jid);
    return chat?.name || jid;
  }

  function handleSelectChat(jid: string) {
    if (jid === selectedJid()) return;
    setMessageLimit(PAGE_SIZE);
    setSelectedJid(jid);
    setSearchParams({ chat: jid, q: undefined });
  }

  function handleSearchQueryChange(query: string | null) {
    setSearchParams({
      q: query?.trim() || undefined,
      chat: query ? undefined : selectedJid() || undefined,
    });
  }

  function handleLoadMore() {
    setMessageLimit(LOAD_MORE_LIMIT);
    messagesActions.refetch();
  }

  async function handleSearch(query: string): Promise<MessageInfo[]> {
    return api.searchMessages(query, undefined, 50);
  }

  return (
    <>
      <Title>OmniClaw — Conversations</Title>
      <div class="flex flex-1 min-h-0 overflow-hidden">
        <ChatList
          chats={chats() ?? []}
          selectedJid={selectedJid()}
          initialSearchQuery={initQuery}
          onSelect={handleSelectChat}
          onSearch={handleSearch}
          onSearchQueryChange={handleSearchQueryChange}
        />
        <MessageList
          chatJid={selectedJid()}
          chatName={selectedChatName()}
          messages={messages() ?? []}
          loading={messages.loading}
          hasMore={messageLimit() === PAGE_SIZE && (messages()?.length ?? 0) >= PAGE_SIZE}
          onLoadMore={handleLoadMore}
        />
      </div>
    </>
  );
}
