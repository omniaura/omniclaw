import { createSignal, For, Show } from 'solid-js';

import Modal from '~/components/shared/Modal';
import { showToast } from '~/components/shared/Toast';
import { agents } from '~/lib/stores/agents';
import { api } from '~/lib/api';

interface CreateTaskModalProps {
  open: boolean;
  onClose: () => void;
}

export default function CreateTaskModal(props: CreateTaskModalProps) {
  const [agentChannel, setAgentChannel] = createSignal('');
  const [prompt, setPrompt] = createSignal('');
  const [scheduleType, setScheduleType] = createSignal<
    'cron' | 'interval' | 'once'
  >('cron');
  const [scheduleValue, setScheduleValue] = createSignal('');
  const [contextMode, setContextMode] = createSignal<'isolated' | 'group'>(
    'isolated',
  );
  const [error, setError] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);

  const agentOptions = () =>
    agents.list.flatMap((a) =>
      a.channels.map((ch) => ({
        value: `${a.folder}|${ch.jid}`,
        label: `${a.name} \u2014 ${ch.displayName}`,
      })),
    );

  function reset() {
    setAgentChannel('');
    setPrompt('');
    setScheduleType('cron');
    setScheduleValue('');
    setContextMode('isolated');
    setError('');
    setSubmitting(false);
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    setError('');

    const av = agentChannel();
    if (!av) {
      setError('Select an agent');
      return;
    }

    const [groupFolder, chatJid] = av.split('|');
    setSubmitting(true);

    try {
      const task = await api.createTask({
        group_folder: groupFolder,
        chat_jid: chatJid,
        prompt: prompt(),
        schedule_type: scheduleType(),
        schedule_value: scheduleValue(),
        context_mode: contextMode(),
        next_run: null,
        status: 'active',
      });
      showToast(`Task created: ${task.id.slice(0, 12)}`, 'success');
      reset();
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={props.open}
      onClose={() => {
        reset();
        props.onClose();
      }}
      title="Create Scheduled Task"
    >
      <form onSubmit={handleSubmit} class="flex flex-col gap-3">
        <div class="flex flex-col gap-1">
          <label class="text-xs text-text-dim" for="ct-agent">
            Agent / Channel
          </label>
          <select
            id="ct-agent"
            class="bg-surface-2 border border-border rounded px-2 py-1.5 text-xs text-text"
            value={agentChannel()}
            onChange={(e) => setAgentChannel(e.currentTarget.value)}
            required
          >
            <option value="">Select agent&#8230;</option>
            <For each={agentOptions()}>
              {(opt) => <option value={opt.value}>{opt.label}</option>}
            </For>
          </select>
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-xs text-text-dim" for="ct-prompt">
            Prompt
          </label>
          <textarea
            id="ct-prompt"
            class="bg-surface-2 border border-border rounded px-2 py-1.5 text-xs text-text min-h-[60px] resize-y"
            placeholder="What should the agent do?"
            value={prompt()}
            onInput={(e) => setPrompt(e.currentTarget.value)}
            required
          />
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-xs text-text-dim" for="ct-schedule-type">
            Schedule Type
          </label>
          <select
            id="ct-schedule-type"
            class="bg-surface-2 border border-border rounded px-2 py-1.5 text-xs text-text"
            value={scheduleType()}
            onChange={(e) =>
              setScheduleType(
                e.currentTarget.value as 'cron' | 'interval' | 'once',
              )
            }
            required
          >
            <option value="cron">Cron</option>
            <option value="interval">Interval (ms)</option>
            <option value="once">Once (ISO)</option>
          </select>
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-xs text-text-dim" for="ct-schedule-value">
            Schedule Value
          </label>
          <input
            id="ct-schedule-value"
            type="text"
            class="bg-surface-2 border border-border rounded px-2 py-1.5 text-xs text-text"
            placeholder="0 9 * * *"
            value={scheduleValue()}
            onInput={(e) => setScheduleValue(e.currentTarget.value)}
            required
          />
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-xs text-text-dim" for="ct-context-mode">
            Context Mode
          </label>
          <select
            id="ct-context-mode"
            class="bg-surface-2 border border-border rounded px-2 py-1.5 text-xs text-text"
            value={contextMode()}
            onChange={(e) =>
              setContextMode(e.currentTarget.value as 'isolated' | 'group')
            }
          >
            <option value="isolated">Isolated</option>
            <option value="group">Group (with history)</option>
          </select>
        </div>

        <Show when={error()}>
          <div class="text-red text-xs">{error()}</div>
        </Show>

        <div class="flex justify-end gap-2 pt-1">
          <button
            type="button"
            class="px-3 py-1.5 rounded text-xs text-text-dim hover:text-text border border-border hover:bg-surface-2"
            onClick={() => {
              reset();
              props.onClose();
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="px-3 py-1.5 rounded text-xs bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
            disabled={submitting()}
          >
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}
