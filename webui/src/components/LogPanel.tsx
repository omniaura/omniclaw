import { createSignal, createMemo, For, Show, onMount, onCleanup } from 'solid-js';

import { logs, clearLogs, type LogLine } from '~/lib/stores/logs';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

const levelColors: Record<string, string> = {
  debug: 'text-text-dim',
  info: 'text-blue',
  warn: 'text-yellow',
  error: 'text-red',
  fatal: 'text-red',
};

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

  function toggleLevel(level: string) {
    setEnabledLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString();
  }

  // Auto-scroll to bottom on new logs
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
              onClick={() => toggleLevel(level)}
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
          {(line) => (
            <div class="flex gap-1 py-px leading-relaxed">
              <span class="text-text-dim shrink-0">{formatTime(line.ts)}</span>
              <span class={`shrink-0 w-10 ${levelColors[line.level] ?? 'text-text-dim'}`}>
                {line.level}
              </span>
              <Show when={line.container || line.group}>
                <span class="text-accent shrink-0">
                  {line.container || line.group}
                </span>
              </Show>
              <Show when={line.op}>
                <span class="text-text-dim">[{line.op}]</span>
              </Show>
              <span class="text-text break-all">
                {line.msg}
                <Show when={line.durationMs != null}>
                  {' '}({line.durationMs}ms)
                </Show>
                <Show when={line.costUsd != null}>
                  {' '}${line.costUsd}
                </Show>
              </span>
              <Show when={line.err}>
                <span class="text-red break-all">{line.err}</span>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
