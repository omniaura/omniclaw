import { createSignal, createEffect, onCleanup, type Accessor } from 'solid-js';

import { api, type QueueDetail } from '~/lib/api';

export type AgentExecStatus =
  | 'executing'
  | 'running-task'
  | 'idle'
  | 'queued'
  | 'offline';

const STATUS_LABELS: Record<AgentExecStatus, string> = {
  executing: 'executing',
  'running-task': 'task',
  idle: 'idle',
  queued: 'queued',
  offline: 'offline',
};

const STATUS_STYLES: Record<AgentExecStatus, string> = {
  executing: 'bg-green/20 text-green animate-pulse',
  'running-task': 'bg-blue/20 text-blue animate-pulse',
  idle: 'bg-yellow/10 text-yellow',
  queued: 'bg-cyan/10 text-cyan',
  offline: 'bg-surface-2 text-text-dim',
};

/** Derive execution status from queue details for a given agent folder. */
export function deriveExecStatus(
  folder: string,
  details: QueueDetail[],
): AgentExecStatus {
  const detail = details.find((d) => d.folderKey === folder);
  if (!detail) return 'offline';
  if (detail.messageLane.active && !detail.messageLane.idle) return 'executing';
  if (detail.taskLane.active) return 'running-task';
  if (detail.messageLane.idle) return 'idle';
  if (detail.messageLane.pendingCount > 0 || detail.taskLane.pendingCount > 0)
    return 'queued';
  return 'offline';
}

interface ExecStatusBadgeProps {
  folder: string;
  /** Optional externally provided queue details (avoids redundant polling). */
  queueDetails?: Accessor<QueueDetail[] | undefined>;
  /** Poll interval in ms (default 5000). Ignored when queueDetails is provided. */
  pollInterval?: number;
}

/**
 * Displays a live execution status badge for an agent.
 * Polls /api/ipc/queue to determine idle/executing/offline state.
 */
export default function ExecStatusBadge(props: ExecStatusBadgeProps) {
  const [localDetails, setLocalDetails] = createSignal<QueueDetail[]>([]);

  // Only poll if no external details are provided
  if (!props.queueDetails) {
    const interval = props.pollInterval ?? 5000;
    let timer: ReturnType<typeof setInterval> | undefined;

    const poll = () => {
      api
        .getQueueDetails()
        .then(setLocalDetails)
        .catch(() => {});
    };

    poll();
    timer = setInterval(poll, interval);
    onCleanup(() => clearInterval(timer));
  }

  const details = () => props.queueDetails?.() ?? localDetails();

  const status = (): AgentExecStatus => {
    const d = details();
    if (!d || d.length === 0) return 'offline';
    return deriveExecStatus(props.folder, d);
  };

  return (
    <span
      class={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[status()]}`}
    >
      {STATUS_LABELS[status()]}
    </span>
  );
}
