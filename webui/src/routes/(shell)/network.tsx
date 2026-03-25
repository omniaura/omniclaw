import { Title } from '@solidjs/meta';
import {
  createSignal,
  createResource,
  onCleanup,
  For,
  Show,
  Switch,
  Match,
  type JSX,
} from 'solid-js';

import Badge from '~/components/shared/Badge';
import { showToast } from '~/components/shared/Toast';
import type { ContextFileEntry } from '~/lib/api';

interface NetworkIdentity {
  id: string;
  label: string;
}

interface TrustedNetwork {
  id: string;
  label: string;
  trustedAt: string;
}

interface DiscoveryRuntime {
  enabled: boolean;
  active: boolean;
  currentNetwork: NetworkIdentity | null;
  trustedNetworks: TrustedNetwork[];
}

interface PeerView {
  instanceId: string;
  name: string;
  host: string;
  port: number;
  addresses: string[];
  status: 'discovered' | 'pending' | 'trusted' | 'revoked';
  online: boolean;
  approvedAt: string | null;
  lastSeen: string | null;
}

interface PairRequest {
  id: string;
  fromInstanceId: string;
  fromName: string;
  fromHost: string;
  fromPort: number;
  status: string;
}

interface RemoteAgent {
  id: string;
  name: string;
  backend: string;
  agentRuntime: string;
  channels: Array<{ jid: string; displayName: string }>;
}

interface ContextSyncComparison {
  same: ContextFileEntry[];
  differs: Array<{ local: ContextFileEntry; remote: ContextFileEntry }>;
  localOnly: ContextFileEntry[];
  remoteOnly: ContextFileEntry[];
}

interface RemoteLogRecord {
  level?: string;
  time?: string;
  timestamp?: string;
  source?: string;
  msg?: string;
  message?: string;
}

const POLL_INTERVAL_MS = 10_000;
const MAX_LOG_LINES = 200;

const BTN = 'px-2 py-1 text-xs rounded';
const BTN_DEFAULT = `${BTN} bg-surface-2 text-text hover:bg-border`;
const BTN_PRIMARY = `${BTN} bg-accent/20 text-accent hover:bg-accent/30`;
const BTN_DANGER = `${BTN} bg-red/20 text-red hover:bg-red/30`;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as Record<string, string>).error ?? `Request failed (${res.status})`,
    );
  }
  return res.json() as Promise<T>;
}

function postJson<T>(url: string, body?: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method: 'POST',
    headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1_048_576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1_048_576).toFixed(1)} MB`;
}

function StatusBadge(props: { status: PeerView['status'] }) {
  return (
    <Switch fallback={<Badge>{props.status}</Badge>}>
      <Match when={props.status === 'trusted'}>
        <Badge variant="admin">trusted</Badge>
      </Match>
      <Match when={props.status === 'pending'}>
        <Badge variant="paused">pending</Badge>
      </Match>
      <Match when={props.status === 'revoked'}>
        <Badge variant="error">revoked</Badge>
      </Match>
    </Switch>
  );
}

function PeerActions(props: {
  peer: PeerView;
  onBrowse: (id: string) => void;
  onLogs: (id: string) => void;
  onSync: (id: string) => void;
  onRevoke: (id: string) => void;
  onRequest: (id: string) => void;
}) {
  return (
    <Switch
      fallback={
        <Show
          when={props.peer.online}
          fallback={<span class="text-text-dim text-xs">offline</span>}
        >
          <button
            class={BTN_PRIMARY}
            onClick={() => props.onRequest(props.peer.instanceId)}
          >
            Request Access
          </button>
        </Show>
      }
    >
      <Match when={props.peer.status === 'trusted'}>
        <div class="flex gap-1 flex-wrap">
          <button class={BTN_DEFAULT} onClick={() => props.onBrowse(props.peer.instanceId)}>
            Browse
          </button>
          <button class={BTN_DEFAULT} onClick={() => props.onLogs(props.peer.instanceId)}>
            Logs
          </button>
          <button class={BTN_PRIMARY} onClick={() => props.onSync(props.peer.instanceId)}>
            Sync
          </button>
          <button class={BTN_DANGER} onClick={() => props.onRevoke(props.peer.instanceId)}>
            Revoke
          </button>
        </div>
      </Match>
      <Match when={props.peer.status === 'pending'}>
        <span class="text-text-dim text-xs">awaiting approval...</span>
      </Match>
    </Switch>
  );
}

function TrustedNetworksList(props: {
  networks: TrustedNetwork[];
  onUntrust: (id: string) => void;
}) {
  return (
    <Show
      when={props.networks.length > 0}
      fallback={
        <div class="p-4 border border-dashed border-border rounded-lg text-text-dim text-sm">
          No trusted Wi-Fi networks yet.
        </div>
      }
    >
      <For each={props.networks}>
        {(net) => (
          <div class="flex justify-between items-center py-3 border-t border-border">
            <div>
              <div class="font-semibold text-text">{net.label}</div>
              <div class="text-xs text-text-dim">{net.id}</div>
            </div>
            <button class={BTN_DANGER} onClick={() => props.onUntrust(net.id)}>
              Remove
            </button>
          </div>
        )}
      </For>
    </Show>
  );
}

function PendingRequestsPanel(props: {
  requests: PairRequest[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  return (
    <div class="bg-surface rounded-lg border border-border">
      <div class="px-4 py-3 border-b border-border flex items-center gap-2">
        <h2 class="text-sm font-semibold text-text">pending requests</h2>
        <Badge>{String(props.requests.length)}</Badge>
      </div>
      <div class="p-4">
        <Show
          when={props.requests.length > 0}
          fallback={
            <div class="py-6 text-center text-text-dim text-sm">
              No pending requests
            </div>
          }
        >
          <For each={props.requests}>
            {(req) => (
              <div class="bg-surface-2 rounded-lg p-3 mb-3 last:mb-0">
                <div class="font-semibold text-text mb-1">{req.fromName}</div>
                <div class="text-xs text-text-dim mb-2">
                  <code>
                    {req.fromHost}:{req.fromPort}
                  </code>
                  <br />
                  ID: <code>{req.fromInstanceId.slice(0, 8)}...</code>
                </div>
                <div class="flex gap-2">
                  <button class={BTN_PRIMARY} onClick={() => props.onApprove(req.id)}>
                    Approve
                  </button>
                  <button class={BTN_DANGER} onClick={() => props.onReject(req.id)}>
                    Reject
                  </button>
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

function RemoteAgentsPanel(props: { agents: RemoteAgent[] }) {
  return (
    <div class="bg-surface rounded-lg border border-border mt-6">
      <div class="px-4 py-3 border-b border-border">
        <h2 class="text-sm font-semibold text-text">
          remote agents ({props.agents.length})
        </h2>
      </div>
      <Show
        when={props.agents.length > 0}
        fallback={
          <div class="p-8 text-center text-text-dim">
            No agents found on remote instance
          </div>
        }
      >
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-border text-text-dim text-xs">
                <th class="text-left px-4 py-2">id</th>
                <th class="text-left px-4 py-2">name</th>
                <th class="text-left px-4 py-2">backend</th>
                <th class="text-left px-4 py-2">runtime</th>
                <th class="text-left px-4 py-2">channels</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.agents}>
                {(agent) => (
                  <tr class="border-b border-border">
                    <td class="px-4 py-2 text-text">{agent.id}</td>
                    <td class="px-4 py-2 text-text">{agent.name}</td>
                    <td class="px-4 py-2">
                      <Badge>{agent.backend}</Badge>
                    </td>
                    <td class="px-4 py-2 text-text">{agent.agentRuntime}</td>
                    <td class="px-4 py-2 text-text">
                      <Show
                        when={agent.channels && agent.channels.length > 0}
                        fallback="-"
                      >
                        <For each={agent.channels}>
                          {(ch) => <div>{ch.displayName || ch.jid}</div>}
                        </For>
                      </Show>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  );
}

function RemoteLogsPanel(props: {
  status: string;
  statusIsError: boolean;
  lines: string[];
  scrollRef: (el: HTMLDivElement) => void;
}) {
  return (
    <div class="bg-surface rounded-lg border border-border mt-6">
      <div class="px-4 py-3 border-b border-border">
        <h2 class="text-sm font-semibold text-text">remote logs</h2>
      </div>
      <div
        class={`px-4 py-3 border-b border-border text-sm ${
          props.statusIsError ? 'text-red' : 'text-text-dim'
        }`}
      >
        {props.status}
      </div>
      <div
        ref={props.scrollRef}
        class="overflow-y-auto max-h-80 font-mono text-xs p-2 space-y-0.5"
      >
        <For each={props.lines}>
          {(line) => <div class="text-text-dim">{line}</div>}
        </For>
      </div>
    </div>
  );
}

function SyncPanel(props: {
  instanceId: string;
  comparison: ContextSyncComparison;
  onClose: () => void;
  onRefresh: () => void;
  onPush: (instanceId: string, path: string) => void;
  onPull: (instanceId: string, path: string) => void;
  onBulkPush: (instanceId: string) => void;
  onBulkPull: (instanceId: string) => void;
}) {
  const total = () =>
    props.comparison.same.length +
    props.comparison.differs.length +
    props.comparison.localOnly.length +
    props.comparison.remoteOnly.length;

  const pushable = () =>
    props.comparison.differs.length + props.comparison.localOnly.length;
  const pullable = () =>
    props.comparison.differs.length + props.comparison.remoteOnly.length;

  return (
    <div class="bg-surface rounded-lg border border-border mt-6">
      <div class="px-4 py-3 border-b border-border flex items-center justify-between">
        <h2 class="text-sm font-semibold text-text">
          context sync ({total()} files)
        </h2>
        <div class="flex gap-2">
          <button class={BTN_DEFAULT} onClick={props.onClose}>
            Close
          </button>
          <button class={BTN_DEFAULT} onClick={props.onRefresh}>
            Refresh
          </button>
        </div>
      </div>

      <div class="flex gap-4 px-4 py-3 bg-surface-2 rounded text-xs mx-4 mt-4 mb-4">
        <span class="text-green">{props.comparison.same.length} identical</span>
        <span class="text-yellow">{props.comparison.differs.length} differ</span>
        <span class="text-blue">{props.comparison.localOnly.length} local only</span>
        <span class="text-accent">{props.comparison.remoteOnly.length} remote only</span>
      </div>

      <Show
        when={total() > 0}
        fallback={
          <div class="p-8 text-center text-text-dim">No context files found</div>
        }
      >
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-border text-text-dim text-xs">
                <th class="text-left px-4 py-2">path</th>
                <th class="text-left px-4 py-2">status</th>
                <th class="text-left px-4 py-2">local size</th>
                <th class="text-left px-4 py-2">remote size</th>
                <th class="text-left px-4 py-2">actions</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.comparison.same}>
                {(f) => (
                  <tr class="border-b border-border">
                    <td class="px-4 py-2">
                      <code class="text-xs">{f.path || '(root)'}/CLAUDE.md</code>
                    </td>
                    <td class="px-4 py-2 text-green">identical</td>
                    <td class="px-4 py-2 text-text-dim">{fmtBytes(f.size)}</td>
                    <td class="px-4 py-2 text-text-dim">{fmtBytes(f.size)}</td>
                    <td class="px-4 py-2 text-text-dim text-xs">in sync</td>
                  </tr>
                )}
              </For>
              <For each={props.comparison.differs}>
                {(d) => (
                  <tr class="border-b border-border bg-yellow/5">
                    <td class="px-4 py-2">
                      <code class="text-xs">{d.local.path || '(root)'}/CLAUDE.md</code>
                    </td>
                    <td class="px-4 py-2 text-yellow">differs</td>
                    <td class="px-4 py-2 text-text-dim">{fmtBytes(d.local.size)}</td>
                    <td class="px-4 py-2 text-text-dim">{fmtBytes(d.remote.size)}</td>
                    <td class="px-4 py-2">
                      <div class="flex gap-1">
                        <button
                          class={BTN_DEFAULT}
                          onClick={() => props.onPush(props.instanceId, d.local.path)}
                        >
                          Push
                        </button>
                        <button
                          class={BTN_DEFAULT}
                          onClick={() => props.onPull(props.instanceId, d.local.path)}
                        >
                          Pull
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </For>
              <For each={props.comparison.localOnly}>
                {(f) => (
                  <tr class="border-b border-border bg-blue/5">
                    <td class="px-4 py-2">
                      <code class="text-xs">{f.path || '(root)'}/CLAUDE.md</code>
                    </td>
                    <td class="px-4 py-2 text-blue">local only</td>
                    <td class="px-4 py-2 text-text-dim">{fmtBytes(f.size)}</td>
                    <td class="px-4 py-2 text-text-dim">-</td>
                    <td class="px-4 py-2">
                      <button
                        class={BTN_DEFAULT}
                        onClick={() => props.onPush(props.instanceId, f.path)}
                      >
                        Push
                      </button>
                    </td>
                  </tr>
                )}
              </For>
              <For each={props.comparison.remoteOnly}>
                {(f) => (
                  <tr class="border-b border-border bg-accent/5">
                    <td class="px-4 py-2">
                      <code class="text-xs">{f.path || '(root)'}/CLAUDE.md</code>
                    </td>
                    <td class="px-4 py-2 text-accent">remote only</td>
                    <td class="px-4 py-2 text-text-dim">-</td>
                    <td class="px-4 py-2 text-text-dim">{fmtBytes(f.size)}</td>
                    <td class="px-4 py-2">
                      <button
                        class={BTN_DEFAULT}
                        onClick={() => props.onPull(props.instanceId, f.path)}
                      >
                        Pull
                      </button>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>

        <Show when={pushable() > 0 || pullable() > 0}>
          <div class="flex gap-3 px-4 py-3 border-t border-border">
            <Show when={pushable() > 0}>
              <button
                class={BTN_PRIMARY}
                onClick={() => props.onBulkPush(props.instanceId)}
              >
                Push All ({pushable()})
              </button>
            </Show>
            <Show when={pullable() > 0}>
              <button
                class={BTN_DEFAULT}
                onClick={() => props.onBulkPull(props.instanceId)}
              >
                Pull All ({pullable()})
              </button>
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  );
}

function StatCard(props: { label: string; children: JSX.Element }) {
  return (
    <div class="bg-surface rounded-lg border border-border p-4">
      <div class="text-xs text-text-dim mb-1">{props.label}</div>
      <div class="text-lg font-semibold text-text">{props.children}</div>
    </div>
  );
}

export default function Network() {
  const [runtime, { refetch: refetchRuntime }] = createResource<DiscoveryRuntime>(
    () => fetchJson('/api/discovery/state'),
  );

  const [peers, { refetch: refetchPeers }] = createResource<PeerView[]>(
    () => fetchJson('/api/discovery/peers'),
  );

  const [requests, { refetch: refetchRequests }] = createResource<PairRequest[]>(
    () => fetchJson('/api/discovery/requests'),
  );

  const [remoteAgents, setRemoteAgents] = createSignal<RemoteAgent[] | null>(null);
  const [logLines, setLogLines] = createSignal<string[]>([]);
  const [logStatus, setLogStatus] = createSignal(
    'Select a trusted peer to start streaming logs.',
  );
  const [logStatusIsError, setLogStatusIsError] = createSignal(false);
  let remoteLogsSource: EventSource | null = null;
  let logOutputEl: HTMLDivElement | undefined;

  const [syncPeerId, setSyncPeerId] = createSignal<string | null>(null);
  const [syncComparison, setSyncComparison] =
    createSignal<ContextSyncComparison | null>(null);

  const pollTimer = setInterval(() => {
    refetchRuntime();
    refetchPeers();
    refetchRequests();
  }, POLL_INTERVAL_MS);

  function stopRemoteLogs(silent?: boolean) {
    if (remoteLogsSource) {
      remoteLogsSource.close();
      remoteLogsSource = null;
    }
    if (!silent) {
      setLogStatus('Remote log stream stopped.');
      setLogStatusIsError(false);
    }
  }

  onCleanup(() => {
    clearInterval(pollTimer);
    stopRemoteLogs(true);
  });

  async function toggleDiscovery(enable: boolean) {
    try {
      await postJson('/api/discovery/state', { enabled: enable });
      refetchRuntime();
      refetchPeers();
      showToast(enable ? 'Discovery enabled' : 'Discovery disabled', 'success');
    } catch (e: unknown) {
      showToast(`Failed: ${(e as Error).message}`, 'error');
    }
  }

  async function trustCurrentNetwork() {
    try {
      await postJson('/api/discovery/trusted-networks/current');
      refetchRuntime();
      refetchPeers();
      showToast('Current Wi-Fi trusted', 'success');
    } catch (e: unknown) {
      showToast(`Failed: ${(e as Error).message}`, 'error');
    }
  }

  async function untrustNetwork(id: string) {
    try {
      await fetchJson(
        `/api/discovery/trusted-networks/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      refetchRuntime();
      showToast('Trusted network removed', 'success');
    } catch (e: unknown) {
      showToast(`Failed: ${(e as Error).message}`, 'error');
    }
  }

  async function requestAccess(instanceId: string) {
    try {
      const d = await postJson<{ status: string; error?: string }>(
        `/api/discovery/peers/${encodeURIComponent(instanceId)}/request-access`,
      );
      if (d.status === 'trusted' || d.status === 'already_trusted') {
        showToast('Already trusted!', 'success');
      } else if (d.status === 'pending') {
        showToast('Access requested - awaiting approval', 'info');
      } else if (d.error) {
        showToast(`Error: ${d.error}`, 'error');
      }
      refetchPeers();
    } catch (e: unknown) {
      showToast(`Failed: ${(e as Error).message}`, 'error');
    }
  }

  async function revokePeer(instanceId: string) {
    if (!confirm('Revoke trust for this peer?')) return;
    try {
      await fetchJson(
        `/api/discovery/peers/${encodeURIComponent(instanceId)}`,
        { method: 'DELETE' },
      );
      showToast('Trust revoked', 'success');
      refetchPeers();
    } catch (e: unknown) {
      showToast(`Failed: ${(e as Error).message}`, 'error');
    }
  }

  async function approveRequest(id: string) {
    try {
      const d = await postJson<{ approved?: boolean; error?: string }>(
        `/api/discovery/requests/${encodeURIComponent(id)}/approve`,
      );
      if (d.approved) showToast('Peer approved!', 'success');
      else if (d.error) showToast(`Error: ${d.error}`, 'error');
      refetchPeers();
      refetchRequests();
    } catch (e: unknown) {
      showToast(`Failed: ${(e as Error).message}`, 'error');
    }
  }

  async function rejectRequest(id: string) {
    try {
      await postJson(
        `/api/discovery/requests/${encodeURIComponent(id)}/reject`,
      );
      showToast('Request rejected', 'success');
      refetchRequests();
    } catch (e: unknown) {
      showToast(`Failed: ${(e as Error).message}`, 'error');
    }
  }

  async function browseRemoteAgents(instanceId: string) {
    setRemoteAgents(null);
    try {
      const agents = await fetchJson<RemoteAgent[]>(
        `/api/discovery/peers/${encodeURIComponent(instanceId)}/agents`,
      );
      setRemoteAgents(agents);
    } catch (e: unknown) {
      showToast(`Failed to load agents: ${(e as Error).message}`, 'error');
    }
  }

  function appendLogLine(line: string) {
    setLogLines((prev) => {
      const next = [...prev, line];
      return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
    });
    if (logOutputEl) logOutputEl.scrollTop = logOutputEl.scrollHeight;
  }

  function startRemoteLogs(instanceId: string) {
    stopRemoteLogs(true);
    setLogLines([]);
    setLogStatus('Connecting to remote log stream...');
    setLogStatusIsError(false);

    remoteLogsSource = new EventSource(
      `/api/discovery/peers/${encodeURIComponent(instanceId)}/logs`,
    );

    remoteLogsSource.addEventListener('log', (event) => {
      try {
        const payload: RemoteLogRecord = JSON.parse((event as MessageEvent).data);
        const level = (payload.level ?? 'info').toUpperCase();
        const time = payload.time ?? payload.timestamp ?? '';
        const source = payload.source ?? 'remote';
        const msg = payload.msg ?? payload.message ?? '';
        appendLogLine(`${time ? `[${time}] ` : ''}${level} ${source} - ${msg}`);
        setLogStatus(`Streaming remote logs from ${instanceId}.`);
      } catch {
        appendLogLine((event as MessageEvent).data as string);
      }
    });

    remoteLogsSource.onerror = () => {
      setLogStatus(`Remote log stream unavailable for ${instanceId}.`);
      setLogStatusIsError(true);
      stopRemoteLogs(true);
    };
  }

  async function openSyncPanel(instanceId: string) {
    setSyncPeerId(instanceId);
    setSyncComparison(null);
    try {
      const cmp = await fetchJson<ContextSyncComparison>(
        `/api/discovery/peers/${encodeURIComponent(instanceId)}/context/compare`,
      );
      setSyncComparison(cmp);
    } catch (e: unknown) {
      showToast(`Failed to compare: ${(e as Error).message}`, 'error');
      setSyncPeerId(null);
    }
  }

  function closeSyncPanel() {
    setSyncPeerId(null);
    setSyncComparison(null);
  }

  async function syncFile(direction: 'push' | 'pull', instanceId: string, path: string) {
    try {
      const d = await postJson<{ ok?: boolean; error?: string }>(
        `/api/discovery/peers/${encodeURIComponent(instanceId)}/context/${direction}`,
        { path },
      );
      if (d.ok) showToast(`${direction === 'push' ? 'Pushed' : 'Pulled'} ${path}`, 'success');
      else showToast(`Error: ${d.error ?? 'unknown'}`, 'error');
      const sid = syncPeerId();
      if (sid) openSyncPanel(sid);
    } catch (e: unknown) {
      showToast(`Failed: ${(e as Error).message}`, 'error');
    }
  }

  async function bulkSync(direction: 'push' | 'pull', instanceId: string) {
    try {
      const cmp = await fetchJson<ContextSyncComparison>(
        `/api/discovery/peers/${encodeURIComponent(instanceId)}/context/compare`,
      );
      const paths: string[] = [];
      if (direction === 'push') {
        for (const d of cmp.differs) paths.push(d.local.path);
        for (const f of cmp.localOnly) paths.push(f.path);
      } else {
        for (const d of cmp.differs) paths.push(d.remote.path);
        for (const f of cmp.remoteOnly) paths.push(f.path);
      }
      if (paths.length === 0) {
        showToast(`Nothing to ${direction}`, 'info');
        return;
      }
      if (!confirm(`${direction === 'push' ? 'Push' : 'Pull'} ${paths.length} file(s)?`)) return;

      let done = 0;
      let errs = 0;
      for (const p of paths) {
        try {
          const d = await postJson<{ ok?: boolean }>(
            `/api/discovery/peers/${encodeURIComponent(instanceId)}/context/${direction}`,
            { path: p },
          );
          if (d.ok) done++;
          else errs++;
        } catch {
          errs++;
        }
      }
      showToast(
        `${done} file(s) synced${errs > 0 ? `, ${errs} error(s)` : ''}`,
        errs > 0 ? 'warning' : 'success',
      );
      const sid = syncPeerId();
      if (sid) openSyncPanel(sid);
    } catch (e: unknown) {
      showToast(`Failed: ${(e as Error).message}`, 'error');
    }
  }

  const onlineCount = () => (peers() ?? []).filter((p) => p.online).length;
  const trustedCount = () => (peers() ?? []).filter((p) => p.status === 'trusted').length;

  return (
    <>
      <Title>OmniClaw — Network</Title>
      <div class="p-4 space-y-6">
        <div class="grid grid-cols-4 gap-4">
          <StatCard label="instance">
            <Show when={runtime()} fallback="...">
              <span class="text-sm">
                {runtime()!.currentNetwork?.label ?? 'unknown'}
              </span>
            </Show>
          </StatCard>
          <StatCard label="discovery">
            <Show when={runtime()} fallback="...">
              <Show
                when={runtime()!.active}
                fallback={<span class="text-text-dim">disabled</span>}
              >
                <span class="text-green">active</span>
              </Show>
            </Show>
          </StatCard>
          <StatCard label="peers online">{onlineCount()}</StatCard>
          <StatCard label="trusted">{trustedCount()}</StatCard>
        </div>

        <div class="bg-surface rounded-lg border border-border p-4">
          <h2 class="text-sm font-semibold text-text mb-4">discovery controls</h2>
          <div class="flex flex-wrap gap-3 items-center mb-4">
            <Show when={runtime()}>
              <button
                class={runtime()!.enabled
                  ? `${BTN} bg-red/20 text-red hover:bg-red/30`
                  : `${BTN} bg-accent/20 text-accent hover:bg-accent/30`}
                onClick={() => toggleDiscovery(!runtime()!.enabled)}
              >
                {runtime()!.enabled ? 'Turn discovery off' : 'Turn discovery on'}
              </button>
            </Show>
            <button class={BTN_DEFAULT} onClick={trustCurrentNetwork}>
              Trust Wi-Fi
            </button>
            <span class="text-text-dim text-sm">
              <Show when={runtime()?.currentNetwork} fallback="No Wi-Fi network detected">
                Current Wi-Fi:{' '}
                <strong class="text-text">{runtime()!.currentNetwork!.label}</strong>
              </Show>
            </span>
          </div>
          <div class="text-xs text-text-dim mb-3">
            Trusted networks gate discovery when present. Leave the list empty to
            allow discovery anywhere the toggle is on.
          </div>
          <TrustedNetworksList
            networks={runtime()?.trustedNetworks ?? []}
            onUntrust={untrustNetwork}
          />
        </div>

        <div class="grid grid-cols-[1fr_320px] gap-6 items-start">
          <div class="bg-surface rounded-lg border border-border">
            <div class="px-4 py-3 border-b border-border">
              <h2 class="text-sm font-semibold text-text">discovered peers</h2>
            </div>
            <Show
              when={(peers() ?? []).length > 0}
              fallback={
                <div class="p-8 text-center text-text-dim">
                  No peers discovered yet. Ensure DISCOVERY_ENABLED=true on all
                  instances.
                </div>
              }
            >
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="border-b border-border text-text-dim text-xs">
                      <th class="text-left px-4 py-2">name</th>
                      <th class="text-left px-4 py-2">address</th>
                      <th class="text-left px-4 py-2">trust</th>
                      <th class="text-left px-4 py-2">online</th>
                      <th class="text-left px-4 py-2">actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={peers() ?? []}>
                      {(peer) => (
                        <tr class="border-b border-border">
                          <td class="px-4 py-2 font-semibold text-text">{peer.name}</td>
                          <td class="px-4 py-2">
                            <code class="text-xs text-text-dim">
                              {peer.host}:{peer.port}
                            </code>
                          </td>
                          <td class="px-4 py-2">
                            <StatusBadge status={peer.status} />
                          </td>
                          <td class="px-4 py-2">
                            <Show
                              when={peer.online}
                              fallback={<span class="text-text-dim">&#9675;</span>}
                            >
                              <span class="text-green">&#9679;</span>
                            </Show>
                          </td>
                          <td class="px-4 py-2">
                            <PeerActions
                              peer={peer}
                              onBrowse={browseRemoteAgents}
                              onLogs={startRemoteLogs}
                              onSync={openSyncPanel}
                              onRevoke={revokePeer}
                              onRequest={requestAccess}
                            />
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </Show>
          </div>

          <PendingRequestsPanel
            requests={requests() ?? []}
            onApprove={approveRequest}
            onReject={rejectRequest}
          />
        </div>

        <Show when={remoteAgents() !== null}>
          <RemoteAgentsPanel agents={remoteAgents()!} />
        </Show>

        <RemoteLogsPanel
          status={logStatus()}
          statusIsError={logStatusIsError()}
          lines={logLines()}
          scrollRef={(el) => { logOutputEl = el; }}
        />

        <Show when={syncPeerId() && syncComparison()}>
          <SyncPanel
            instanceId={syncPeerId()!}
            comparison={syncComparison()!}
            onClose={closeSyncPanel}
            onRefresh={() => openSyncPanel(syncPeerId()!)}
            onPush={(id, path) => syncFile('push', id, path)}
            onPull={(id, path) => syncFile('pull', id, path)}
            onBulkPush={(id) => bulkSync('push', id)}
            onBulkPull={(id) => bulkSync('pull', id)}
          />
        </Show>
      </div>
    </>
  );
}
