import { Title } from '@solidjs/meta';
import {
  createSignal,
  createMemo,
  createResource,
  ErrorBoundary,
  Show,
  For,
  Suspense,
} from 'solid-js';
import { isServer } from 'solid-js/web';

import { api } from '~/lib/api';
import AgentCard from '~/components/agents/AgentCard';
import ErrorFallback from '~/components/shared/ErrorFallback';
import PageLoading from '~/components/shared/PageLoading';

export default function Agents() {
  // Skip fetch during SSR — relative URLs have no origin on the server
  const [agents] = createResource(
    () => !isServer,
    (ok) => (ok ? api.getAgents() : []),
  );
  const [search, setSearch] = createSignal('');
  const [backendFilter, setBackendFilter] = createSignal('');
  const [runtimeFilter, setRuntimeFilter] = createSignal('');

  const list = createMemo(() => agents() ?? []);

  const backends = createMemo(() =>
    [...new Set(list().map((a) => a.backend))].sort(),
  );

  const runtimes = createMemo(() =>
    [...new Set(list().map((a) => a.agentRuntime))].sort(),
  );

  const filtered = createMemo(() => {
    const q = search().toLowerCase();
    const be = backendFilter();
    const rt = runtimeFilter();
    return list().filter((a) => {
      if (
        q &&
        !a.name.toLowerCase().includes(q) &&
        !a.id.toLowerCase().includes(q)
      )
        return false;
      if (be && a.backend !== be) return false;
      if (rt && a.agentRuntime !== rt) return false;
      return true;
    });
  });

  const counts = createMemo(() => {
    let local = 0;
    let remote = 0;
    for (const a of list()) {
      if (a.remoteInstanceId) remote++;
      else local++;
    }
    return { local, remote, total: local + remote };
  });

  return (
    <>
      <Title>OmniClaw — Agents</Title>
      <div class="p-4 space-y-4">
        <div class="flex items-center justify-between flex-wrap gap-2">
          <h2 class="text-xl font-semibold text-text-bright">Agents</h2>
          <Suspense>
            <div class="flex gap-3 text-sm text-text-dim">
              <span>{counts().total} total</span>
              <span>{counts().local} local</span>
              <Show when={counts().remote > 0}>
                <span>{counts().remote} remote</span>
              </Show>
            </div>
          </Suspense>
        </div>

        <div class="flex gap-2 flex-wrap">
          <input
            type="text"
            placeholder="Search agents..."
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
            class="px-3 py-1.5 rounded bg-surface-2 border border-border text-text text-sm placeholder:text-text-dim focus:outline-none focus:border-accent"
          />
          <select
            value={backendFilter()}
            onChange={(e) => setBackendFilter(e.currentTarget.value)}
            class="px-3 py-1.5 rounded bg-surface-2 border border-border text-text text-sm focus:outline-none focus:border-accent"
          >
            <option value="">All backends</option>
            <For each={backends()}>{(b) => <option value={b}>{b}</option>}</For>
          </select>
          <select
            value={runtimeFilter()}
            onChange={(e) => setRuntimeFilter(e.currentTarget.value)}
            class="px-3 py-1.5 rounded bg-surface-2 border border-border text-text text-sm focus:outline-none focus:border-accent"
          >
            <option value="">All runtimes</option>
            <For each={runtimes()}>{(r) => <option value={r}>{r}</option>}</For>
          </select>
        </div>

        <ErrorBoundary
          fallback={(err, reset) => (
            <ErrorFallback error={err} reset={reset} context="Agents" />
          )}
        >
          <Suspense fallback={<PageLoading label="Loading agents..." />}>
            <div class="overflow-x-auto rounded border border-border">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-border bg-surface text-text-dim text-left">
                    <th class="px-3 py-2 font-medium">Agent</th>
                    <th class="px-3 py-2 font-medium">Backend</th>
                    <th class="px-3 py-2 font-medium">Runtime</th>
                    <th class="px-3 py-2 font-medium text-center">Channels</th>
                    <th class="px-3 py-2 font-medium text-center">Tasks</th>
                    <th class="px-3 py-2 font-medium">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  <For
                    each={filtered()}
                    fallback={
                      <tr>
                        <td
                          colspan="6"
                          class="px-3 py-8 text-center text-text-dim"
                        >
                          <Show
                            when={list().length > 0}
                            fallback="No agents registered."
                          >
                            No agents match the current filters.
                          </Show>
                        </td>
                      </tr>
                    }
                  >
                    {(agent) => <AgentCard agent={agent} taskCount={0} />}
                  </For>
                </tbody>
              </table>
            </div>
          </Suspense>
        </ErrorBoundary>
      </div>
    </>
  );
}
