import { createSignal, For, Show, onMount } from 'solid-js';

import { api, type TaskRunLog } from '~/lib/api';

interface TaskRunHistoryProps {
  taskId: string;
  onClose: () => void;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function TaskRunHistory(props: TaskRunHistoryProps) {
  const [runs, setRuns] = createSignal<TaskRunLog[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');

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

                  return (
                    <tr class="border-t border-border/50">
                      <td class="py-1 pr-3 whitespace-nowrap text-text">
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
                      <td
                        class="py-1 text-text-dim max-w-[300px] overflow-hidden text-ellipsis whitespace-nowrap"
                        title={run.result || run.error || ''}
                      >
                        {truncated}
                      </td>
                    </tr>
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
