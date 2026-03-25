import { createSignal, createMemo, For, onMount, onCleanup } from 'solid-js';

import { logs, clearLogs } from '~/lib/stores/logs';
import LogLine, { LEVELS, toggleLevelSet } from '~/components/shared/LogLine';

export default function LogPanel() {
  const [enabledLevels, setEnabledLevels] = createSignal<Set<string>>(
    new Set(LEVELS),
  );
  const [autoScroll, setAutoScroll] = createSignal(true);
  let containerRef: HTMLDivElement | undefined;

  const filteredLogs = createMemo(() => {
    const enabled = enabledLevels();
    return logs.lines.filter((l) => enabled.has(l.level));
  });

  onMount(() => {
    const observer = new MutationObserver(() => {
      if (autoScroll() && containerRef) {
        containerRef.scrollTop = containerRef.scrollHeight;
      }
    });
    if (containerRef) {
      observer.observe(containerRef, { childList: true });
    }
    onCleanup(() => observer.disconnect());
  });

  return (
    <div class="flex flex-col h-full">
      <div class="flex items-center gap-1 px-2 py-1 border-b border-border shrink-0">
        <For each={[...LEVELS]}>
          {(level) => (
            <button
              class={`px-1.5 py-0.5 rounded text-xs ${
                enabledLevels().has(level)
                  ? 'bg-surface-2 text-text'
                  : 'text-text-dim'
              }`}
              onClick={() => setEnabledLevels((prev) => toggleLevelSet(prev, level))}
            >
              {level}
            </button>
          )}
        </For>
        <div class="flex-1" />
        <span class="text-xs text-text-dim">{logs.lines.length} lines</span>
        <button
          class="px-1.5 py-0.5 rounded text-xs text-text-dim hover:text-text hover:bg-surface-2"
          onClick={() => clearLogs()}
        >
          clear
        </button>
      </div>
      <div ref={containerRef} class="flex-1 overflow-auto p-1 text-xs min-h-0">
        <For each={filteredLogs()}>
          {(line) => <LogLine line={line} />}
        </For>
      </div>
    </div>
  );
}
