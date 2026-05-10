import { afterEach, describe, expect, it, mock } from 'bun:test';

afterEach(() => {
  currentHarness = null;
});

type ServiceHandler = (service: {
  txt?: Record<string, string>;
  name?: string;
  host?: string;
  port: number;
  addresses?: string[];
}) => void;

interface BonjourHarness {
  handlers: Map<string, ServiceHandler>;
  publishCalls: unknown[];
  serviceStop: ReturnType<typeof mock>;
  browserStop: ReturnType<typeof mock>;
  destroy: ReturnType<typeof mock>;
}

function installBonjourMock(
  options: { cleanupThrows?: boolean } = {},
): BonjourHarness {
  const handlers = new Map<string, ServiceHandler>();
  const publishCalls: unknown[] = [];
  const serviceStop = mock(() => {
    if (options.cleanupThrows) throw new Error('service stop failed');
  });
  const browserStop = mock(() => {
    if (options.cleanupThrows) throw new Error('browser stop failed');
  });
  const destroy = mock(() => {
    if (options.cleanupThrows) throw new Error('destroy failed');
  });

  currentHarness = {
    handlers,
    publishCalls,
    serviceStop,
    browserStop,
    destroy,
  };

  return currentHarness;
}

let currentHarness: BonjourHarness | null = null;

class BonjourMock {
  publish(config: unknown) {
    if (!currentHarness) throw new Error('Missing Bonjour test harness');
    currentHarness.publishCalls.push(config);
    return { stop: currentHarness.serviceStop };
  }

  find(config: unknown) {
    if (!currentHarness) throw new Error('Missing Bonjour test harness');
    expect(config).toEqual({ type: 'omniclaw' });
    return {
      on: mock((event: string, handler: ServiceHandler) => {
        currentHarness?.handlers.set(event, handler);
      }),
      stop: currentHarness.browserStop,
    };
  }

  destroy() {
    if (!currentHarness) throw new Error('Missing Bonjour test harness');
    currentHarness.destroy();
  }
}

mock.module('bonjour-service', () => ({ Bonjour: BonjourMock }));

const { selectPeerHost, startDiscovery } = await import('./mdns.js');

describe('selectPeerHost', () => {
  it('prefers a routable IP address over an mDNS hostname', () => {
    expect(selectPeerHost('orangepi5', ['10.0.0.118', 'fe80::1'])).toBe(
      '10.0.0.118',
    );
  });

  it('falls back to the host when no usable address exists', () => {
    expect(selectPeerHost('orangepi5', ['127.0.0.1', '::1'])).toBe('orangepi5');
  });

  it('returns unknown when host and addresses are missing', () => {
    expect(selectPeerHost(undefined, undefined)).toBe('unknown');
  });
});

describe('startDiscovery', () => {
  it('advertises the local instance and tracks peer up/down events', async () => {
    const harness = installBonjourMock();
    const foundPeers: unknown[] = [];
    const lostPeers: string[] = [];

    const handle = startDiscovery({
      instanceId: 'local-1',
      instanceName: 'peyton',
      port: 8787,
      version: '1.2.3',
      onPeerFound: (peer) => foundPeers.push(peer),
      onPeerLost: (peerId) => lostPeers.push(peerId),
    });

    expect(harness.publishCalls).toEqual([
      {
        name: 'omniclaw-peyton',
        host: 'omniclaw-peyton.local',
        type: 'omniclaw',
        port: 8787,
        txt: {
          instanceId: 'local-1',
          version: '1.2.3',
          name: 'peyton',
        },
      },
    ]);

    harness.handlers.get('up')?.({
      txt: { instanceId: 'local-1', name: 'self', version: '1.2.3' },
      name: 'self-service',
      host: 'self.local',
      port: 8787,
      addresses: ['10.0.0.1'],
    });
    expect(handle.getPeers().size).toBe(0);

    harness.handlers.get('up')?.({
      txt: { instanceId: 'remote-1', name: 'Remote', version: '2.0.0' },
      name: 'remote-service',
      host: 'remote.local',
      port: 9999,
      addresses: ['127.0.0.1', '10.0.0.55'],
    });

    expect(handle.getPeers().get('remote-1')).toMatchObject({
      instanceId: 'remote-1',
      name: 'Remote',
      host: '10.0.0.55',
      port: 9999,
      addresses: ['127.0.0.1', '10.0.0.55'],
      version: '2.0.0',
    });
    expect(foundPeers).toHaveLength(1);

    harness.handlers.get('down')?.({
      txt: { instanceId: 'remote-1' },
      port: 9999,
    });
    expect(handle.getPeers().has('remote-1')).toBe(false);
    expect(lostPeers).toEqual(['remote-1']);
  });

  it('falls back peer fields and clears state even when cleanup throws', async () => {
    const harness = installBonjourMock({ cleanupThrows: true });

    const handle = startDiscovery({
      instanceId: 'local-1',
      instanceName: 'peyton',
      port: 8787,
      version: '1.2.3',
    });

    harness.handlers.get('up')?.({
      txt: { instanceId: 'remote-2' },
      name: 'remote-service',
      port: 9999,
    });

    expect(handle.getPeers().get('remote-2')).toMatchObject({
      instanceId: 'remote-2',
      name: 'remote-service',
      host: 'unknown',
      addresses: [],
      version: 'unknown',
    });

    expect(() => handle.stop()).not.toThrow();
    expect(harness.serviceStop).toHaveBeenCalledTimes(1);
    expect(harness.browserStop).toHaveBeenCalledTimes(1);
    expect(harness.destroy).toHaveBeenCalledTimes(1);
    expect(handle.getPeers().size).toBe(0);
  });
});
