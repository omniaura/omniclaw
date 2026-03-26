import { createSignal, createEffect, For, Show, on } from 'solid-js';

import { api, type ContextLayers } from '~/lib/api';
import { showToast } from '~/components/shared/Toast';

type LayerName = 'channel' | 'category' | 'server' | 'agent';

const LAYER_TABS: { key: LayerName; label: string }[] = [
  { key: 'channel', label: 'Channel' },
  { key: 'category', label: 'Category' },
  { key: 'server', label: 'Server' },
  { key: 'agent', label: 'Agent' },
];

interface LayerEditorProps {
  layers: ContextLayers;
  initialLayer?: LayerName;
  onLayerChange?: (layer: LayerName) => void;
  /** Called after a successful save so parent can refresh if needed. */
  onSaved?: () => void;
}

export default function LayerEditor(props: LayerEditorProps) {
  const [activeLayer, setActiveLayer] = createSignal<LayerName>(
    props.initialLayer ?? 'channel',
  );
  const [content, setContent] = createSignal('');
  const [originalContent, setOriginalContent] = createSignal('');
  const [saving, setSaving] = createSignal(false);

  createEffect(
    on(
      () => [props.layers, activeLayer()] as const,
      ([layers, layer]) => {
        const info = layers[layer];
        const text = info?.content ?? '';
        setOriginalContent(text);
        setContent(text);
      },
    ),
  );

  const dirty = () => content() !== originalContent();

  function layerPath(): string | null {
    return props.layers[activeLayer()]?.path ?? null;
  }

  function layerExists(layer: LayerName): boolean {
    return props.layers[layer]?.exists ?? false;
  }

  async function save() {
    const path = layerPath();
    if (!path || !dirty()) return;
    setSaving(true);
    try {
      await api.writeContextFile(path, content());
      setOriginalContent(content());
      showToast('Saved', 'success');
      props.onSaved?.();
    } catch (err) {
      showToast(
        `Save failed: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    } finally {
      setSaving(false);
    }
  }

  function revert() {
    setContent(originalContent());
  }

  function handleKeyDown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (dirty()) save();
    }
  }

  return (
    <div class="flex flex-col flex-1 min-h-0">
      {/* Layer tabs */}
      <div class="flex gap-1 px-4 py-2 border-b border-border bg-surface">
        <For each={LAYER_TABS}>
          {(tab) => (
            <button
              class={`flex items-center gap-1.5 px-3 py-1 rounded text-xs transition-colors ${
                activeLayer() === tab.key
                  ? 'bg-accent/20 text-accent'
                  : 'text-text-dim hover:text-text hover:bg-surface-2'
              }`}
              onClick={() => {
                setActiveLayer(tab.key);
                props.onLayerChange?.(tab.key);
              }}
            >
              <span
                class={`inline-block w-1.5 h-1.5 rounded-full ${
                  layerExists(tab.key) ? 'bg-green' : 'bg-text-dim/30'
                }`}
              />
              {tab.label}
            </button>
          )}
        </For>
      </div>

      {/* Path display */}
      <div class="px-4 py-1.5 text-xs text-text-dim border-b border-border bg-surface font-mono">
        <Show when={layerPath()} fallback={<span>No path for this layer</span>}>
          {(path) => (
            <span>
              {path()}/CLAUDE.md
              <span
                class={`ml-2 ${layerExists(activeLayer()) ? 'text-green' : 'text-yellow'}`}
              >
                ({layerExists(activeLayer()) ? 'exists' : 'new'})
              </span>
            </span>
          )}
        </Show>
      </div>

      {/* Textarea editor */}
      <div class="flex-1 min-h-0 overflow-hidden">
        <textarea
          class="w-full h-full resize-none p-4 bg-bg text-text text-sm font-mono leading-relaxed border-none outline-none"
          value={content()}
          onInput={(e) => setContent(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            layerPath()
              ? 'Enter context content...'
              : 'No path available for this layer'
          }
          disabled={!layerPath()}
          spellcheck={false}
        />
      </div>

      {/* Save bar */}
      <div class="flex items-center justify-between px-4 py-2 border-t border-border bg-surface">
        <span
          class={`text-xs ${saving() || dirty() ? 'text-yellow' : 'text-text-dim'}`}
        >
          {saving() ? 'Saving...' : dirty() ? 'Unsaved changes' : 'No changes'}
        </span>
        <div class="flex gap-2">
          <button
            class="px-3 py-1 rounded text-xs bg-surface-2 text-text-dim hover:text-text transition-colors disabled:opacity-40 disabled:cursor-default"
            disabled={!dirty()}
            onClick={revert}
          >
            Revert
          </button>
          <button
            class="px-3 py-1 rounded text-xs bg-accent/20 text-accent hover:bg-accent/30 transition-colors disabled:opacity-40 disabled:cursor-default"
            disabled={!dirty() || saving() || !layerPath()}
            onClick={save}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
