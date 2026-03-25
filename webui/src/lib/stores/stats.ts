import { createStore, reconcile } from 'solid-js/store';

export interface StatsState {
  agents: number;
  activeTasks: number;
  pausedTasks: number;
  completedTasks: number;
  activeContainers: number;
  idleContainers: number;
  maxActive: number;
  maxIdle: number;
}

const [stats, setStats] = createStore<StatsState>({
  agents: 0,
  activeTasks: 0,
  pausedTasks: 0,
  completedTasks: 0,
  activeContainers: 0,
  idleContainers: 0,
  maxActive: 0,
  maxIdle: 0,
});

export { stats };

export function updateStats(data: Partial<StatsState>) {
  setStats(reconcile({ ...stats, ...data }));
}
