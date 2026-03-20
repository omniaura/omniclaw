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
});
