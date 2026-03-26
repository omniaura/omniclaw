import type { RouteSectionProps } from '@solidjs/router';
import { Suspense } from 'solid-js';

import Nav from '~/components/Nav';
import Sidebar from '~/components/Sidebar';
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
            <Suspense>{props.children}</Suspense>
          </main>
          <Sidebar />
        </div>
      </div>
      <ToastContainer />
    </EventSourceContext.Provider>
  );
}
