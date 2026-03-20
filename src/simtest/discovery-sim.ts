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
}

class SimTrustStore {
  private peers = new Map<string, StoredPeer>();
  private pendingRequests: PairRequest[] = [];

  constructor(peers: SimRemotePeer[]) {
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
    const lines = this.peer.logs.slice(-50);
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const record of lines) {
            controller.enqueue(
              encoder.encode(`event: log\ndata: ${JSON.stringify(record)}\n\n`),
            );
          }
          controller.close();
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

function createDefaultRemotePeer(): SimRemotePeer {
  const state = new FakeState();
  state.addAgent({
    id: 'remote-builder',
    name: 'Remote Builder',
    backend: 'docker',
    agentRuntime: 'opencode',
  });
  state.addChat('sim:remote', '#remote');
  state.addSubscription('sim:remote', 'remote-builder', {
    isPrimary: true,
    channelFolder: 'remote',
  });

  const now = new Date().toISOString();
  return {
    discovered: {
      instanceId: 'peer-remote-1',
      name: 'Remote OmniClaw',
      host: 'remote-sim.local',
      port: 3100,
      addresses: ['192.168.1.80'],
      version: 'simtest',
      firstSeen: now,
    },
    stored: {
      instanceId: 'peer-remote-1',
      name: 'Remote OmniClaw',
      sharedSecret: 'sim-remote-secret',
      status: 'trusted',
      host: 'remote-sim.local',
      port: 3100,
      approvedAt: now,
      lastSeen: now,
      createdAt: now,
    },
    state,
    logs: [
      {
        time: now,
        level: 'info',
        msg: 'Remote runner connected to the fleet',
        source: 'peer-remote-1',
      },
      {
        time: now,
        level: 'warn',
        msg: 'Remote builder cache is warming up',
        source: 'peer-remote-1',
      },
    ],
  };
}

export interface SimDiscoveryEnvironment {
  context: DiscoveryRouteContext;
  getNetworkPageState(): NetworkPageState;
  listRemotePeers(): Array<{
    instanceId: string;
    name: string;
    online: boolean;
    agents: number;
    logs: number;
  }>;
  addRemoteLog(
    instanceId: string,
    record: Omit<SimRemoteLogRecord, 'time'> & { time?: string },
  ): void;
}

export function createSimDiscoveryEnvironment(
  state: FakeState,
): SimDiscoveryEnvironment {
  const remotePeer = createDefaultRemotePeer();
  const peers = new Map([[remotePeer.discovered.instanceId, remotePeer]]);
  const trustStore = new SimTrustStore([remotePeer]);
  const discovery = new SimDiscoveryHandle(
    new Map([[remotePeer.discovered.instanceId, remotePeer.discovered]]),
  );
  const runtime = new SimRuntimeController();

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
        online: discovery.getPeers().has(peer.discovered.instanceId),
        agents: Object.keys(peer.state.getAgents()).length,
        logs: peer.logs.length,
      }));
    },
    addRemoteLog(instanceId, record) {
      const peer = peers.get(instanceId);
      if (!peer) throw new Error(`Remote peer not found: ${instanceId}`);
      peer.logs.push({
        time: record.time ?? new Date().toISOString(),
        level: record.level,
        msg: record.msg,
        source: record.source,
      });
    },
  };
}
