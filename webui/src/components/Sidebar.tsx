import { createSignal, Show } from 'solid-js';

import LogPanel from '~/components/LogPanel';
import TaskPanel from '~/components/TaskPanel';
import ResizeHandle from '~/components/ResizeHandle';

type SidebarTab = 'logs' | 'tasks';

export default function Sidebar() {
  const [activeTab, setActiveTab] = createSignal<SidebarTab>('logs');
  const [width, setWidth] = createSignal(380);
  const [collapsed, setCollapsed] = createSignal(false);

  function handleResize(delta: number) {
    setWidth((prev) => Math.max(200, Math.min(600, prev + delta)));
  }

  return (
    <Show when={!collapsed()}>
      <ResizeHandle onResize={handleResize} side="left" />
      <aside
        class="bg-surface border-l border-border flex flex-col shrink-0 min-h-0"
        style={{ width: `${width()}px` }}
      >
        <div class="flex items-center justify-between px-2 py-1 border-b border-border shrink-0">
          <div class="flex gap-1">
            <button
              class={`px-2 py-0.5 rounded text-xs ${
                activeTab() === 'logs'
                  ? 'bg-surface-2 text-text'
                  : 'text-text-dim hover:text-text'
              }`}
              onClick={() => setActiveTab('logs')}
            >
              logs
            </button>
            <button
              class={`px-2 py-0.5 rounded text-xs ${
                activeTab() === 'tasks'
                  ? 'bg-surface-2 text-text'
                  : 'text-text-dim hover:text-text'
              }`}
              onClick={() => setActiveTab('tasks')}
            >
              tasks
            </button>
          </div>
          <button
            class="text-text-dim hover:text-text text-xs px-1"
            onClick={() => setCollapsed(true)}
            title="Collapse sidebar"
          >
            &#x2715;
          </button>
        </div>
        <div class="flex-1 min-h-0">
          <Show when={activeTab() === 'logs'}>
            <LogPanel />
          </Show>
          <Show when={activeTab() === 'tasks'}>
            <TaskPanel />
          </Show>
        </div>
      </aside>
    </Show>
  );
}
