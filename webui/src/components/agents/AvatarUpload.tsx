import { createSignal, For, Show } from 'solid-js';
import { api } from '~/lib/api';

interface AvatarUploadProps {
  agentId: string;
  currentUrl: string | null | undefined;
  onUpdated?: () => void;
}

const SOURCES = ['discord', 'telegram', 'slack', 'custom'] as const;

export default function AvatarUpload(props: AvatarUploadProps) {
  const [url, setUrl] = createSignal('');
  const [source, setSource] = createSignal<string>('custom');
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal('');

  const avatarImageUrl = () => api.getAgentAvatarImageUrl(props.agentId);

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      await api.setAgentAvatar(props.agentId, url() || null, source());
      setUrl('');
      props.onUpdated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update avatar');
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    setSaving(true);
    setError('');
    try {
      await api.setAgentAvatar(props.agentId, null, null);
      props.onUpdated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove avatar');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-3">
        <Show
          when={props.currentUrl}
          fallback={
            <div class="w-16 h-16 rounded-full bg-surface-2 border border-border flex items-center justify-center text-text-dim text-lg">
              ?
            </div>
          }
        >
          <img
            src={avatarImageUrl()}
            alt="avatar"
            class="w-16 h-16 rounded-full object-cover border border-border"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        </Show>
        <Show when={props.currentUrl}>
          <button
            class="px-2 py-1 text-xs rounded bg-red/20 text-red hover:bg-red/30 disabled:opacity-50"
            disabled={saving()}
            onClick={handleRemove}
          >
            remove
          </button>
        </Show>
      </div>

      <div class="flex flex-col gap-2">
        <input
          type="text"
          placeholder="Avatar URL..."
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
          class="w-full px-3 py-1.5 text-sm rounded bg-surface border border-border text-text placeholder:text-text-dim focus:outline-none focus:border-accent"
        />
        <div class="flex items-center gap-2">
          <select
            value={source()}
            onChange={(e) => setSource(e.currentTarget.value)}
            class="px-2 py-1 text-xs rounded bg-surface border border-border text-text focus:outline-none focus:border-accent"
          >
            <For each={[...SOURCES]}>
              {(s) => <option value={s}>{s}</option>}
            </For>
          </select>
          <button
            class="px-3 py-1 text-xs rounded bg-accent/20 text-accent hover:bg-accent/30 disabled:opacity-50"
            disabled={saving() || !url()}
            onClick={handleSave}
          >
            {saving() ? 'saving...' : 'set avatar'}
          </button>
        </div>
      </div>

      <Show when={error()}>
        <p class="text-xs text-red">{error()}</p>
      </Show>
    </div>
  );
}
