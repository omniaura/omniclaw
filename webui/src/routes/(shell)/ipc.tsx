import { Title } from '@solidjs/meta';
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';

import { api, type IpcEvent, type QueueDetail } from '~/lib/api';
import { stats } from '~/lib/stores/stats';

const POLL_INTERVAL_MS = 5000;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function eventKindClass(kind: string): string {
  if (kind.includes('error') || kind.includes('blocked')) return 'text-red';
  if (kind.includes('suppressed')) return 'text-yellow';
  return 'text-green';
}

function eventRowBg(kind: string): string {
  if (kind.includes('error') || kind.includes('blocked')) return 'bg-red/5';
  if (kind.includes('suppressed')) return 'bg-yellow/5';
  return '';
}

function laneColor(status: string): string {
  if (status === 'active') return 'bg-green/20 text-green';
  if (status === 'idle') return 'bg-blue/20 text-blue';
  return 'bg-surface-2 text-text-dim';
}

function messageLaneStatus(lane: QueueDetail['messageLane']): string {
  if (lane.idle) return 'idle';
  if (lane.active) return 'active';
  return 'off';
}

function taskLaneStatus(lane: QueueDetail['taskLane']): string {
  return lane.active ? 'active' : 'off';
}

export default function Ipc() {
  const [queue, setQueue] = createSignal<QueueDetail[]>([]);
  const [events, setEvents] = createSignal<IpcEvent[]>([]);

  async function refresh() {
    try {
      const [q, e] = await Promise.all([
        api.getQueueDetails(),
        api.getIpcEvents(50),
      ]);
      setQueue(q);
      setEvents(e);
    } catch {
      // silently ignore fetch errors
    }
  }

  onMount(() => {
    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    onCleanup(() => clearInterval(timer));
  });

  return (
    <>
      <Title>OmniClaw — IPC</Title>
      <div class="p-4 space-y-6">
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard
            label="processing"
            value={() =>
              `${Math.max(0, stats.activeContainers - stats.idleContainers)}/${stats.maxActive}`
            }
          />
          <StatCard
            label="idle"
            value={() => `${stats.idleContainers}/${stats.maxIdle}`}
          />
          <StatCard
            label="groups tracked"
            value={() => String(queue().length)}
          />
          <StatCard
            label="recent events"
            value={() => String(events().length)}
          />
        </div>

        <section>
          <h2 class="text-text-bright text-sm font-semibold mb-3">
            group queue state
          </h2>
          <Show
            when={queue().length > 0}
            fallback={
              <div class="text-text-dim text-xs border border-dashed border-border rounded p-4">
                No groups currently tracked.
              </div>
            }
          >
            <div class="overflow-x-auto rounded border border-border">
              <table class="w-full text-xs">
                <thead>
                  <tr class="bg-surface-2 text-text-dim">
                    <th class="text-left px-3 py-2 font-medium">group</th>
                    <th class="text-left px-3 py-2 font-medium">messages</th>
                    <th class="text-left px-3 py-2 font-medium">msg queue</th>
                    <th class="text-left px-3 py-2 font-medium">tasks</th>
                    <th class="text-left px-3 py-2 font-medium">task queue</th>
                    <th class="text-left px-3 py-2 font-medium">
                      running task
                    </th>
                    <th class="text-left px-3 py-2 font-medium">retries</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={queue()}>
                    {(group) => {
                      const msgStatus = messageLaneStatus(group.messageLane);
                      const tStatus = taskLaneStatus(group.taskLane);
                      return (
                        <tr class="border-t border-border hover:bg-surface-2/50">
                          <td class="px-3 py-2 text-accent">
                            {group.folderKey}
                          </td>
                          <td class="px-3 py-2">
                            <LaneBadge status={msgStatus} />
                          </td>
                          <td class="px-3 py-2">
                            {group.messageLane.pendingCount}
                          </td>
                          <td class="px-3 py-2">
                            <LaneBadge status={tStatus} />
                          </td>
                          <td class="px-3 py-2">
                            {group.taskLane.pendingCount}
                          </td>
                          <td class="px-3 py-2 text-text-dim">
                            <Show
                              when={group.taskLane.activeTask}
                              fallback={<span>{'\u2014'}</span>}
                            >
                              {(task) => (
                                <span>
                                  {task().taskId}{' '}
                                  <span class="text-text-dim">
                                    ({formatDuration(task().runningMs)})
                                  </span>
                                </span>
                              )}
                            </Show>
                          </td>
                          <td class="px-3 py-2">
                            <Show
                              when={group.retryCount > 0}
                              fallback={<span>{'\u2014'}</span>}
                            >
                              <span class="text-yellow font-semibold">
                                {group.retryCount}
                              </span>
                            </Show>
                          </td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </section>

        <section>
          <h2 class="text-text-bright text-sm font-semibold mb-3">
            ipc event timeline
          </h2>
          <Show
            when={events().length > 0}
            fallback={
              <div class="text-text-dim text-xs border border-dashed border-border rounded p-4">
                No IPC events recorded yet.
              </div>
            }
          >
            <div class="overflow-x-auto rounded border border-border">
              <table class="w-full text-xs">
                <thead>
                  <tr class="bg-surface-2 text-text-dim">
                    <th class="text-left px-3 py-2 font-medium">time</th>
                    <th class="text-left px-3 py-2 font-medium">kind</th>
                    <th class="text-left px-3 py-2 font-medium">source</th>
                    <th class="text-left px-3 py-2 font-medium">summary</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={events()}>
                    {(event) => (
                      <tr
                        class={`border-t border-border ${eventRowBg(event.kind)}`}
                      >
                        <td class="px-3 py-2 text-text-dim whitespace-nowrap">
                          {formatTime(event.timestamp)}
                        </td>
                        <td class="px-3 py-2">
                          <span
                            class={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${eventKindClass(event.kind)} bg-surface-2`}
                          >
                            {event.kind}
                          </span>
                        </td>
                        <td class="px-3 py-2 text-accent">
                          {event.sourceGroup}
                        </td>
                        <td class="px-3 py-2">{event.summary}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </section>
      </div>
    </>
  );
}

function StatCard(props: { label: string; value: () => string }) {
  return (
    <div class="bg-surface rounded border border-border p-3">
      <div class="text-text-dim text-[10px] uppercase tracking-wider mb-1">
        {props.label}
      </div>
      <div class="text-text-bright text-lg font-semibold">{props.value()}</div>
    </div>
  );
}

function LaneBadge(props: { status: string }) {
  return (
    <span
      class={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${laneColor(props.status)}`}
    >
      {props.status}
    </span>
  );
}
