import { stats } from '~/lib/stores/stats';

interface StatCardProps {
  label: string;
  value: string | number;
}

function StatCard(props: StatCardProps) {
  return (
    <div class="bg-surface rounded border border-border p-3 flex flex-col gap-1 min-w-0">
      <div class="text-text-dim text-xs">{props.label}</div>
      <div class="text-text-bright text-lg font-semibold tabular-nums">
        {props.value}
      </div>
    </div>
  );
}

export default function StatsBar() {
  const activeContainers = () =>
    Math.max(0, stats.activeContainers - stats.idleContainers);

  return (
    <div class="grid grid-cols-4 gap-3">
      <StatCard label="agents" value={stats.agents} />
      <StatCard
        label="active containers"
        value={`${activeContainers()}/${stats.maxActive}`}
      />
      <StatCard
        label="idle containers"
        value={`${stats.idleContainers}/${stats.maxIdle}`}
      />
      <StatCard label="active tasks" value={stats.activeTasks} />
    </div>
  );
}
