import type { RouteSectionProps } from '@solidjs/router';
import { ErrorBoundary, Suspense } from 'solid-js';

import Nav from '~/components/Nav';
import Sidebar from '~/components/Sidebar';
import ErrorFallback from '~/components/shared/ErrorFallback';
import PageLoading from '~/components/shared/PageLoading';
import ToastContainer from '~/components/shared/Toast';
import { createEventSource, EventSourceContext } from '~/lib/event-source';

export default function ShellLayout(props: RouteSectionProps) {
  const eventSource = createEventSource();

  return (
    <EventSourceContext.Provider value={eventSource}>
      <div class="flex flex-col h-screen">
        <Nav />
        <div class="flex flex-1 min-h-0">
          <main class="flex-1 overflow-auto min-h-0">
            <ErrorBoundary
              fallback={(err, reset) => (
                <ErrorFallback error={err} reset={reset} />
              )}
            >
              <Suspense fallback={<PageLoading />}>{props.children}</Suspense>
            </ErrorBoundary>
          </main>
          <Sidebar />
        </div>
      </div>
      <ToastContainer />
    </EventSourceContext.Provider>
  );
}
