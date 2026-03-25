import { createStore, reconcile } from 'solid-js/store';

export interface AgentStatus {
  id: string;
  name: string;
  folder: string;
  backend: string;
  agentRuntime: string;
  isAdmin: boolean;
  channels: Array<{
    jid: string;
    displayName: string;
  }>;
}

interface AgentsState {
  list: AgentStatus[];
}

const [agents, setAgents] = createStore<AgentsState>({ list: [] });

export { agents };

export function updateAgents(data: AgentStatus[]) {
  setAgents('list', reconcile(data));
}
