import { Show } from 'solid-js';

interface ErrorFallbackProps {
  error: unknown;
  reset: () => void;
  /** Optional page/section name for context. */
  context?: string;
}

/**
 * Reusable error fallback UI shown when an ErrorBoundary catches a render error.
 * Matches the OmniClaw design system.
 */
export default function ErrorFallback(props: ErrorFallbackProps) {
  const message = () => {
    const err = props.error;
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    return 'An unexpected error occurred';
  };

  return (
    <div class="flex flex-col items-center justify-center p-8 min-h-[200px]">
      <div class="bg-red/5 border border-red/20 rounded-lg p-6 max-w-lg w-full">
        <div class="flex items-center gap-2 mb-3">
          <span class="text-red text-lg">!</span>
          <span class="text-red text-sm font-medium">
            <Show when={props.context} fallback="Something went wrong">
              Error in {props.context}
            </Show>
          </span>
        </div>
        <p class="text-text-dim text-xs leading-relaxed mb-4">{message()}</p>
        <button
          type="button"
          onClick={() => props.reset()}
          class="px-3 py-1.5 rounded text-xs font-medium bg-surface-2 border border-border text-text hover:text-text-bright hover:border-border-bright transition-colors"
        >
          retry
        </button>
      </div>
    </div>
  );
}
