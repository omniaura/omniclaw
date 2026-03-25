import { createSignal, For, onCleanup } from 'solid-js';

export interface ToastMessage {
  id: number;
  text: string;
  type: 'info' | 'success' | 'error' | 'warning';
}

let nextId = 0;
const [toasts, setToasts] = createSignal<ToastMessage[]>([]);

export function showToast(
  text: string,
  type: ToastMessage['type'] = 'info',
  durationMs = 4000,
) {
  const id = nextId++;
  setToasts((prev) => [...prev, { id, text, type }]);
  setTimeout(() => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, durationMs);
}

const typeClasses: Record<ToastMessage['type'], string> = {
  info: 'bg-surface-2 border-border text-text',
  success: 'bg-green/10 border-green/30 text-green',
  error: 'bg-red/10 border-red/30 text-red',
  warning: 'bg-yellow/10 border-yellow/30 text-yellow',
};

export default function ToastContainer() {
  return (
    <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      <For each={toasts()}>
        {(toast) => (
          <div
            class={`px-4 py-2 rounded border text-sm shadow-lg ${typeClasses[toast.type]}`}
          >
            {toast.text}
          </div>
        )}
      </For>
    </div>
  );
}
