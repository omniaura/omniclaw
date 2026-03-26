import type { JSX } from 'solid-js';

import Badge from './Badge';

export function MetricRow(props: { label: string; value: string }) {
  return (
    <div class="flex justify-between items-center py-1.5 border-b border-border/50 last:border-b-0">
      <span class="text-text-dim text-xs">{props.label}</span>
      <span class="text-text-bright text-xs font-medium">{props.value}</span>
    </div>
  );
}

export function BooleanRow(props: {
  label: string;
  value: boolean;
  onLabel?: string;
  offLabel?: string;
}) {
  return (
    <div class="flex justify-between items-center py-1.5 border-b border-border/50 last:border-b-0">
      <span class="text-text-dim text-xs">{props.label}</span>
      <Badge variant={props.value ? 'active' : 'completed'}>
        {props.value
          ? (props.onLabel ?? 'enabled')
          : (props.offLabel ?? 'disabled')}
      </Badge>
    </div>
  );
}

export function MetricCard(props: { title: string; children: JSX.Element }) {
  return (
    <div class="bg-surface rounded-lg border border-border p-4">
      <div class="text-text-dim text-xs uppercase tracking-wider mb-3 font-medium">
        {props.title}
      </div>
      {props.children}
    </div>
  );
}
