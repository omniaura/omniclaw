import { Title } from '@solidjs/meta';
import { useParams, A, useNavigate } from '@solidjs/router';
import {
  createSignal,
  createResource,
  Show,
  For,
  Suspense,
  onCleanup,
} from 'solid-js';
import { isServer } from 'solid-js/web';
import { api } from '~/lib/api';
import type { AgentDetailData, QueueDetail } from '~/lib/api';
import Badge from '~/components/shared/Badge';
import AvatarUpload from '~/components/agents/AvatarUpload';
import ExecStatusBadge from '~/components/agents/ExecStatusBadge';

type Tab = 'overview' | 'channels' | 'tasks' | 'chats';

function backendVariant(backend: string) {
  if (backend === 'apple-container') return 'apple-container' as const;
  if (backend === 'docker') return 'docker' as const;
  return 'default' as const;
}

function statusVariant(status: string) {
  if (status === 'active') return 'active' as const;
  if (status === 'paused') return 'paused' as const;
  return 'completed' as const;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '\u2014';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return '\u2014';
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '\u2026' : text;
}

export default function AgentDetail() {
  const params = useParams();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = createSignal<Tab>('overview');
  const [avatarKey, setAvatarKey] = createSignal(0);

  const [agent, { refetch }] = createResource(
    () => (isServer ? undefined : params.id),
    (id) => api.getAgentDetail(id),
  );

  // Poll queue details for live execution status
  const [queueDetails, setQueueDetails] = createSignal<
    QueueDetail[] | undefined
  >(undefined);
  if (!isServer) {
    const pollQueue = () => {
      api
        .getQueueDetails()
        .then(setQueueDetails)
        .catch(() => {});
    };
    pollQueue();
    const timer = setInterval(pollQueue, 5000);
    onCleanup(() => clearInterval(timer));
  }

  const avatarImageUrl = () => api.getAgentAvatarImageUrl(params.id);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'overview' },
    { id: 'channels', label: 'channels' },
    { id: 'tasks', label: 'tasks' },
    { id: 'chats', label: 'chats' },
  ];

  return (
    <>
      <Title>OmniClaw — {agent()?.name ?? 'Agent'}</Title>

      <div class="p-4 max-w-4xl mx-auto">
        {/* Back nav */}
        <div class="mb-4">
          <A href="/agents" class="text-sm text-text-dim hover:text-accent">
            &larr; agents
          </A>
        </div>

        <Suspense fallback={<div class="text-text-dim">Loading...</div>}>
          <Show
            when={agent()}
            fallback={
              <div class="text-text-dim">
                <p>
                  Agent not found: <code class="text-accent">{params.id}</code>
                </p>
                <A href="/agents" class="text-sm mt-2 inline-block">
                  back to agents
                </A>
              </div>
            }
          >
            {(data) => (
              <>
                {/* Header */}
                <div class="flex items-start gap-4 mb-6">
                  <Show
                    when={data().avatarUrl}
                    fallback={
                      <div class="w-16 h-16 rounded-full bg-surface-2 border border-border flex items-center justify-center text-2xl text-text-dim shrink-0">
                        {data().name.charAt(0).toUpperCase()}
                      </div>
                    }
                  >
                    <img
                      src={`${avatarImageUrl()}?k=${avatarKey()}`}
                      alt={data().name}
                      class="w-16 h-16 rounded-full object-cover border border-border shrink-0"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  </Show>

                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-3 mb-1">
                      <h2 class="text-xl text-text-bright font-semibold">
                        {data().name}
                      </h2>
                      <ExecStatusBadge
                        folder={data().folder}
                        queueDetails={queueDetails}
                      />
                    </div>
                    <div class="flex flex-wrap gap-1.5 mb-1">
                      <Badge variant={backendVariant(data().backend)}>
                        {data().backend}
                      </Badge>
                      <Badge>{data().agentRuntime}</Badge>
                      <Show when={data().remoteInstanceId}>
                        <Badge variant="remote">
                          {data().remoteInstanceName || data().remoteInstanceId}
                        </Badge>
                      </Show>
                      <Show when={data().isAdmin}>
                        <Badge variant="admin">admin</Badge>
                      </Show>
                    </div>
                    <Show when={data().description}>
                      <p class="text-sm text-text-dim mt-1">
                        {data().description}
                      </p>
                    </Show>
                  </div>
                </div>

                {/* Info grid */}
                <div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6 text-sm">
                  <InfoItem label="id" value={data().id} />
                  <InfoItem label="folder" value={data().folder} />
                  <InfoItem
                    label="created"
                    value={formatDate(data().createdAt)}
                  />
                  <Show when={data().remoteInstanceId}>
                    <InfoItem
                      label="remote peer"
                      value={
                        data().remoteInstanceName || data().remoteInstanceId!
                      }
                    />
                  </Show>
                  <Show when={data().serverFolder}>
                    <InfoItem label="server" value={data().serverFolder!} />
                  </Show>
                  <Show when={data().agentContextFolder}>
                    <InfoItem
                      label="context folder"
                      value={data().agentContextFolder!}
                    />
                  </Show>
                </div>

                {/* Tabs */}
                <div class="flex gap-1 border-b border-border mb-4">
                  <For each={tabs}>
                    {(tab) => {
                      const count = () => {
                        const d = data();
                        if (tab.id === 'channels') return d.channels.length;
                        if (tab.id === 'tasks') return d.tasks.length;
                        if (tab.id === 'chats') return d.recentChats.length;
                        return undefined;
                      };
                      return (
                        <button
                          class={`px-3 py-1.5 text-sm border-b-2 transition-colors ${
                            activeTab() === tab.id
                              ? 'border-accent text-accent'
                              : 'border-transparent text-text-dim hover:text-text'
                          }`}
                          onClick={() => setActiveTab(tab.id)}
                        >
                          {tab.label}
                          <Show when={count() !== undefined}>
                            <span class="ml-1 text-xs text-text-dim">
                              ({count()})
                            </span>
                          </Show>
                        </button>
                      );
                    }}
                  </For>
                </div>

                {/* Tab content */}
                <Show when={activeTab() === 'overview'}>
                  <div class="space-y-6">
                    <Show when={!data().remoteInstanceId}>
                      <div>
                        <h3 class="text-sm text-text-bright mb-3">
                          send message
                        </h3>
                        <MessageCompose
                          agentId={data().id}
                          channels={data().channels}
                        />
                      </div>
                      <div>
                        <h3 class="text-sm text-text-bright mb-3">avatar</h3>
                        <AvatarUpload
                          agentId={data().id}
                          currentUrl={data().avatarUrl}
                          onUpdated={() => setAvatarKey((k) => k + 1)}
                        />
                      </div>
                    </Show>
                  </div>
                </Show>

                <Show when={activeTab() === 'channels'}>
                  <div class="overflow-x-auto">
                    <table class="w-full text-sm">
                      <thead>
                        <tr class="text-left text-text-dim border-b border-border">
                          <th class="pb-2 pr-4 font-medium">name</th>
                          <th class="pb-2 pr-4 font-medium">jid</th>
                          <th class="pb-2 pr-4 font-medium">folder</th>
                          <th class="pb-2 font-medium"></th>
                        </tr>
                      </thead>
                      <tbody>
                        <Show
                          when={data().channels.length > 0}
                          fallback={
                            <tr>
                              <td colspan="4" class="py-3 text-text-dim">
                                No channels subscribed
                              </td>
                            </tr>
                          }
                        >
                          <For each={data().channels}>
                            {(ch) => (
                              <tr class="border-b border-border/50 hover:bg-surface-2/50">
                                <td class="py-2 pr-4">{ch.displayName}</td>
                                <td class="py-2 pr-4 text-text-dim">
                                  {ch.jid}
                                </td>
                                <td class="py-2 pr-4 text-text-dim">
                                  {ch.channelFolder ?? '\u2014'}
                                </td>
                                <td class="py-2">
                                  <Show
                                    when={!data().remoteInstanceId}
                                    fallback={
                                      <span class="text-text-dim text-xs">
                                        remote
                                      </span>
                                    }
                                  >
                                    <button
                                      class="px-2 py-0.5 text-xs rounded bg-surface-2 text-text-dim hover:text-text hover:bg-border"
                                      onClick={() =>
                                        navigate(
                                          `/conversations?chat=${encodeURIComponent(ch.jid)}`,
                                        )
                                      }
                                    >
                                      messages
                                    </button>
                                  </Show>
                                </td>
                              </tr>
                            )}
                          </For>
                        </Show>
                      </tbody>
                    </table>
                  </div>
                </Show>

                <Show when={activeTab() === 'tasks'}>
                  <TasksTab
                    tasks={data().tasks}
                    isRemote={!!data().remoteInstanceId}
                    onRefresh={refetch}
                  />
                </Show>

                <Show when={activeTab() === 'chats'}>
                  <div class="overflow-x-auto">
                    <table class="w-full text-sm">
                      <thead>
                        <tr class="text-left text-text-dim border-b border-border">
                          <th class="pb-2 pr-4 font-medium">chat</th>
                          <th class="pb-2 pr-4 font-medium">last message</th>
                          <th class="pb-2 font-medium"></th>
                        </tr>
                      </thead>
                      <tbody>
                        <Show
                          when={data().recentChats.length > 0}
                          fallback={
                            <tr>
                              <td colspan="3" class="py-3 text-text-dim">
                                No conversations
                              </td>
                            </tr>
                          }
                        >
                          <For each={data().recentChats}>
                            {(chat) => (
                              <tr class="border-b border-border/50 hover:bg-surface-2/50">
                                <td class="py-2 pr-4">{chat.name}</td>
                                <td class="py-2 pr-4 text-text-dim">
                                  {formatDate(chat.last_message_time)}
                                </td>
                                <td class="py-2">
                                  <button
                                    class="px-2 py-0.5 text-xs rounded bg-surface-2 text-text-dim hover:text-text hover:bg-border"
                                    onClick={() =>
                                      navigate(
                                        `/conversations?chat=${encodeURIComponent(chat.jid)}`,
                                      )
                                    }
                                  >
                                    view
                                  </button>
                                </td>
                              </tr>
                            )}
                          </For>
                        </Show>
                      </tbody>
                    </table>
                  </div>
                </Show>
              </>
            )}
          </Show>
        </Suspense>
      </div>
    </>
  );
}

function InfoItem(props: { label: string; value: string }) {
  return (
    <div class="bg-surface rounded px-3 py-2 border border-border">
      <div class="text-text-dim text-xs mb-0.5">{props.label}</div>
      <div class="text-text break-all">{props.value}</div>
    </div>
  );
}

function TasksTab(props: {
  tasks: AgentDetailData['tasks'];
  isRemote: boolean;
  onRefresh: () => void;
}) {
  const [togglingId, setTogglingId] = createSignal<string | null>(null);
  const [toast, setToast] = createSignal<{
    ok: boolean;
    text: string;
  } | null>(null);

  async function toggleTask(
    taskId: string,
    newStatus: 'active' | 'paused',
  ): Promise<void> {
    setTogglingId(taskId);
    setToast(null);
    try {
      await api.updateTask(taskId, { status: newStatus });
      setToast({
        ok: true,
        text: `Task ${newStatus === 'paused' ? 'paused' : 'resumed'}`,
      });
      props.onRefresh();
    } catch (err: any) {
      setToast({ ok: false, text: err.message || 'Failed to update task' });
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <div>
      <Show when={toast()}>
        {(t) => (
          <div class={`text-xs mb-3 ${t().ok ? 'text-green' : 'text-red'}`}>
            {t().text}
          </div>
        )}
      </Show>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-text-dim border-b border-border">
              <th class="pb-2 pr-4 font-medium">status</th>
              <th class="pb-2 pr-4 font-medium">prompt</th>
              <th class="pb-2 pr-4 font-medium">schedule</th>
              <th class="pb-2 pr-4 font-medium">next run</th>
              <Show when={!props.isRemote}>
                <th class="pb-2 font-medium"></th>
              </Show>
            </tr>
          </thead>
          <tbody>
            <Show
              when={props.tasks.length > 0}
              fallback={
                <tr>
                  <td
                    colspan={props.isRemote ? '4' : '5'}
                    class="py-3 text-text-dim"
                  >
                    No scheduled tasks
                  </td>
                </tr>
              }
            >
              <For each={props.tasks}>
                {(task) => {
                  const isToggling = () => togglingId() === task.id;
                  const toggleTarget = (): 'active' | 'paused' =>
                    task.status === 'active' ? 'paused' : 'active';
                  const toggleLabel = () =>
                    task.status === 'active' ? 'pause' : 'resume';

                  return (
                    <tr class="border-b border-border/50 hover:bg-surface-2/50">
                      <td class="py-2 pr-4">
                        <Badge variant={statusVariant(task.status)}>
                          {task.status}
                        </Badge>
                      </td>
                      <td class="py-2 pr-4" title={task.prompt}>
                        {truncate(task.prompt, 80)}
                      </td>
                      <td class="py-2 pr-4 text-text-dim">
                        {task.schedule_type}: {task.schedule_value}
                      </td>
                      <td class="py-2 pr-4 text-text-dim">
                        {formatDate(task.next_run)}
                      </td>
                      <Show when={!props.isRemote}>
                        <td class="py-2">
                          <Show when={task.status !== 'completed'}>
                            <button
                              class="px-2 py-0.5 text-xs rounded bg-surface-2 text-text-dim hover:text-text-bright border border-border hover:border-border-bright disabled:opacity-50"
                              disabled={isToggling()}
                              onClick={() =>
                                toggleTask(task.id, toggleTarget())
                              }
                            >
                              {isToggling() ? '...' : toggleLabel()}
                            </button>
                          </Show>
                        </td>
                      </Show>
                    </tr>
                  );
                }}
              </For>
            </Show>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MessageCompose(props: {
  agentId: string;
  channels: AgentDetailData['channels'];
}) {
  const [selectedChannel, setSelectedChannel] = createSignal(
    props.channels.length > 0 ? props.channels[0].jid : '',
  );
  const [content, setContent] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [result, setResult] = createSignal<{
    ok: boolean;
    text: string;
  } | null>(null);

  async function send() {
    const ch = selectedChannel();
    const msg = content().trim();
    if (!ch || !msg) return;

    setSending(true);
    setResult(null);
    try {
      await api.sendAgentMessage(props.agentId, ch, msg);
      setContent('');
      setResult({ ok: true, text: 'Message sent' });
    } catch (err: any) {
      setResult({ ok: false, text: err.message || 'Failed to send' });
    } finally {
      setSending(false);
    }
  }

  return (
    <div class="space-y-3">
      <Show
        when={props.channels.length > 0}
        fallback={
          <p class="text-sm text-text-dim">
            No channels available for this agent.
          </p>
        }
      >
        <div>
          <label class="block text-xs text-text-dim mb-1">channel</label>
          <select
            class="w-full bg-surface border border-border rounded px-2 py-1.5 text-sm text-text"
            value={selectedChannel()}
            onChange={(e) => setSelectedChannel(e.currentTarget.value)}
          >
            <For each={props.channels}>
              {(ch) => (
                <option value={ch.jid}>
                  {ch.displayName} ({ch.jid})
                </option>
              )}
            </For>
          </select>
        </div>

        <div>
          <label class="block text-xs text-text-dim mb-1">message</label>
          <textarea
            class="w-full bg-surface border border-border rounded px-2 py-1.5 text-sm text-text min-h-[80px] resize-y"
            placeholder="Type a message to send to this agent..."
            value={content()}
            onInput={(e) => setContent(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
          />
        </div>

        <div class="flex items-center gap-3">
          <button
            class="px-3 py-1.5 text-sm rounded bg-accent text-bg hover:opacity-90 disabled:opacity-50"
            disabled={sending() || !content().trim()}
            onClick={send}
          >
            {sending() ? 'Sending...' : 'Send'}
          </button>
          <span class="text-xs text-text-dim">Ctrl+Enter to send</span>
          <Show when={result()}>
            {(r) => (
              <span class={`text-xs ${r().ok ? 'text-green' : 'text-red'}`}>
                {r().text}
              </span>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}
