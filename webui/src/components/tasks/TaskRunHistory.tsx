import { createSignal, For, Show, onMount } from 'solid-js';

import { api, type TaskRunLog, type TaskRunPhaseEvent } from '~/lib/api';
import Badge from '~/components/shared/Badge';

interface TaskRunHistoryProps {
  taskId: string;
  onClose: () => void;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const PHASE_LABELS: Record<string, string> = {
  lease_acquired: 'Lease acquired',
  group_resolved: 'Group resolved',
  dispatch_started: 'Dispatch started',
  stream_result_received: 'Result received',
  outbound_send_attempted: 'Outbound send',
  run_finalized: 'Finalized',
};

function PhaseTimeline(props: { taskId: string; runAt: string }) {
  const [phases, setPhases] = createSignal<TaskRunPhaseEvent[]>([]);
  const [loading, setLoading] = createSignal(true);

  onMount(async () => {
    try {
      const data = await api.getTaskRunPhases(props.taskId, props.runAt);
      setPhases(data);
    } catch {
      // silently fail — phases are supplementary
    } finally {
      setLoading(false);
    }
  });

  return (
    <div class="pl-4 py-2 border-l-2 border-border/50 ml-2 mt-1">
      <Show when={loading()}>
        <span class="text-text-dim text-xs">Loading phases...</span>
      </Show>
      <Show when={!loading() && phases().length === 0}>
        <span class="text-text-dim text-xs">No phase data</span>
      </Show>
      <For each={phases()}>
        {(phase) => (
          <div class="flex items-center gap-2 text-xs py-0.5">
            <span
              class={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                phase.status === 'ok' ? 'bg-green' : 'bg-red'
              }`}
            />
            <span class="text-text-dim w-24 flex-shrink-0">
              {PHASE_LABELS[phase.phase] ?? phase.phase}
            </span>
            <Show when={phase.status === 'error'}>
              <span
                class="text-red truncate max-w-[200px]"
                title={phase.error ?? ''}
              >
                {phase.error ?? 'error'}
              </span>
              <Show when={phase.retryable}>
                <Badge variant="paused">retryable</Badge>
              </Show>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

function OutcomeBadge(props: { state: string }) {
  const variant = () => {
    switch (props.state) {
      case 'done':
        return 'active' as const;
      case 'blocked':
        return 'paused' as const;
      case 'abandoned':
        return 'error' as const;
      default:
        return 'default' as const;
    }
  };

  return <Badge variant={variant()}>{props.state}</Badge>;
}

export default function TaskRunHistory(props: TaskRunHistoryProps) {
  const [runs, setRuns] = createSignal<TaskRunLog[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [expandedRun, setExpandedRun] = createSignal<string | null>(null);

  onMount(async () => {
    try {
      const data = await api.getTaskRuns(props.taskId, 20);
      setRuns(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load runs');
    } finally {
      setLoading(false);
    }
  });

  return (
    <div class="mt-4 border border-border rounded-lg bg-surface">
      <div class="flex items-center justify-between px-4 py-2 border-b border-border">
        <h3 class="text-text-bright text-xs font-semibold">
          Run History — {props.taskId.slice(0, 20)}...
        </h3>
        <button
          class="text-text-dim hover:text-text-bright text-xs"
          onClick={() => props.onClose()}
        >
          &#x2715; Close
        </button>
      </div>
      <div class="p-3">
        <Show when={loading()}>
          <div class="text-text-dim text-xs py-2">Loading...</div>
        </Show>
        <Show when={error()}>
          <div class="text-red text-xs py-2">{error()}</div>
        </Show>
        <Show when={!loading() && !error() && runs().length === 0}>
          <div class="text-text-dim text-xs py-2">No runs yet</div>
        </Show>
        <Show when={!loading() && !error() && runs().length > 0}>
          <table class="w-full text-xs">
            <thead>
              <tr class="text-text-dim text-left">
                <th class="pb-1 pr-3">time</th>
                <th class="pb-1 pr-3">duration</th>
                <th class="pb-1 pr-3">status</th>
                <th class="pb-1 pr-3">outcome</th>
                <th class="pb-1">detail</th>
              </tr>
            </thead>
            <tbody>
              <For each={runs()}>
                {(run) => {
                  const detail =
                    run.status === 'success'
                      ? run.result || 'ok'
                      : `Error: ${run.error || 'unknown'}`;
                  const truncated =
                    detail.length > 80 ? detail.slice(0, 77) + '...' : detail;
                  const isExpanded = () => expandedRun() === run.run_at;

                  return (
                    <>
                      <tr
                        class="border-t border-border/50 cursor-pointer hover:bg-surface-2/50"
                        onClick={() =>
                          setExpandedRun(isExpanded() ? null : run.run_at)
                        }
                      >
                        <td class="py-1 pr-3 whitespace-nowrap text-text">
                          <span class="mr-1 text-text-dim">
                            {isExpanded() ? '\u25BC' : '\u25B6'}
                          </span>
                          {new Date(run.run_at).toLocaleString()}
                        </td>
                        <td class="py-1 pr-3 whitespace-nowrap text-text">
                          {formatDuration(run.duration_ms)}
                        </td>
                        <td
                          class={`py-1 pr-3 font-semibold ${
                            run.status === 'success' ? 'text-green' : 'text-red'
                          }`}
                        >
                          {run.status}
                        </td>
                        <td class="py-1 pr-3">
                          <Show when={run.outcome_state}>
                            <OutcomeBadge state={run.outcome_state!} />
                          </Show>
                        </td>
                        <td
                          class="py-1 text-text-dim max-w-[300px] overflow-hidden text-ellipsis whitespace-nowrap"
                          title={run.result || run.error || ''}
                        >
                          {truncated}
                        </td>
                      </tr>
                      <Show when={isExpanded()}>
                        <tr>
                          <td colspan="5" class="pb-2">
                            <Show when={run.outcome_reason}>
                              <div class="text-xs text-text-dim px-4 pt-1">
                                Reason: {run.outcome_reason}
                              </div>
                            </Show>
                            <Show when={run.outcome_question}>
                              <div class="text-xs text-yellow px-4 pt-1">
                                Question: {run.outcome_question}
                              </div>
                            </Show>
                            <PhaseTimeline
                              taskId={props.taskId}
                              runAt={run.run_at}
                            />
                          </td>
                        </tr>
                      </Show>
                    </>
                  );
                }}
              </For>
            </tbody>
          </table>
        </Show>
      </div>
    </div>
  );
}
