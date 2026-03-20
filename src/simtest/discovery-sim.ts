import { createHash } from 'crypto';

import type { DiscoveryRouteContext } from '../discovery/routes.js';
import type { PeerClientLike } from '../discovery/peer-client.js';
import type {
  ContextFileEntry,
  DiscoveredPeer,
  PairRequest,
  PeerView,
  RemoteAgentSummary,
  StoredPeer,
} from '../discovery/types.js';
import { buildAgentChannelData } from '../web/agent-channels.js';
import type { NetworkPageState } from '../web/network.js';
import { FakeState } from './fake-state.js';

interface SimRemoteLogRecord {
  time: string;
  level: string;
  msg: string;
  source: string;
}

interface SimRemotePeer {
  discovered: DiscoveredPeer;
  stored: StoredPeer;
  state: FakeState;
  logs: SimRemoteLogRecord[];
  logListeners: Set<(record: SimRemoteLogRecord) => void>;
  online: boolean;
}

interface CreateRemotePeerParams {
  instanceId: string;
  name: string;
  host: string;
  address: string;
  channelFolder: string;
  online?: boolean;
  status?: StoredPeer['status'];
  logMessages?: string[];
}

interface SimRemotePeerSummary {
  instanceId: string;
  name: string;
  online: boolean;
  status: StoredPeer['status'];
  agents: number;
  logs: number;
}

class SimTrustStore {
  private peers = new Map<string, StoredPeer>();
  private pendingRequests: PairRequest[] = [];

  constructor(peers: SimRemotePeer[]) {
    this.replacePeers(peers);
  }

  replacePeers(peers: SimRemotePeer[]): void {
    this.peers.clear();
    for (const peer of peers) {
      this.peers.set(peer.discovered.instanceId, { ...peer.stored });
    }
  }

  getPeer(instanceId: string): StoredPeer | null {
    return this.peers.get(instanceId) ?? null;
  }

  getAllPeers(): StoredPeer[] {
    return Array.from(this.peers.values()).filter(
      (peer) => peer.status !== 'revoked',
    );
  }

  getPendingRequests(): PairRequest[] {
    return [...this.pendingRequests];
  }

  isPeerTrusted(instanceId: string): boolean {
    return this.peers.get(instanceId)?.status === 'trusted';
  }

  getPeerSecret(instanceId: string): string | null {
    return this.peers.get(instanceId)?.sharedSecret ?? null;
  }

  updatePeerLastSeen(instanceId: string): void {
    const peer = this.peers.get(instanceId);
    if (!peer) return;
    peer.lastSeen = new Date().toISOString();
  }

  revokePeer(instanceId: string): void {
    const peer = this.peers.get(instanceId);
    if (!peer) return;
    peer.status = 'revoked';
    peer.sharedSecret = null;
  }

  resetPeerToDiscovered(instanceId: string): void {
    const peer = this.peers.get(instanceId);
    if (!peer) return;
    peer.status = 'discovered';
  }

  createPairRequest(
    fromInstanceId: string,
    fromName: string,
    fromHost: string,
    fromPort: number,
    callbackToken: string,
  ): PairRequest {
    const request: PairRequest = {
      id: `req-${Date.now()}`,
      fromInstanceId,
      fromName,
      fromHost,
      fromPort,
      callbackToken,
      status: 'pending',
      sharedSecret: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    this.pendingRequests.push(request);
    return request;
  }

  approvePairRequest(requestId: string): {
    sharedSecret: string;
    request: PairRequest;
  } {
    const request = this.pendingRequests.find(
      (entry) => entry.id === requestId,
    );
    if (!request) throw new Error('Request not found');
    request.status = 'approved';
    request.resolvedAt = new Date().toISOString();
    const sharedSecret = `sim-secret-${request.fromInstanceId}`;
    this.peers.set(request.fromInstanceId, {
      instanceId: request.fromInstanceId,
      name: request.fromName,
      sharedSecret,
      status: 'trusted',
      host: request.fromHost,
      port: request.fromPort,
      approvedAt: request.resolvedAt,
      lastSeen: request.resolvedAt,
      createdAt: request.createdAt,
    });
    return { sharedSecret, request };
  }

  rejectPairRequest(requestId: string): void {
    const request = this.pendingRequests.find(
      (entry) => entry.id === requestId,
    );
    if (!request) throw new Error('Request not found');
    request.status = 'rejected';
    request.resolvedAt = new Date().toISOString();
  }

  markPeerPending(
    instanceId: string,
    name: string,
    host: string | null,
    port: number | null,
  ): StoredPeer {
    const now = new Date().toISOString();
    const stored: StoredPeer = {
      instanceId,
      name,
      sharedSecret: null,
      status: 'pending',
      host,
      port,
      approvedAt: null,
      lastSeen: now,
      createdAt: now,
    };
    this.peers.set(instanceId, stored);
    return stored;
  }

  completePendingEncryptedPairing(): StoredPeer {
    throw new Error('Encrypted pairing callbacks are not simulated');
  }
}

class SimDiscoveryHandle {
  constructor(private readonly peers: Map<string, DiscoveredPeer>) {}

  getPeers(): Map<string, DiscoveredPeer> {
    return new Map(this.peers);
  }

  reset(peers: DiscoveredPeer[]): void {
    this.peers.clear();
    for (const peer of peers) {
      this.peers.set(peer.instanceId, peer);
    }
  }

  setPeerOnline(instanceId: string, online: boolean): void {
    const peer = this.peers.get(instanceId);
    if (!peer) return;
    if (online) {
      this.peers.set(instanceId, peer);
      return;
    }
    this.peers.delete(instanceId);
  }

  upsertPeer(peer: DiscoveredPeer): void {
    this.peers.set(peer.instanceId, peer);
  }

  stop(): void {}
}

class SimRuntimeController {
  private enabled = true;

  getSnapshot() {
    return {
      enabled: this.enabled,
      active: this.enabled,
      currentNetwork: {
        id: 'sim-lan',
        label: 'Simulated LAN',
      },
      trustedNetworks: [],
    };
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    return this.getSnapshot();
  }

  trustCurrentNetwork() {
    return this.getSnapshot();
  }

  untrustNetwork() {
    return this.getSnapshot();
  }

  isRemoteAccessAllowed(): boolean {
    return this.enabled;
  }
}

class SimPeerClient implements PeerClientLike {
  constructor(private readonly peer: SimRemotePeer) {}

  async getAgents(): Promise<RemoteAgentSummary[]> {
    return buildAgentChannelData(this.peer.state).map((agent) => ({
      id: agent.id,
      name: agent.name,
      folder: agent.folder,
      backend: agent.backend,
      agentRuntime: agent.agentRuntime,
      isAdmin: agent.isAdmin,
      serverFolder: agent.serverFolder,
      agentContextFolder: agent.agentContextFolder,
      avatarUrl: agent.avatarUrl,
      channels: agent.channels.map((channel) => ({
        jid: channel.jid,
        displayName: channel.displayName,
        channelFolder: channel.channelFolder,
        categoryFolder: channel.categoryFolder,
      })),
    }));
  }

  async getStats(): Promise<unknown> {
    const tasks = this.peer.state.getTasks();
    return {
      agents: Object.keys(this.peer.state.getAgents()).length,
      activeTasks: tasks.filter((task) => task.status === 'active').length,
      pausedTasks: tasks.filter((task) => task.status === 'paused').length,
      completedTasks: tasks.filter((task) => task.status === 'completed')
        .length,
      ...this.peer.state.getQueueStats(),
    };
  }

  async streamLogs(): Promise<Response> {
    const encoder = new TextEncoder();
    const peer = this.peer;
    let cleanup: (() => void) | null = null;

    return new Response(
      new ReadableStream({
        start(controller) {
          let closed = false;

          const send = (record: SimRemoteLogRecord) => {
            if (closed) return;
            controller.enqueue(
              encoder.encode(`event: log\ndata: ${JSON.stringify(record)}\n\n`),
            );
          };

          for (const record of peer.logs.slice(-50)) {
            send(record);
          }

          const onLog = (record: SimRemoteLogRecord) => {
            send(record);
          };

          peer.logListeners.add(onLog);
          controller.enqueue(encoder.encode(': connected\n\n'));

          const heartbeat = setInterval(() => {
            if (closed) return;
            controller.enqueue(encoder.encode(': keepalive\n\n'));
          }, 15000);

          cleanup = () => {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            peer.logListeners.delete(onLog);
          };

          return cleanup;
        },
        cancel() {
          cleanup?.();
        },
      }),
      {
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      },
    );
  }

  async getContextLayers(params: Record<string, string>): Promise<unknown> {
    const folder = params.folder || '';
    return {
      channel: {
        path: folder || null,
        content: folder ? this.peer.state.readContextFile(folder) : null,
        exists: folder
          ? this.peer.state.readContextFile(folder) !== null
          : false,
      },
      agent: { path: null, content: null, exists: false },
      category: { path: null, content: null, exists: false },
      server: { path: null, content: null, exists: false },
    };
  }

  async listContextFiles(): Promise<ContextFileEntry[]> {
    return Object.entries(this.peer.state.contextFiles).map(
      ([filePath, content]) => ({
        path: filePath,
        hash: sha256(content),
        size: Buffer.byteLength(content, 'utf8'),
        mtime: new Date().toISOString(),
      }),
    );
  }

  async writeContextFile(
    layerPath: string,
    content: string,
  ): Promise<{ ok: boolean }> {
    this.peer.state.writeContextFile(layerPath, content);
    return { ok: true };
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function createRemoteState(name: string, channelFolder: string): FakeState {
  const state = new FakeState();
  const agentId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  state.addAgent({
    id: agentId,
    name,
    backend: 'docker',
    agentRuntime: 'opencode',
  });
  state.addChat(`sim:${channelFolder}`, `#${channelFolder}`);
  state.addSubscription(`sim:${channelFolder}`, agentId, {
    isPrimary: true,
    channelFolder,
  });
  return state;
}

function createRemotePeer(params: CreateRemotePeerParams): SimRemotePeer {
  const now = new Date().toISOString();
  const state = createRemoteState(
    `${params.name} Builder`,
    params.channelFolder,
  );
  const status = params.status ?? 'trusted';

  return {
    discovered: {
      instanceId: params.instanceId,
      name: params.name,
      host: params.host,
      port: 3100,
      addresses: [params.address],
      version: 'simtest',
      firstSeen: now,
    },
    stored: {
      instanceId: params.instanceId,
      name: params.name,
      sharedSecret:
        status === 'trusted' ? `sim-secret-${params.instanceId}` : null,
      status,
      host: params.host,
      port: 3100,
      approvedAt: status === 'trusted' ? now : null,
      lastSeen: now,
      createdAt: now,
    },
    state,
    logs: (
      params.logMessages ?? [
        `${params.name} connected to the fleet`,
        `${params.name} cache is warming up`,
      ]
    ).map((msg, index) => ({
      time: new Date(Date.now() + index).toISOString(),
      level: index === 0 ? 'info' : 'warn',
      msg,
      source: params.instanceId,
    })),
    logListeners: new Set(),
    online: params.online ?? true,
  };
}

function createDefaultRemotePeers(): SimRemotePeer[] {
  return [
    createRemotePeer({
      instanceId: 'peer-remote-1',
      name: 'Remote OmniClaw',
      host: 'remote-sim.local',
      address: '192.168.1.80',
      channelFolder: 'remote',
      logMessages: [
        'Remote runner connected to the fleet',
        'Remote builder cache is warming up',
      ],
    }),
  ];
}

function buildPeerViews(
  discovery: SimDiscoveryHandle,
  trustStore: SimTrustStore,
): PeerView[] {
  const storedMap = new Map(
    trustStore.getAllPeers().map((peer) => [peer.instanceId, peer]),
  );
  const peers: PeerView[] = [];

  for (const [instanceId, discovered] of discovery.getPeers()) {
    const stored = storedMap.get(instanceId);
    peers.push({
      instanceId,
      name: discovered.name,
      host: discovered.host,
      port: discovered.port,
      addresses: discovered.addresses,
      status: stored?.status ?? 'discovered',
      online: true,
      approvedAt: stored?.approvedAt ?? null,
      lastSeen: stored?.lastSeen ?? null,
    });
    storedMap.delete(instanceId);
  }

  for (const stored of storedMap.values()) {
    peers.push({
      instanceId: stored.instanceId,
      name: stored.name,
      host: stored.host ?? '',
      port: stored.port ?? 0,
      addresses: [],
      status: stored.status,
      online: false,
      approvedAt: stored.approvedAt,
      lastSeen: stored.lastSeen,
    });
  }

  return peers;
}

export interface SimDiscoveryEnvironment {
  context: DiscoveryRouteContext;
  getNetworkPageState(): NetworkPageState;
  listRemotePeers(): SimRemotePeerSummary[];
  addRemoteLog(
    instanceId: string,
    record: Omit<SimRemoteLogRecord, 'time'> & { time?: string },
  ): void;
  reset(): void;
  addRemotePeer(params: CreateRemotePeerParams): void;
  setPeerOnline(instanceId: string, online: boolean): void;
}

export function createSimDiscoveryEnvironment(
  state: FakeState,
): SimDiscoveryEnvironment {
  const peers = new Map<string, SimRemotePeer>();
  const trustStore = new SimTrustStore([]);
  const discovery = new SimDiscoveryHandle(new Map());
  const runtime = new SimRuntimeController();

  const syncStores = () => {
    const currentPeers = Array.from(peers.values());
    trustStore.replacePeers(currentPeers);
    discovery.reset(
      currentPeers
        .filter((peer) => peer.stored.status !== 'revoked' && peer.online)
        .map((peer) => peer.discovered),
    );
  };

  const reset = () => {
    peers.clear();
    for (const peer of createDefaultRemotePeers()) {
      peers.set(peer.discovered.instanceId, peer);
    }
    syncStores();
  };

  reset();

  const context: DiscoveryRouteContext = {
    instanceId: 'sim-local-instance',
    instanceName: 'Sim Local OmniClaw',
    version: 'simtest',
    trustStore: trustStore as any,
    discovery,
    state,
    runtime: runtime as any,
    createPeerClient(peer) {
      const remote = peers.get(peer.instanceId);
      return remote ? new SimPeerClient(remote) : null;
    },
  };

  return {
    context,
    getNetworkPageState() {
      return {
        instanceId: context.instanceId,
        instanceName: context.instanceName,
        discoveryAvailable: true,
        discoveryEnabled: true,
        runtime: runtime.getSnapshot(),
        peers: buildPeerViews(discovery, trustStore),
        pendingRequests: trustStore.getPendingRequests(),
      };
    },
    listRemotePeers() {
      return Array.from(peers.values()).map((peer) => ({
        instanceId: peer.discovered.instanceId,
        name: peer.discovered.name,
        online: peer.online,
        status: peer.stored.status,
        agents: Object.keys(peer.state.getAgents()).length,
        logs: peer.logs.length,
      }));
    },
    addRemoteLog(instanceId, record) {
      const peer = peers.get(instanceId);
      if (!peer) throw new Error(`Remote peer not found: ${instanceId}`);
      const entry = {
        time: record.time ?? new Date().toISOString(),
        level: record.level,
        msg: record.msg,
        source: record.source,
      };
      peer.logs.push(entry);
      for (const listener of peer.logListeners) {
        listener(entry);
      }
    },
    reset,
    addRemotePeer(params) {
      const peer = createRemotePeer(params);
      peers.set(peer.discovered.instanceId, peer);
      syncStores();
      if (params.online === false) {
        discovery.setPeerOnline(peer.discovered.instanceId, false);
      }
    },
    setPeerOnline(instanceId, online) {
      const peer = peers.get(instanceId);
      if (!peer) throw new Error(`Remote peer not found: ${instanceId}`);
      peer.online = online;
      syncStores();
    },
  };
}
