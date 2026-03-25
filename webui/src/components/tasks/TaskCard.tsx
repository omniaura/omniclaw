import { Show } from 'solid-js';

import Badge from '~/components/shared/Badge';
import type { ScheduledTask } from '~/lib/api';

interface TaskCardProps {
  task: ScheduledTask;
  onToggle: (id: string, newStatus: 'active' | 'paused') => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onViewRuns: (id: string) => void;
}

function formatScheduleLabel(type: string, value: string): string {
  if (type === 'interval') {
    const ms = parseInt(value, 10);
    if (isNaN(ms)) return value;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
    if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)}m`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
  }
  if (type === 'once') {
    try {
      return new Date(value).toLocaleString();
    } catch {
      return value;
    }
  }
  return value;
}

function formatRelativeTime(isoStr: string): string {
  try {
    const date = new Date(isoStr);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const absDiff = Math.abs(diffMs);

    if (absDiff < 60_000) return diffMs > 0 ? 'in <1m' : '<1m ago';
    if (absDiff < 3_600_000) {
      const mins = Math.round(absDiff / 60_000);
      return diffMs > 0 ? `in ${mins}m` : `${mins}m ago`;
    }
    if (absDiff < 86_400_000) {
      const hours = Math.round(absDiff / 3_600_000);
      return diffMs > 0 ? `in ${hours}h` : `${hours}h ago`;
    }
    const days = Math.round(absDiff / 86_400_000);
    return diffMs > 0 ? `in ${days}d` : `${days}d ago`;
  } catch {
    return isoStr;
  }
}

export default function TaskCard(props: TaskCardProps) {
  const toggleLabel = () =>
    props.task.status === 'active' ? 'Pause' : 'Resume';
  const toggleTarget = (): 'active' | 'paused' =>
    props.task.status === 'active' ? 'paused' : 'active';
  const promptShort = () =>
    props.task.prompt.length > 60
      ? props.task.prompt.slice(0, 57) + '...'
      : props.task.prompt;
  const schedLabel = () =>
    formatScheduleLabel(props.task.schedule_type, props.task.schedule_value);
  const nextRun = () =>
    props.task.next_run ? formatRelativeTime(props.task.next_run) : '\u2014';
  const lastRun = () =>
    props.task.last_run ? formatRelativeTime(props.task.last_run) : '\u2014';
  const lastResultClass = () =>
    props.task.last_result === 'success'
      ? 'text-green'
      : props.task.last_result === 'error'
        ? 'text-red'
        : '';

  return (
    <tr>
      <td class="px-3 py-2">
        <Badge variant={props.task.status}>{props.task.status}</Badge>
      </td>
      <td class="px-3 py-2 text-text" title={props.task.chat_jid}>
        {props.task.group_folder}
      </td>
      <td
        class="px-3 py-2 text-text-dim max-w-[200px] overflow-hidden text-ellipsis whitespace-nowrap"
        title={props.task.prompt}
      >
        {promptShort()}
      </td>
      <td class="px-3 py-2">
        <Badge>{props.task.schedule_type}</Badge>{' '}
        <span class="text-text-dim">{schedLabel()}</span>
      </td>
      <td class="px-3 py-2 whitespace-nowrap text-text-dim" title={props.task.next_run ?? ''}>
        {nextRun()}
      </td>
      <td
        class={`px-3 py-2 whitespace-nowrap ${lastResultClass()}`}
        title={props.task.last_run ?? ''}
      >
        {lastRun()}
      </td>
      <td class="px-3 py-2">
        <Badge>{props.task.context_mode}</Badge>
      </td>
      <td class="px-3 py-2 whitespace-nowrap">
        <div class="flex gap-1">
          <Show when={props.task.status !== 'completed'}>
            <button
              class="px-2 py-0.5 text-xs rounded bg-surface-2 text-text-dim hover:text-text-bright border border-border hover:border-border-bright"
              onClick={() => props.onToggle(props.task.id, toggleTarget())}
            >
              {toggleLabel()}
            </button>
          </Show>
          <button
            class="px-2 py-0.5 text-xs rounded bg-surface-2 text-text-dim hover:text-text-bright border border-border hover:border-border-bright"
            onClick={() => props.onEdit(props.task.id)}
          >
            Edit
          </button>
          <button
            class="px-2 py-0.5 text-xs rounded bg-surface-2 text-text-dim hover:text-text-bright border border-border hover:border-border-bright"
            onClick={() => props.onViewRuns(props.task.id)}
          >
            Runs
          </button>
          <button
            class="px-2 py-0.5 text-xs rounded bg-red/10 text-red hover:bg-red/20 border border-red/20 hover:border-red/40"
            onClick={() => props.onDelete(props.task.id)}
          >
            Del
          </button>
        </div>
      </td>
    </tr>
  );
}
