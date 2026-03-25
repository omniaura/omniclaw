import { For, Show } from 'solid-js';

import { tasks } from '~/lib/stores/tasks';
import Badge from '~/components/shared/Badge';

const statusVariant = {
  active: 'active' as const,
  paused: 'paused' as const,
  completed: 'completed' as const,
};

export default function TaskPanel() {
  return (
    <div class="flex flex-col h-full overflow-auto p-2 gap-2">
      <Show
        when={tasks.list.length > 0}
        fallback={
          <div class="text-text-dim text-xs text-center py-4">No tasks</div>
        }
      >
        <For each={tasks.list.slice(0, 50)}>
          {(task) => {
            const agentShort = task.group_folder.split('-')[0] || task.group_folder;
            const promptShort =
              task.prompt.length > 40
                ? task.prompt.slice(0, 40) + '\u2026'
                : task.prompt;

            return (
              <div class="bg-surface-2 rounded border border-border p-2 text-xs">
                <div class="flex items-center gap-1 mb-1">
                  <Badge variant={statusVariant[task.status] ?? 'default'}>
                    {task.status}
                  </Badge>
                  <span class="text-text-dim">{agentShort}</span>
                  <span class="text-text-dim ml-auto">
                    {task.schedule_value}
                  </span>
                </div>
                <div class="text-text truncate" title={task.prompt}>
                  {promptShort}
                </div>
                <Show when={task.last_run}>
                  <div class="text-text-dim mt-1">
                    {task.last_result ?? '\u2014'}
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </Show>
    </div>
  );
}
