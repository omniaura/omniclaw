import { Title } from '@solidjs/meta';
import { query, createAsync, revalidate } from '@solidjs/router';
import { For, Show, onCleanup } from 'solid-js';

import Badge from '~/components/shared/Badge';
import { MetricCard, MetricRow } from '~/components/shared/MetricCard';
import { api } from '~/lib/api';

const fetchHealth = query(() => api.getHealth(), 'health');

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function BreakdownList(props: { items: Record<string, number> }) {
  const sorted = () => Object.entries(props.items).sort((a, b) => b[1] - a[1]);

  return (
    <For each={sorted()}>
      {(entry) => (
        <div class="flex justify-between items-center py-1 pl-2">
          <span class="text-text-dim text-xs">{entry[0]}</span>
          <span class="text-text text-xs">{entry[1]}</span>
        </div>
      )}
    </For>
  );
}

export default function System() {
  const health = createAsync(() => fetchHealth());

  const interval = setInterval(() => void revalidate('health'), 5000);
  onCleanup(() => clearInterval(interval));

  return (
    <>
      <Title>OmniClaw — System</Title>
      <div class="p-6">
        <div class="flex items-center gap-3 mb-6">
          <h2 class="text-text-bright text-lg font-medium">system health</h2>
          <Show when={health()}>
            {(h) => <Badge variant="active">{h().status}</Badge>}
          </Show>
        </div>

        <Show
          when={health()}
          fallback={<div class="text-text-dim">Loading...</div>}
        >
          {(h) => (
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <MetricCard title="server">
                <MetricRow label="version" value={h().version} />
                <MetricRow
                  label="uptime"
                  value={formatUptime(h().uptime_seconds)}
                />
                <MetricRow
                  label="started"
                  value={new Date(h().started_at).toLocaleString()}
                />
                <MetricRow
                  label="sse clients"
                  value={String(h().sse_clients)}
                />
              </MetricCard>

              <MetricCard title="runtime">
                <MetricRow label="bun" value={h().runtime.bun} />
                <MetricRow label="platform" value={h().runtime.platform} />
                <MetricRow label="arch" value={h().runtime.arch} />
              </MetricCard>

              <MetricCard title="memory">
                <MetricRow label="rss" value={`${h().memory.rss_mb} MB`} />
                <MetricRow
                  label="heap used"
                  value={`${h().memory.heap_used_mb} MB`}
                />
                <MetricRow
                  label="heap total"
                  value={`${h().memory.heap_total_mb} MB`}
                />
              </MetricCard>

              <MetricCard title="containers">
                <MetricRow
                  label="active"
                  value={`${h().containers.active}/${h().containers.max_active}`}
                />
                <MetricRow
                  label="idle"
                  value={`${h().containers.idle}/${h().containers.max_idle}`}
                />
              </MetricCard>

              <MetricCard title="agents">
                <MetricRow label="total" value={String(h().agents.total)} />
                <div class="text-text-dim text-[10px] uppercase tracking-wider mt-2 mb-1">
                  by backend
                </div>
                <BreakdownList items={h().agents.by_backend} />
                <div class="text-text-dim text-[10px] uppercase tracking-wider mt-2 mb-1">
                  by runtime
                </div>
                <BreakdownList items={h().agents.by_runtime} />
              </MetricCard>

              <MetricCard title="tasks">
                <MetricRow label="active" value={String(h().tasks.active)} />
                <MetricRow label="paused" value={String(h().tasks.paused)} />
                <MetricRow
                  label="completed"
                  value={String(h().tasks.completed)}
                />
                <MetricRow label="total" value={String(h().tasks.total)} />
              </MetricCard>
            </div>
          )}
        </Show>
      </div>
    </>
  );
}
