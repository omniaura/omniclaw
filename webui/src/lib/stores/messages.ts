import { createStore } from 'solid-js/store';

const MAX_LIVE_MESSAGES = 200;

export interface LiveMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
}

interface MessagesState {
  items: LiveMessage[];
}

const [liveMessages, setLiveMessages] = createStore<MessagesState>({
  items: [],
});

export { liveMessages };

export function appendLiveMessage(msg: LiveMessage) {
  setLiveMessages('items', (prev) => {
    // Deduplicate by chat + id (IDs may be chat-scoped on some platforms)
    if (prev.some((m) => m.chat_jid === msg.chat_jid && m.id === msg.id))
      return prev;
    const next = [...prev, msg];
    if (next.length > MAX_LIVE_MESSAGES) {
      return next.slice(next.length - MAX_LIVE_MESSAGES);
    }
    return next;
  });
}

export function clearLiveMessages() {
  setLiveMessages('items', []);
}
