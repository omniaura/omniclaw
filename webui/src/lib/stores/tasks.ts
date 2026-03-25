import { createStore, reconcile } from 'solid-js/store';

export interface TaskState {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
  executing_since: string | null;
}

interface TasksState {
  list: TaskState[];
}

const [tasks, setTasks] = createStore<TasksState>({ list: [] });

export { tasks };

export function updateTasks(data: TaskState[]) {
  setTasks('list', reconcile(data));
}
