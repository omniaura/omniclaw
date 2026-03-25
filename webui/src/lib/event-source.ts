import { createSignal, onCleanup, createContext, useContext } from 'solid-js';
import { isServer } from 'solid-js/web';

import { appendLog, type LogLine } from '~/lib/stores/logs';
import { updateStats, type StatsState } from '~/lib/stores/stats';
import { updateAgents, type AgentStatus } from '~/lib/stores/agents';
import { updateTasks, type TaskState } from '~/lib/stores/tasks';
import { addPeer, removePeer, type PeerInfo } from '~/lib/stores/network';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

interface EventSourceState {
  status: () => ConnectionStatus;
}

const EventSourceContext = createContext<EventSourceState>();

export function useEventSource() {
  const ctx = useContext(EventSourceContext);
  if (!ctx) throw new Error('useEventSource must be used within EventSourceProvider');
  return ctx;
}

const RECONNECT_DELAY_MS = 3000;

/** Parse SSE event data, silently ignoring malformed JSON. */
function onSseEvent<T>(e: Event, handler: (data: T) => void) {
  try {
    handler(JSON.parse((e as MessageEvent).data));
  } catch {
    // ignore parse errors
  }
}

export function createEventSource(): EventSourceState {
  const [status, setStatus] = createSignal<ConnectionStatus>('disconnected');

  if (isServer) {
    return { status };
  }

  let es: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function connect() {
    if (disposed) return;
    setStatus('connecting');

    es = new EventSource('/api/events');

    es.onopen = () => {
      setStatus('connected');
    };

    es.onerror = () => {
      setStatus('disconnected');
      es?.close();
      es = null;
      if (!disposed) {
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      }
    };

    es.addEventListener('agent_status', (e) =>
      onSseEvent<AgentStatus[]>(e, updateAgents),
    );
    es.addEventListener('task_update', (e) =>
      onSseEvent<TaskState[]>(e, updateTasks),
    );
    es.addEventListener('log', (e) =>
      onSseEvent<LogLine>(e, appendLog),
    );
    es.addEventListener('stats', (e) =>
      onSseEvent<Partial<StatsState>>(e, updateStats),
    );
    es.addEventListener('peer_discovered', (e) =>
      onSseEvent<PeerInfo>(e, addPeer),
    );
    es.addEventListener('peer_lost', (e) =>
      onSseEvent<{ instanceId: string }>(e, (d) => removePeer(d.instanceId)),
    );
  }

  connect();

  onCleanup(() => {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    es?.close();
    es = null;
  });

  return { status };
}

export { EventSourceContext };
