import {
  createSignal,
  createMemo,
  createEffect,
  For,
  Show,
  onCleanup,
} from 'solid-js';
import { Title } from '@solidjs/meta';

import { logs, clearLogs } from '~/lib/stores/logs';
import { agents } from '~/lib/stores/agents';
import { useEventSource } from '~/lib/event-source';
import { showToast } from '~/components/shared/Toast';
import LogLine, {
  LEVELS,
  toggleLevelSet,
  formatLogTime,
} from '~/components/shared/LogLine';

export default function LogsPage() {
  const { status } = useEventSource();

  const [enabledLevels, setEnabledLevels] = createSignal<Set<string>>(
    new Set([...LEVELS, 'fatal']),
  );
  const [autoScroll, setAutoScroll] = createSignal(true);
  const [searchTerm, setSearchTerm] = createSignal('');
  const [useRegex, setUseRegex] = createSignal(false);
  const [sourceFilter, setSourceFilter] = createSignal('');

  let containerRef: HTMLDivElement | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  onCleanup(() => {
    if (searchTimer) clearTimeout(searchTimer);
  });

  const filteredLogs = createMemo(() => {
    const enabled = enabledLevels();
    const source = sourceFilter();
    const term = searchTerm();

    let compiled: RegExp | null = null;
    if (term && useRegex()) {
      try {
        compiled = new RegExp(term, 'i');
      } catch {
        /* invalid regex */
      }
    }
    const lowerTerm = term.toLowerCase();

    return logs.lines.filter((line) => {
      if (!enabled.has(line.level)) return false;

      if (source) {
        const lineSource = line.container || line.group || '';
        if (!lineSource.includes(source)) return false;
      }

      if (term) {
        const text = `${line.msg} ${line.op ?? ''} ${line.container ?? ''} ${line.group ?? ''} ${line.err ?? ''}`;
        if (compiled) return compiled.test(text);
        return text.toLowerCase().includes(lowerTerm);
      }

      return true;
    });
  });

  createEffect(() => {
    const _ = filteredLogs().length;
    if (autoScroll() && containerRef) {
      queueMicrotask(() => {
        if (containerRef) containerRef.scrollTop = containerRef.scrollHeight;
      });
    }
  });

  function handleSearchInput(value: string) {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setSearchTerm(value), 200);
  }

  function exportLogs() {
    const lines = filteredLogs();
    const text = lines
      .map(
        (l) =>
          `${formatLogTime(l.ts)} ${l.level} ${l.container || l.group || ''} ${l.op ? `[${l.op}]` : ''} ${l.msg}${l.err ? ` ${l.err}` : ''}`,
      )
      .join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `omniclaw-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast(`Exported ${lines.length} log lines`, 'success');
  }

  function handleClear() {
    clearLogs();
    showToast('Logs cleared', 'info');
  }

  const sourceOptions = createMemo(() =>
    agents.list.map((a) => ({ id: a.id, name: a.name })),
  );

  const filterActive = createMemo(() => {
    const total = logs.lines.length;
    const shown = filteredLogs().length;
    return total !== shown;
  });

  return (
    <>
      <Title>OmniClaw — Logs</Title>
      <div class="flex flex-col h-full">
        <div class="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border shrink-0">
          <h2 class="text-sm font-semibold text-text-bright mr-2">Logs</h2>
          <span class="text-xs text-text-dim">
            {filteredLogs().length}
            <Show when={filterActive()}> / {logs.lines.length}</Show> lines
          </span>

          <div class="flex-1" />

          <div class="flex items-center gap-1">
            <input
              type="text"
              placeholder="Search logs..."
              spellcheck={false}
              autocomplete="off"
              class="bg-surface text-text text-xs px-2 py-1 rounded border border-border focus:border-accent focus:outline-none w-48"
              onInput={(e) => handleSearchInput(e.currentTarget.value)}
            />
            <label class="flex items-center gap-1 text-xs text-text-dim cursor-pointer select-none">
              <input
                type="checkbox"
                checked={useRegex()}
                onChange={(e) => setUseRegex(e.currentTarget.checked)}
                class="accent-accent"
              />
              regex
            </label>
          </div>

          <div class="flex-1" />

          <div class="flex items-center gap-1">
            <For each={[...LEVELS]}>
              {(level) => (
                <button
                  class={`px-1.5 py-0.5 rounded text-xs transition-colors ${
                    enabledLevels().has(level)
                      ? 'bg-surface-2 text-text'
                      : 'text-text-dim opacity-50'
                  }`}
                  onClick={() =>
                    setEnabledLevels((prev) => toggleLevelSet(prev, level))
                  }
                >
                  {level}
                </button>
              )}
            </For>
          </div>

          <select
            class="bg-surface text-text text-xs px-2 py-1 rounded border border-border"
            value={sourceFilter()}
            onChange={(e) => setSourceFilter(e.currentTarget.value)}
          >
            <option value="">all sources</option>
            <For each={sourceOptions()}>
              {(opt) => <option value={opt.id}>{opt.name}</option>}
            </For>
          </select>

          <button
            class={`px-1.5 py-0.5 rounded text-xs transition-colors ${
              autoScroll()
                ? 'bg-surface-2 text-text'
                : 'text-text-dim opacity-50'
            }`}
            onClick={() => {
              const wasOn = autoScroll();
              setAutoScroll(!wasOn);
              if (!wasOn && containerRef) {
                containerRef.scrollTop = containerRef.scrollHeight;
              }
            }}
            title="Auto-scroll"
          >
            ↓ auto
          </button>

          <button
            class="px-1.5 py-0.5 rounded text-xs text-text-dim hover:text-text hover:bg-surface-2 transition-colors"
            onClick={exportLogs}
            title="Export logs as text"
          >
            export
          </button>

          <button
            class="px-1.5 py-0.5 rounded text-xs text-red hover:bg-red/10 transition-colors"
            onClick={handleClear}
            title="Clear all logs"
          >
            clear
          </button>
        </div>

        <div
          ref={containerRef}
          class="flex-1 overflow-auto p-2 text-xs font-mono min-h-0"
        >
          <For each={filteredLogs()}>
            {(line) => (
              <LogLine
                line={line}
                class="hover:bg-surface-2/50"
                badgeWidth="w-12 text-center"
              />
            )}
          </For>
        </div>

        <div class="flex items-center justify-between px-3 py-1 border-t border-border text-xs text-text-dim shrink-0">
          <span>
            {status() === 'connected'
              ? 'Connected'
              : status() === 'connecting'
                ? 'Connecting...'
                : 'Disconnected'}
          </span>
          <Show when={filterActive()}>
            <span>
              showing {filteredLogs().length} of {logs.lines.length}
            </span>
          </Show>
        </div>
      </div>
    </>
  );
}
