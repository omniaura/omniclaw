import { Title } from '@solidjs/meta';
import { useSearchParams } from '@solidjs/router';
import {
  createSignal,
  createResource,
  createEffect,
  onMount,
  For,
  Show,
} from 'solid-js';

import { api, type AgentChannelData } from '~/lib/api';
import LayerEditor from '~/components/context/LayerEditor';

type LayerName = 'channel' | 'category' | 'server' | 'agent';

interface SelectedChannel {
  agentId: string;
  agentName: string;
  jid: string;
  displayName: string;
  folder: string;
  serverFolder: string;
  agentContextFolder: string;
  channelFolder: string;
  categoryFolder: string;
}

export default function Context() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [mounted, setMounted] = createSignal(false);
  onMount(() => setMounted(true));
  const [agents] = createResource(mounted, () => api.getAgents());
  const [selected, setSelected] = createSignal<SelectedChannel | null>(null);
  const [expandedAgents, setExpandedAgents] = createSignal<Set<string>>(
    new Set(),
  );

  // Restore selection from URL params once agents load
  createEffect(() => {
    const list = agents();
    if (!list || selected()) return;
    const agentParam = searchParams.agent as string | undefined;
    const channelParam = searchParams.channel as string | undefined;
    if (!agentParam || !channelParam) return;
    const agent = list.find((a) => a.id === agentParam);
    if (!agent) return;
    const channel = agent.channels.find((c) => c.jid === channelParam);
    if (!channel) return;
    setExpandedAgents(new Set([agent.id]));
    setSelected({
      agentId: agent.id,
      agentName: agent.name,
      jid: channel.jid,
      displayName: channel.displayName,
      folder: agent.folder,
      serverFolder: agent.serverFolder ?? '',
      agentContextFolder: agent.agentContextFolder ?? '',
      channelFolder: channel.channelFolder ?? '',
      categoryFolder: channel.categoryFolder ?? '',
    });
  });

  const [layers, { refetch: refetchLayers }] = createResource(
    selected,
    async (sel) => {
      if (!sel) return null;
      return api.getContextLayers({
        folder: sel.folder,
        server_folder: sel.serverFolder,
        agent_context_folder: sel.agentContextFolder,
        channel_folder: sel.channelFolder,
        category_folder: sel.categoryFolder,
      });
    },
  );

  function toggleAgent(agentId: string) {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }

  function selectChannel(
    agent: AgentChannelData,
    channel: AgentChannelData['channels'][0],
  ) {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      next.add(agent.id);
      return next;
    });

    setSelected({
      agentId: agent.id,
      agentName: agent.name,
      jid: channel.jid,
      displayName: channel.displayName,
      folder: agent.folder,
      serverFolder: agent.serverFolder ?? '',
      agentContextFolder: agent.agentContextFolder ?? '',
      channelFolder: channel.channelFolder ?? '',
      categoryFolder: channel.categoryFolder ?? '',
    });

    setSearchParams({ agent: agent.id, channel: channel.jid });
  }

  function handleLayerChange(layer: LayerName) {
    setSearchParams({ layer: layer === 'channel' ? undefined : layer });
  }

  function initialLayer(): LayerName {
    const p = searchParams.layer as string | undefined;
    if (p === 'category' || p === 'server' || p === 'agent') return p;
    return 'channel';
  }

  function isChannelSelected(agentId: string, jid: string): boolean {
    const sel = selected();
    return sel !== null && sel.agentId === agentId && sel.jid === jid;
  }

  return (
    <>
      <Title>OmniClaw — Context</Title>
      <div class="flex h-full min-h-0">
        {/* Sidebar: agent/channel list */}
        <aside class="w-64 shrink-0 border-r border-border bg-surface overflow-y-auto">
          <div class="px-3 py-2 text-xs font-semibold text-text-dim uppercase tracking-wider">
            Agents & Channels
          </div>
          <Show
            when={agents() && agents()!.length > 0}
            fallback={
              <div class="px-3 py-4 text-xs text-text-dim">
                No agents found.
              </div>
            }
          >
            <For each={agents()}>
              {(agent) => (
                <div>
                  <button
                    class="flex items-center gap-1.5 w-full px-3 py-1.5 text-left text-xs hover:bg-surface-2 transition-colors"
                    onClick={() => toggleAgent(agent.id)}
                  >
                    <span
                      class={`text-[10px] text-text-dim transition-transform ${
                        expandedAgents().has(agent.id) ? 'rotate-90' : ''
                      }`}
                    >
                      &#9654;
                    </span>
                    <span class="font-medium text-text truncate">
                      {agent.name}
                    </span>
                    <span class="ml-auto text-text-dim">
                      {agent.channels.length}
                    </span>
                  </button>
                  <Show when={expandedAgents().has(agent.id)}>
                    <div class="pl-5">
                      <For each={agent.channels}>
                        {(channel) => (
                          <button
                            class={`block w-full text-left px-2 py-1 text-xs truncate transition-colors rounded ${
                              isChannelSelected(agent.id, channel.jid)
                                ? 'bg-accent/20 text-accent'
                                : 'text-text-dim hover:text-text hover:bg-surface-2'
                            }`}
                            onClick={() => selectChannel(agent, channel)}
                            title={channel.jid}
                          >
                            {channel.displayName}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </aside>

        {/* Main content area */}
        <div class="flex-1 flex flex-col min-h-0">
          <Show
            when={selected()}
            fallback={
              <div class="flex-1 flex items-center justify-center">
                <div class="text-center text-text-dim">
                  <div class="text-4xl mb-2">&#128196;</div>
                  <div class="text-sm font-medium">
                    Select a channel to view its context layers
                  </div>
                  <div class="text-xs mt-1">
                    Click an agent, then choose a channel
                  </div>
                </div>
              </div>
            }
          >
            {(sel) => (
              <>
                {/* Header */}
                <div class="px-4 py-2 border-b border-border bg-surface">
                  <div class="text-sm font-medium text-text">
                    {sel().displayName}
                  </div>
                  <div class="text-xs text-text-dim">
                    {sel().agentName} &mdash; {sel().jid}
                  </div>
                </div>

                {/* Layer editor */}
                <Show
                  when={!layers.loading && layers()}
                  fallback={
                    <div class="flex-1 flex items-center justify-center text-text-dim text-sm">
                      Loading layers...
                    </div>
                  }
                >
                  {(layerData) => (
                    <LayerEditor
                      layers={layerData()}
                      initialLayer={initialLayer()}
                      onLayerChange={handleLayerChange}
                      onSaved={() => refetchLayers()}
                    />
                  )}
                </Show>
              </>
            )}
          </Show>
        </div>
      </div>
    </>
  );
}
