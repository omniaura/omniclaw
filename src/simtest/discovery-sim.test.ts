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
});
