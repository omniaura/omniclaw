import { Title } from '@solidjs/meta';
import {
  createSignal,
  createResource,
  ErrorBoundary,
  For,
  Show,
  createMemo,
} from 'solid-js';
import { createStore } from 'solid-js/store';

import Modal from '~/components/shared/Modal';
import { showToast } from '~/components/shared/Toast';
import TaskCard from '~/components/tasks/TaskCard';
import TaskRunHistory from '~/components/tasks/TaskRunHistory';
import { api, type AgentChannelData } from '~/lib/api';
import ErrorFallback from '~/components/shared/ErrorFallback';

type StatusFilter = 'all' | 'active' | 'paused' | 'completed';

interface TaskFormState {
  agent: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'isolated' | 'group';
}

const EMPTY_FORM: TaskFormState = {
  agent: '',
  prompt: '',
  schedule_type: 'cron',
  schedule_value: '',
  context_mode: 'isolated',
};

function schedulePreview(type: string, value: string): string {
  if (!value.trim()) return '';
  if (type === 'cron') return cronPreview(value);
  if (type === 'interval') {
    const ms = parseInt(value, 10);
    if (isNaN(ms)) return '';
    if (ms < 1000) return `Every ${ms}ms`;
    if (ms < 60_000) return `Every ${(ms / 1000).toFixed(0)}s`;
    if (ms < 3_600_000) return `Every ${(ms / 60_000).toFixed(0)}m`;
    return `Every ${(ms / 3_600_000).toFixed(1)}h`;
  }
  if (type === 'once') {
    try {
      return `At: ${new Date(value).toLocaleString()}`;
    } catch {
      return '';
    }
  }
  return '';
}

const FILTERS: { label: string; value: StatusFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Active', value: 'active' },
  { label: 'Paused', value: 'paused' },
  { label: 'Completed', value: 'completed' },
];

function cronPreview(expr: string): string {
  const p = expr.trim().split(/\s+/);
  if (p.length < 5) return '';
  const [min, hr, dom, mon, dow] = p;
  if (
    min.includes('/') &&
    hr === '*' &&
    dom === '*' &&
    mon === '*' &&
    dow === '*'
  ) {
    const n = min.split('/')[1];
    return `Every ${n} minute${n === '1' ? '' : 's'}`;
  }
  if (hr.includes('/') && dom === '*' && mon === '*' && dow === '*') {
    const n = hr.split('/')[1];
    return `Every ${n} hour${n === '1' ? '' : 's'}`;
  }
  if (
    /^\d+$/.test(min) &&
    /^\d+$/.test(hr) &&
    dom === '*' &&
    mon === '*' &&
    dow === '*'
  ) {
    const h = parseInt(hr, 10);
    const m = parseInt(min, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `Daily at ${h12}:${m < 10 ? '0' : ''}${m} ${ampm}`;
  }
  if (
    /^\d+$/.test(min) &&
    /^\d+$/.test(hr) &&
    dom === '*' &&
    mon === '*' &&
    dow !== '*'
  ) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayNames = dow
      .split(',')
      .map((d) => days[parseInt(d, 10)] || d)
      .join(', ');
    const h = parseInt(hr, 10);
    const m = parseInt(min, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${dayNames} at ${h12}:${m < 10 ? '0' : ''}${m} ${ampm}`;
  }
  return '';
}

export default function Tasks() {
  const [tasks, { refetch }] = createResource(() => api.getTasks());
  const [agents] = createResource(() => api.getAgents());

  const [filter, setFilter] = createSignal<StatusFilter>('all');
  const [createOpen, setCreateOpen] = createSignal(false);
  const [editOpen, setEditOpen] = createSignal(false);
  const [deleteOpen, setDeleteOpen] = createSignal(false);
  const [runHistoryId, setRunHistoryId] = createSignal<string | null>(null);
  const [editingTaskId, setEditingTaskId] = createSignal<string | null>(null);
  const [deletingTaskId, setDeletingTaskId] = createSignal<string | null>(null);
  const [formError, setFormError] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);

  const [createForm, setCreateForm] = createStore<TaskFormState>({
    ...EMPTY_FORM,
  });
  const [editForm, setEditForm] = createStore<TaskFormState>({ ...EMPTY_FORM });

  const agentOptions = createMemo(() => {
    const data = agents();
    if (!data) return [];
    return data
      .filter((a: AgentChannelData) => !a.remoteInstanceId)
      .flatMap((a: AgentChannelData) =>
        a.channels.map((ch) => ({
          value: `${a.folder}|${ch.jid}`,
          label: `${a.name} \u2014 ${ch.displayName}`,
        })),
      );
  });

  const filteredTasks = createMemo(() => {
    const all = tasks() ?? [];
    const f = filter();
    if (f === 'all') return all;
    return all.filter((t) => t.status === f);
  });

  const stats = createMemo(() => {
    const all = tasks() ?? [];
    let active = 0,
      paused = 0,
      completed = 0;
    for (const t of all) {
      if (t.status === 'active') active++;
      else if (t.status === 'paused') paused++;
      else if (t.status === 'completed') completed++;
    }
    return { total: all.length, active, paused, completed };
  });

  async function handleToggle(id: string, newStatus: 'active' | 'paused') {
    try {
      await api.updateTask(id, { status: newStatus });
      showToast(
        `Task ${newStatus === 'paused' ? 'paused' : 'resumed'}`,
        'success',
      );
      refetch();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  }

  async function handleCreate() {
    setFormError('');
    if (!createForm.agent) {
      setFormError('Select an agent');
      return;
    }
    const [group_folder, chat_jid] = createForm.agent.split('|');
    setSubmitting(true);
    try {
      const created = await api.createTask({
        group_folder,
        chat_jid,
        prompt: createForm.prompt,
        schedule_type: createForm.schedule_type,
        schedule_value: createForm.schedule_value,
        context_mode: createForm.context_mode,
        next_run: null,
        status: 'active',
      });
      showToast(`Task created: ${created.id.slice(0, 12)}`, 'success');
      setCreateOpen(false);
      setCreateForm({ ...EMPTY_FORM });
      refetch();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function openEdit(id: string) {
    try {
      const task = await api.getTask(id);
      setEditingTaskId(id);
      setEditForm({
        agent: `${task.group_folder}|${task.chat_jid}`,
        prompt: task.prompt,
        schedule_type: task.schedule_type,
        schedule_value: task.schedule_value,
        context_mode: task.context_mode,
      });
      setFormError('');
      setEditOpen(true);
    } catch (err) {
      showToast(
        `Failed to load task: ${err instanceof Error ? err.message : 'unknown'}`,
        'error',
      );
    }
  }

  async function handleEdit() {
    const id = editingTaskId();
    if (!id) return;
    setFormError('');
    setSubmitting(true);
    try {
      await api.updateTask(id, {
        prompt: editForm.prompt,
        schedule_type: editForm.schedule_type,
        schedule_value: editForm.schedule_value,
      });
      showToast('Task updated', 'success');
      setEditOpen(false);
      setEditingTaskId(null);
      refetch();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSubmitting(false);
    }
  }

  function openDelete(id: string) {
    setDeletingTaskId(id);
    setDeleteOpen(true);
  }

  async function handleDelete() {
    const id = deletingTaskId();
    if (!id) return;
    setSubmitting(true);
    try {
      await api.deleteTask(id);
      showToast('Task deleted', 'success');
      setDeleteOpen(false);
      setDeletingTaskId(null);
      refetch();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Title>OmniClaw — Tasks</Title>
      <ErrorBoundary
        fallback={(err, reset) => (
          <ErrorFallback error={err} reset={reset} context="Tasks" />
        )}
      >
        <div class="p-4">
          <div class="flex items-center justify-between mb-3">
            <h2 class="text-text-bright font-semibold text-sm">Task Manager</h2>
            <button
              class="px-3 py-1 text-xs rounded bg-accent text-bg font-semibold hover:bg-accent-hover"
              onClick={() => {
                setCreateForm({ ...EMPTY_FORM });
                setFormError('');
                setCreateOpen(true);
              }}
            >
              + Create Task
            </button>
          </div>

          <div class="flex gap-3 mb-3 text-xs">
            <span class="text-text-dim">{stats().total} total</span>
            <span class="text-green">{stats().active} active</span>
            <span class="text-yellow">{stats().paused} paused</span>
            <span class="text-text-dim">{stats().completed} completed</span>
          </div>

          <div class="flex gap-1 mb-4">
            <For each={FILTERS}>
              {(f) => (
                <button
                  class={`px-2 py-1 rounded text-xs transition-colors ${
                    filter() === f.value
                      ? 'bg-accent/20 text-accent'
                      : 'text-text-dim hover:text-text hover:bg-surface-2'
                  }`}
                  onClick={() => setFilter(f.value)}
                >
                  {f.label}
                </button>
              )}
            </For>
          </div>

          <div class="border border-border rounded-lg overflow-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="border-b border-border text-text-dim text-left">
                  <th class="px-3 py-2">status</th>
                  <th class="px-3 py-2">agent</th>
                  <th class="px-3 py-2">prompt</th>
                  <th class="px-3 py-2">schedule</th>
                  <th class="px-3 py-2">next run</th>
                  <th class="px-3 py-2">last run</th>
                  <th class="px-3 py-2">context</th>
                  <th class="px-3 py-2">actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={filteredTasks()}>
                  {(task) => (
                    <TaskCard
                      task={task}
                      onToggle={handleToggle}
                      onEdit={openEdit}
                      onDelete={openDelete}
                      onViewRuns={(id) => setRunHistoryId(id)}
                    />
                  )}
                </For>
              </tbody>
            </table>
            <Show when={filteredTasks().length === 0}>
              <div class="text-text-dim text-xs p-4 text-center">
                <Show
                  when={(tasks() ?? []).length === 0}
                  fallback="No tasks match the current filter."
                >
                  No scheduled tasks yet. Create one to get started.
                </Show>
              </div>
            </Show>
          </div>

          <Show when={runHistoryId()}>
            {(id) => (
              <TaskRunHistory
                taskId={id()}
                onClose={() => setRunHistoryId(null)}
              />
            )}
          </Show>

          <Modal
            open={createOpen()}
            onClose={() => setCreateOpen(false)}
            title="Create Scheduled Task"
          >
            <TaskForm
              form={createForm}
              setForm={setCreateForm}
              agentOptions={agentOptions()}
              error={formError()}
              submitting={submitting()}
              submitLabel="Create"
              onSubmit={handleCreate}
              onCancel={() => setCreateOpen(false)}
            />
          </Modal>

          <Modal
            open={editOpen()}
            onClose={() => {
              setEditOpen(false);
              setEditingTaskId(null);
            }}
            title="Edit Task"
          >
            <TaskForm
              form={editForm}
              setForm={setEditForm}
              agentOptions={agentOptions()}
              error={formError()}
              submitting={submitting()}
              submitLabel="Save Changes"
              onSubmit={handleEdit}
              onCancel={() => {
                setEditOpen(false);
                setEditingTaskId(null);
              }}
            />
          </Modal>

          <Modal
            open={deleteOpen()}
            onClose={() => {
              setDeleteOpen(false);
              setDeletingTaskId(null);
            }}
            title="Delete Task"
          >
            <p class="text-text text-xs mb-4">
              Delete task {deletingTaskId()?.slice(0, 20)}...?
            </p>
            <div class="flex justify-end gap-2">
              <button
                class="px-3 py-1 text-xs rounded bg-surface-2 text-text-dim hover:text-text-bright border border-border"
                onClick={() => {
                  setDeleteOpen(false);
                  setDeletingTaskId(null);
                }}
              >
                Cancel
              </button>
              <button
                class="px-3 py-1 text-xs rounded bg-red/10 text-red hover:bg-red/20 border border-red/20"
                disabled={submitting()}
                onClick={handleDelete}
              >
                Delete
              </button>
            </div>
          </Modal>
        </div>
      </ErrorBoundary>
    </>
  );
}

interface TaskFormProps {
  form: TaskFormState;
  setForm: (key: keyof TaskFormState, value: string) => void;
  agentOptions: { value: string; label: string }[];
  error: string;
  submitting: boolean;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
}

function TaskForm(props: TaskFormProps) {
  const preview = () =>
    schedulePreview(props.form.schedule_type, props.form.schedule_value);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
    >
      <div class="mb-3">
        <label class="block text-text-dim text-xs mb-1">Agent / Channel</label>
        <select
          class="w-full bg-surface-2 border border-border rounded px-2 py-1 text-xs text-text"
          value={props.form.agent}
          onChange={(e) => props.setForm('agent', e.currentTarget.value)}
        >
          <option value="">Select agent...</option>
          <For each={props.agentOptions}>
            {(opt) => <option value={opt.value}>{opt.label}</option>}
          </For>
        </select>
      </div>

      <div class="mb-3">
        <label class="block text-text-dim text-xs mb-1">Prompt</label>
        <textarea
          class="w-full bg-surface-2 border border-border rounded px-2 py-1 text-xs text-text min-h-[60px]"
          placeholder="What should the agent do?"
          required
          value={props.form.prompt}
          onInput={(e) => props.setForm('prompt', e.currentTarget.value)}
        />
      </div>

      <div class="mb-3">
        <label class="block text-text-dim text-xs mb-1">Schedule Type</label>
        <select
          class="w-full bg-surface-2 border border-border rounded px-2 py-1 text-xs text-text"
          value={props.form.schedule_type}
          onChange={(e) =>
            props.setForm('schedule_type', e.currentTarget.value)
          }
        >
          <option value="cron">Cron</option>
          <option value="interval">Interval (ms)</option>
          <option value="once">Once (ISO timestamp)</option>
        </select>
      </div>

      <div class="mb-3">
        <label class="block text-text-dim text-xs mb-1">Schedule Value</label>
        <input
          class="w-full bg-surface-2 border border-border rounded px-2 py-1 text-xs text-text"
          type="text"
          placeholder="0 9 * * *"
          required
          value={props.form.schedule_value}
          onInput={(e) =>
            props.setForm('schedule_value', e.currentTarget.value)
          }
        />
        <Show when={preview()}>
          <div class="text-text-dim text-xs mt-1">{preview()}</div>
        </Show>
      </div>

      <div class="mb-3">
        <label class="block text-text-dim text-xs mb-1">Context Mode</label>
        <select
          class="w-full bg-surface-2 border border-border rounded px-2 py-1 text-xs text-text"
          value={props.form.context_mode}
          onChange={(e) => props.setForm('context_mode', e.currentTarget.value)}
        >
          <option value="isolated">Isolated</option>
          <option value="group">Group (with history)</option>
        </select>
      </div>

      <Show when={props.error}>
        <div class="text-red text-xs mb-3">{props.error}</div>
      </Show>

      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="px-3 py-1 text-xs rounded bg-surface-2 text-text-dim hover:text-text-bright border border-border"
          onClick={() => props.onCancel()}
        >
          Cancel
        </button>
        <button
          type="submit"
          class="px-3 py-1 text-xs rounded bg-accent text-bg font-semibold hover:bg-accent-hover"
          disabled={props.submitting}
        >
          {props.submitLabel}
        </button>
      </div>
    </form>
  );
}
