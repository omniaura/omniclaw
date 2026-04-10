import { Show } from 'solid-js';

interface PageLoadingProps {
  /** Optional description shown below the spinner. */
  label?: string;
}

/**
 * Full-page loading indicator with a pulsing dot animation.
 * Used as the Suspense fallback for page routes.
 */
export default function PageLoading(props: PageLoadingProps) {
  return (
    <div class="flex flex-col items-center justify-center p-12 min-h-[200px]">
      <div class="flex gap-1.5 mb-3">
        <span class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
        <span
          class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse"
          style={{ 'animation-delay': '150ms' }}
        />
        <span
          class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse"
          style={{ 'animation-delay': '300ms' }}
        />
      </div>
      <Show when={props.label}>
        {(label) => <span class="text-text-dim text-xs">{label()}</span>}
      </Show>
    </div>
  );
}
