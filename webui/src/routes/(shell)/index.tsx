import { Title } from '@solidjs/meta';
import { ErrorBoundary, lazy } from 'solid-js';

import StatsBar from '~/components/dashboard/StatsBar';
import ErrorFallback from '~/components/shared/ErrorFallback';

const TopologyCanvas = lazy(
  () => import('~/components/dashboard/TopologyCanvas'),
);

export default function Dashboard() {
  return (
    <>
      <Title>OmniClaw — Dashboard</Title>
      <ErrorBoundary
        fallback={(err, reset) => (
          <ErrorFallback error={err} reset={reset} context="Dashboard" />
        )}
      >
        <div class="flex flex-col h-full p-4 gap-4 min-h-0">
          <StatsBar />
          <div class="flex-1 min-h-0 flex flex-col">
            <TopologyCanvas />
          </div>
        </div>
      </ErrorBoundary>
    </>
  );
}
