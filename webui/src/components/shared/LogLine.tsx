import { Show } from 'solid-js';

import type { LogLine as LogLineData } from '~/lib/stores/logs';

export const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export const levelColors: Record<string, string> = {
  debug: 'text-text-dim',
  info: 'text-blue',
  warn: 'text-yellow',
  error: 'text-red',
  fatal: 'bg-red text-bg px-1 rounded',
};

export function formatLogTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

export function toggleLevelSet(prev: Set<string>, level: string): Set<string> {
  const next = new Set(prev);
  if (next.has(level)) next.delete(level);
  else next.add(level);
  return next;
}

interface LogLineProps {
  line: LogLineData;
  class?: string;
  badgeWidth?: string;
}

export default function LogLine(props: LogLineProps) {
  return (
    <div class={`flex gap-1.5 py-px leading-relaxed ${props.class ?? ''}`}>
      <span class="text-text-dim shrink-0">{formatLogTime(props.line.ts)}</span>
      <span
        class={`shrink-0 ${props.badgeWidth ?? 'w-10'} ${levelColors[props.line.level] ?? 'text-text-dim'}`}
      >
        {props.line.level}
      </span>
      <Show when={props.line.container || props.line.group}>
        <span class="text-accent shrink-0">
          {props.line.container || props.line.group}
        </span>
      </Show>
      <Show when={props.line.op}>
        <span class="text-text-dim">[{props.line.op}]</span>
      </Show>
      <span class="text-text break-all">
        {props.line.msg}
        <Show when={props.line.durationMs != null}>
          {' '}
          ({props.line.durationMs}ms)
        </Show>
        <Show when={props.line.costUsd != null}> ${props.line.costUsd}</Show>
      </span>
      <Show when={props.line.err}>
        <span class="text-red break-all">{props.line.err}</span>
      </Show>
    </div>
  );
}
