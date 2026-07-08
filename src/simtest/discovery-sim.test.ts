import { describe, expect, it } from 'bun:test';

import { handleDiscoveryRequest } from '../discovery/routes.js';
import { createSimDiscoveryEnvironment } from './discovery-sim.js';
import { FakeState } from './fake-state.js';

describe('createSimDiscoveryEnvironment', () => {
  it('exposes a trusted remote peer with agents and logs', async () => {
    const env = createSimDiscoveryEnvironment(new FakeState());

    const peers = env.listRemotePeers();
    expect(peers).toHaveLength(1);
    expect(peers[0]?.agents).toBeGreaterThan(0);

    const agentsReq = new Request(
      'http://localhost/api/discovery/peers/peer-remote-1/agents',
    );
    const agentsRes = await handleDiscoveryRequest(
      agentsReq,
      new URL(agentsReq.url),
      env.context,
    );
    const agents = (await (agentsRes as Response).json()) as Array<{
      id: string;
    }>;

    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThan(0);

    const logsReq = new Request(
      'http://localhost/api/discovery/peers/peer-remote-1/logs',
    );
    const logsRes = await handleDiscoveryRequest(
      logsReq,
      new URL(logsReq.url),
      env.context,
    );
    const reader = (logsRes as Response).body?.getReader();

    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    let body = '';
    for (let i = 0; i < 3; i++) {
      const chunk = await reader!.read();
      if (chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
    }
    await reader!.cancel();

    expect(body).toContain('event: log');
    expect(body).toContain('Remote runner connected');
  });

  it('supports multi-peer snapshots and offline peers', () => {
    const env = createSimDiscoveryEnvironment(new FakeState());

    env.addRemotePeer({
      instanceId: 'peer-remote-2',
      name: 'Build Farm East',
      host: 'east-sim.local',
      address: '192.168.1.81',
      channelFolder: 'east',
    });
    env.addRemotePeer({
      instanceId: 'peer-remote-3',
      name: 'Build Farm West',
      host: 'west-sim.local',
      address: '192.168.1.82',
      channelFolder: 'west',
    });
    env.setPeerOnline('peer-remote-3', false);

    const peers = env.listRemotePeers();
    expect(peers).toHaveLength(3);
    expect(
      peers.find((peer) => peer.instanceId === 'peer-remote-2')?.online,
    ).toBe(true);
    expect(
      peers.find((peer) => peer.instanceId === 'peer-remote-3')?.online,
    ).toBe(false);

    const pageState = env.getNetworkPageState();
    expect(pageState.peers).toHaveLength(3);
    expect(
      pageState.peers.find((peer) => peer.instanceId === 'peer-remote-3')
        ?.online,
    ).toBe(false);
  });

  it('streams new remote log entries without closing the stream', async () => {
    const env = createSimDiscoveryEnvironment(new FakeState());
    const logsReq = new Request(
      'http://localhost/api/discovery/peers/peer-remote-1/logs',
    );
    const logsRes = (await handleDiscoveryRequest(
      logsReq,
      new URL(logsReq.url),
      env.context,
    )) as Response;
    const reader = logsRes.body?.getReader();

    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    let output = '';

    for (let i = 0; i < 3; i++) {
      const chunk = await reader!.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }

    env.addRemoteLog('peer-remote-1', {
      level: 'error',
      msg: 'Remote log arrived after stream start',
      source: 'peer-remote-1',
    });

    for (let i = 0; i < 2; i++) {
      const chunk = await reader!.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
      if (output.includes('Remote log arrived after stream start')) break;
    }

    expect(output).toContain('Remote runner connected');
    expect(output).toContain('Remote log arrived after stream start');

    await reader!.cancel();
  });

  it('proxies deterministic remote stats for a trusted peer', async () => {
    const env = createSimDiscoveryEnvironment(new FakeState());

    const statsReq = new Request(
      'http://localhost/api/discovery/peers/peer-remote-1/stats',
    );
    const statsRes = (await handleDiscoveryRequest(
      statsReq,
      new URL(statsReq.url),
      env.context,
    )) as Response;
    const stats = (await statsRes.json()) as {
      agents: number;
      activeTasks: number;
      pausedTasks: number;
      completedTasks: number;
    };

    expect(statsRes.status).toBe(200);
    expect(stats.agents).toBeGreaterThan(0);
    expect(stats.activeTasks).toBeGreaterThan(0);
    expect(stats.pausedTasks).toBeGreaterThan(0);
    expect(stats.completedTasks).toBeGreaterThanOrEqual(0);
  });

  it('writes and reads remote context layers through the proxy routes', async () => {
    const env = createSimDiscoveryEnvironment(new FakeState());

    const writeReq = new Request(
      'http://localhost/api/discovery/peers/peer-remote-1/context/file',
      {
        method: 'PUT',
        body: JSON.stringify({
          path: 'remote/CLAUDE.md',
          content: '# Remote Context\nKeep builds deterministic.',
        }),
      },
    );
    const writeRes = (await handleDiscoveryRequest(
      writeReq,
      new URL(writeReq.url),
      env.context,
    )) as Response;

    expect(writeRes.status).toBe(200);
    expect(await writeRes.json()).toEqual({ ok: true });

    const layersReq = new Request(
      'http://localhost/api/discovery/peers/peer-remote-1/context/layers?folder=remote%2FCLAUDE.md',
    );
    const layersRes = (await handleDiscoveryRequest(
      layersReq,
      new URL(layersReq.url),
      env.context,
    )) as Response;
    const layers = (await layersRes.json()) as {
      channel: { path: string; content: string; exists: boolean };
    };

    expect(layersRes.status).toBe(200);
    expect(layers.channel).toEqual({
      path: 'remote/CLAUDE.md',
      content: '# Remote Context\nKeep builds deterministic.',
      exists: true,
    });
  });

  it('denies proxy access to peers that are not trusted', async () => {
    const env = createSimDiscoveryEnvironment(new FakeState());

    env.addRemotePeer({
      instanceId: 'peer-pending',
      name: 'Pending Peer',
      host: 'pending-sim.local',
      address: '192.168.1.83',
      channelFolder: 'pending',
      status: 'pending',
    });

    const agentsReq = new Request(
      'http://localhost/api/discovery/peers/peer-pending/agents',
    );
    const agentsRes = (await handleDiscoveryRequest(
      agentsReq,
      new URL(agentsReq.url),
      env.context,
    )) as Response;

    expect(agentsRes.status).toBe(403);
    expect(await agentsRes.json()).toEqual({ error: 'Peer is not trusted' });
    expect(
      env
        .getNetworkPageState()
        .peers.find((peer) => peer.instanceId === 'peer-pending'),
    ).toMatchObject({ status: 'pending', online: true });
  });

  it('supports deterministic runtime toggles in network page state', () => {
    const env = createSimDiscoveryEnvironment(new FakeState());
    const runtime = env.context.runtime as unknown as {
      setEnabled(enabled: boolean): { enabled: boolean; active: boolean };
      isRemoteAccessAllowed(): boolean;
    };

    expect(env.getNetworkPageState().runtime.active).toBe(true);
    expect(runtime.setEnabled(false)).toMatchObject({
      enabled: false,
      active: false,
    });
    expect(runtime.isRemoteAccessAllowed()).toBe(false);
    expect(env.getNetworkPageState().runtime.active).toBe(false);

    runtime.setEnabled(true);
    expect(env.getNetworkPageState().runtime.active).toBe(true);
  });

  it('simulates pair request approval, rejection, and revocation state', () => {
    const env = createSimDiscoveryEnvironment(new FakeState());
    const originalDateNow = Date.now;
    let now = 1_700_000_000_000;
    const trustStore = env.context.trustStore as unknown as {
      createPairRequest: (
        fromInstanceId: string,
        fromName: string,
        fromHost: string,
        fromPort: number,
        callbackToken: string,
      ) => { id: string; status: string; fromInstanceId: string };
      approvePairRequest: (id: string) => { sharedSecret: string };
      rejectPairRequest: (id: string) => void;
      revokePeer: (instanceId: string) => void;
      resetPeerToDiscovered: (instanceId: string) => void;
      getPeer: (
        instanceId: string,
      ) => { status: string; sharedSecret: string | null } | null;
      getPendingRequests: () => Array<{ status: string }>;
    };

    Date.now = () => now++;
    try {
      const approved = trustStore.createPairRequest(
        'peer-new',
        'New Peer',
        'new-sim.local',
        3100,
        'token-a',
      );
      const rejected = trustStore.createPairRequest(
        'peer-rejected',
        'Rejected Peer',
        'reject-sim.local',
        3101,
        'token-b',
      );

      expect(approved).toMatchObject({
        status: 'pending',
        fromInstanceId: 'peer-new',
      });
      expect(trustStore.getPendingRequests()).toHaveLength(2);

      expect(trustStore.approvePairRequest(approved.id).sharedSecret).toBe(
        'sim-secret-peer-new',
      );
      expect(trustStore.getPeer('peer-new')).toMatchObject({
        status: 'trusted',
        sharedSecret: 'sim-secret-peer-new',
      });

      trustStore.rejectPairRequest(rejected.id);
      expect(
        trustStore.getPendingRequests().map((request) => request.status),
      ).toEqual(['approved', 'rejected']);

      trustStore.revokePeer('peer-new');
      expect(trustStore.getPeer('peer-new')).toMatchObject({
        status: 'revoked',
        sharedSecret: null,
      });

      trustStore.resetPeerToDiscovered('peer-new');
      expect(trustStore.getPeer('peer-new')).toMatchObject({
        status: 'discovered',
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('exposes deterministic trust-store helpers for peer state transitions', () => {
    const env = createSimDiscoveryEnvironment(new FakeState());
    const trustStore = env.context.trustStore as unknown as {
      completePendingEncryptedPairing: () => never;
      getPeerSecret: (instanceId: string) => string | null;
      getAllPeers: () => Array<{ instanceId: string; status: string }>;
      isPeerTrusted: (instanceId: string) => boolean;
      markPeerPending: (
        instanceId: string,
        name: string,
        host: string | null,
        port: number | null,
      ) => { instanceId: string; status: string; sharedSecret: string | null };
      updatePeerLastSeen: (instanceId: string) => void;
      revokePeer: (instanceId: string) => void;
    };

    expect(trustStore.isPeerTrusted('peer-remote-1')).toBe(true);
    expect(trustStore.getPeerSecret('peer-remote-1')).toBe(
      'sim-secret-peer-remote-1',
    );
    expect(trustStore.getPeerSecret('missing-peer')).toBeNull();

    const pending = trustStore.markPeerPending(
      'peer-pending',
      'Pending Peer',
      null,
      null,
    );
    expect(pending).toMatchObject({
      instanceId: 'peer-pending',
      status: 'pending',
      sharedSecret: null,
    });
    expect(trustStore.isPeerTrusted('peer-pending')).toBe(false);

    trustStore.updatePeerLastSeen('peer-pending');
    trustStore.updatePeerLastSeen('missing-peer');

    trustStore.revokePeer('peer-pending');
    expect(
      trustStore.getAllPeers().map((peer) => peer.instanceId),
    ).not.toContain('peer-pending');
    expect(() => trustStore.completePendingEncryptedPairing()).toThrow(
      'Encrypted pairing callbacks are not simulated',
    );
  });

  it('simulates remote context reads, writes, and metadata hashes', async () => {
    const env = createSimDiscoveryEnvironment(new FakeState());
    const createPeerClient = env.context.createPeerClient;
    expect(createPeerClient).toBeDefined();
    const peerClient = createPeerClient!(
      {
        instanceId: 'peer-remote-1',
        host: 'remote-sim.local',
        port: 3100,
        sharedSecret: 'sim-secret-peer-remote-1',
      },
      env.context,
    ) as unknown as {
      getContextLayers: (params: Record<string, string>) => Promise<{
        channel: {
          content: string | null;
          exists: boolean;
          path: string | null;
        };
      }>;
      listContextFiles: () => Promise<
        Array<{ path: string; hash: string; size: number; mtime: string }>
      >;
      writeContextFile: (
        layerPath: string,
        content: string,
      ) => Promise<{ ok: boolean }>;
    };

    const missing = await peerClient.getContextLayers({});
    expect(missing.channel).toEqual({
      path: null,
      content: null,
      exists: false,
    });

    await expect(
      peerClient.writeContextFile('remote', '# Remote Override'),
    ).resolves.toEqual({ ok: true });

    const layers = await peerClient.getContextLayers({ folder: 'remote' });
    expect(layers.channel).toEqual({
      path: 'remote',
      content: '# Remote Override',
      exists: true,
    });

    const files = await peerClient.listContextFiles();
    expect(files).toContainEqual(
      expect.objectContaining({
        path: 'remote',
        hash: 'bcf62d8b12fdaafb34efcf83fa1acf09c396634bc8bd6173a4c790a759217ac6',
        size: 17,
      }),
    );
    expect(files.find((file) => file.path === 'remote')?.mtime).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  it('resets simulated peers and rejects mutations for missing peers', () => {
    const env = createSimDiscoveryEnvironment(new FakeState());

    env.addRemotePeer({
      instanceId: 'peer-temp',
      name: 'Temporary Peer',
      host: 'temp-sim.local',
      address: '192.168.1.90',
      channelFolder: 'temp',
    });
    env.setPeerOnline('peer-temp', false);
    expect(env.listRemotePeers()).toHaveLength(2);
    expect(
      env.listRemotePeers().find((peer) => peer.instanceId === 'peer-temp'),
    ).toMatchObject({ online: false });

    env.reset();
    expect(env.listRemotePeers()).toEqual([
      expect.objectContaining({ instanceId: 'peer-remote-1', online: true }),
    ]);
    expect(() =>
      env.addRemoteLog('missing-peer', {
        level: 'info',
        msg: 'no-op',
        source: 'missing-peer',
      }),
    ).toThrow('Remote peer not found: missing-peer');
    expect(() => env.setPeerOnline('missing-peer', true)).toThrow(
      'Remote peer not found: missing-peer',
    );
  });

  it('builds a deterministic default network page state for the seeded peer', () => {
    const env = createSimDiscoveryEnvironment(new FakeState());

    const pageState = env.getNetworkPageState();

    expect(pageState).toMatchObject({
      instanceId: 'sim-local-instance',
      instanceName: 'Sim Local OmniClaw',
      discoveryAvailable: true,
      discoveryEnabled: true,
      runtime: {
        enabled: true,
        active: true,
        currentNetwork: {
          id: 'sim-lan',
          label: 'Simulated LAN',
        },
        trustedNetworks: [],
      },
      pendingRequests: [],
    });
    expect(pageState.peers).toHaveLength(1);
    expect(pageState.peers[0]).toMatchObject({
      instanceId: 'peer-remote-1',
      name: 'Remote OmniClaw',
      host: 'remote-sim.local',
      port: 3100,
      addresses: ['192.168.1.80'],
      status: 'trusted',
      online: true,
    });
  });

  it('adds an initially offline trusted peer without advertising addresses', () => {
    const env = createSimDiscoveryEnvironment(new FakeState());

    env.addRemotePeer({
      instanceId: 'peer-offline',
      name: 'Offline Builder',
      host: 'offline-sim.local',
      address: '192.168.1.99',
      channelFolder: 'offline',
      online: false,
    });

    expect(env.listRemotePeers()).toContainEqual(
      expect.objectContaining({
        instanceId: 'peer-offline',
        name: 'Offline Builder',
        online: false,
        status: 'trusted',
      }),
    );
    expect(env.getNetworkPageState().peers).toContainEqual(
      expect.objectContaining({
        instanceId: 'peer-offline',
        host: 'offline-sim.local',
        port: 3100,
        addresses: [],
        online: false,
        status: 'trusted',
      }),
    );
  });

  it('returns null when direct peer-client lookup targets an unknown peer', () => {
    const env = createSimDiscoveryEnvironment(new FakeState());
    const createPeerClient = env.context.createPeerClient;

    expect(createPeerClient).toBeDefined();
    expect(
      createPeerClient!(
        {
          instanceId: 'missing',
          host: 'missing.local',
          port: 3100,
          sharedSecret: 'sim-secret-missing',
        },
        env.context,
      ),
    ).toBe(null);
  });
});
