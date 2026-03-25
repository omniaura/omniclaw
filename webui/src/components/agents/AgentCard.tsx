import { Show } from 'solid-js';
import { A } from '@solidjs/router';

import Badge from '~/components/shared/Badge';
import type { AgentChannelData } from '~/lib/api';

interface AgentCardProps {
  agent: AgentChannelData;
  taskCount: number;
}

function backendVariant(backend: string) {
  if (backend === 'apple-container') return 'apple-container' as const;
  if (backend === 'docker') return 'docker' as const;
  return 'default' as const;
}

function avatarUrl(agent: AgentChannelData): string | null {
  if (!agent.avatarUrl) return null;
  if (agent.remoteInstanceId) {
    return `/api/discovery/peers/${encodeURIComponent(agent.remoteInstanceId)}/agents/${encodeURIComponent(agent.id.split(':').slice(1).join(':'))}/avatar/image`;
  }
  return `/api/agents/${encodeURIComponent(agent.id)}/avatar/image`;
}

export default function AgentCard(props: AgentCardProps) {
  const src = () => avatarUrl(props.agent);
  const initial = () => props.agent.name.charAt(0).toUpperCase();
  const detailHref = () => `/agents/${encodeURIComponent(props.agent.id)}`;

  return (
    <tr class="border-b border-border hover:bg-surface-2/50 transition-colors">
      <td class="px-3 py-2">
        <A href={detailHref()} class="flex items-center gap-2 text-text hover:text-accent-hover transition-colors">
          <span class="flex-shrink-0 w-7 h-7 rounded-full bg-surface-2 flex items-center justify-center overflow-hidden text-xs font-medium text-text-dim">
            <Show when={src()} fallback={initial()}>
              <img
                src={src()!}
                alt={props.agent.name}
                class="w-full h-full object-cover"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                  (e.currentTarget.nextElementSibling as HTMLElement | null)?.style.setProperty('display', 'flex');
                }}
              />
              <span class="hidden items-center justify-center w-full h-full">{initial()}</span>
            </Show>
          </span>
          <span class="font-medium">{props.agent.name}</span>
        </A>
      </td>
      <td class="px-3 py-2">
        <Badge variant={backendVariant(props.agent.backend)}>{props.agent.backend}</Badge>
      </td>
      <td class="px-3 py-2">
        <Badge>{props.agent.agentRuntime}</Badge>
      </td>
      <td class="px-3 py-2 text-center">{props.agent.channels.length}</td>
      <td class="px-3 py-2 text-center">{props.taskCount}</td>
      <td class="px-3 py-2">
        <div class="flex gap-1 flex-wrap">
          <Show when={props.agent.isAdmin}>
            <Badge variant="admin">admin</Badge>
          </Show>
          <Show when={props.agent.remoteInstanceId}>
            <Badge variant="remote">{props.agent.remoteInstanceName || 'remote'}</Badge>
          </Show>
        </div>
      </td>
    </tr>
  );
}
