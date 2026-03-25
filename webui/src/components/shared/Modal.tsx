import { Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: JSX.Element;
}

export default function Modal(props: ModalProps) {
  return (
    <Show when={props.open}>
      <Portal>
        <div
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={(e) => {
            if (e.target === e.currentTarget) props.onClose();
          }}
        >
          <div class="bg-surface border border-border rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[80vh] overflow-auto">
            <Show when={props.title}>
              <div class="flex items-center justify-between px-4 py-3 border-b border-border">
                <h2 class="text-text-bright font-semibold text-sm">
                  {props.title}
                </h2>
                <button
                  class="text-text-dim hover:text-text-bright"
                  onClick={() => props.onClose()}
                >
                  &#x2715;
                </button>
              </div>
            </Show>
            <div class="p-4">{props.children}</div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
