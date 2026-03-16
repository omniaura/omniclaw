import { describe, expect, it } from 'bun:test';

import {
  renderNetworkContent,
  renderNetworkPage,
  renderPeerRows,
  renderPendingRequests,
} from './network.js';
import type {
  DiscoveryRuntimeSnapshot,
  PairRequest,
  PeerView,
} from '../discovery/types.js';

function makePeer(overrides: Partial<PeerView> = {}): PeerView {
  return {
    instanceId: 'peer-1',
    name: 'Peer One',
    host: 'peer.local',
    port: 8080,
    addresses: ['192.168.1.10'],
    status: 'discovered',
    online: true,
    approvedAt: null,
    lastSeen: null,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<PairRequest> = {}): PairRequest {
  return {
    id: 'req-1',
    fromInstanceId: 'remote-instance-abcdef',
    fromName: 'Remote Peer',
    fromHost: 'remote.local',
    fromPort: 3000,
    callbackToken: 'token',
    status: 'pending',
    sharedSecret: null,
    createdAt: '2026-03-13T00:00:00.000Z',
    resolvedAt: null,
    ...overrides,
  };
}

function makeRuntime(
  overrides: Partial<DiscoveryRuntimeSnapshot> = {},
): DiscoveryRuntimeSnapshot {
  return {
    enabled: true,
    active: true,
    currentNetwork: null,
    trustedNetworks: [],
    ...overrides,
  };
}

describe('renderNetworkContent', () => {
  it('renders escaped instance metadata and computed stats', () => {
    const html = renderNetworkContent({
      instanceId: 'local<id>',
      instanceName: 'Main <Node> & "Ops"',
      discoveryAvailable: true,
      discoveryEnabled: true,
      runtime: makeRuntime(),
      peers: [
        makePeer({ status: 'trusted', online: true }),
        makePeer({ instanceId: 'peer-2', status: 'pending', online: false }),
      ],
      pendingRequests: [makeRequest()],
    });

    expect(html).toContain('Main &lt;Node&gt; &amp; &quot;Ops&quot;');
    expect(html).toContain(
      '<code style="color:var(--text);font-size:0.8rem">local&lt;id&gt;</code>',
    );
    expect(html).toContain('<span style="color:var(--green)">active</span>');
    expect(html).toContain('id="stat-peers-online">1<');
    expect(html).toContain('id="stat-peers-trusted">1<');
    expect(html).toContain('id="pending-count">1<');
    expect(html).toContain('id="remote-agents"');
    expect(html).toContain('id="sync-panel"');
  });

  it('renders empty-state copy when no peers or pending requests exist', () => {
    const html = renderNetworkContent({
      instanceId: 'local-id',
      instanceName: 'Main Node',
      discoveryAvailable: true,
      discoveryEnabled: false,
      runtime: makeRuntime({ enabled: false, active: false }),
      peers: [],
      pendingRequests: [],
    });

    expect(html).toContain(
      '<span style="color:var(--text-muted)">disabled</span>',
    );
    expect(html).toContain(
      'No peers discovered yet. Ensure DISCOVERY_ENABLED=true on all instances.',
    );
    expect(html).toContain('No pending requests');
    expect(html).toContain('id="pending-count">0<');
  });

  it('disables discovery controls when discovery routes are unavailable', () => {
    const html = renderNetworkContent({
      instanceId: '',
      instanceName: '',
      discoveryAvailable: false,
      discoveryEnabled: false,
      runtime: makeRuntime({ enabled: false, active: false }),
      peers: [],
      pendingRequests: [],
    });

    expect(html).toContain(
      'id="network-root" data-discovery-available="false"',
    );
    expect(html).toContain('id="discovery-toggle"');
    expect(html).toContain(
      'id="discovery-toggle" data-network-action="toggle-discovery" data-network-id="on" disabled',
    );
    expect(html).toContain(
      'id="trust-current-network" data-network-action="trust-current-network" data-network-id="current" disabled',
    );
    expect(html).toContain(
      'Discovery controls are unavailable in this environment.',
    );
  });
});

describe('renderPendingRequests', () => {
  it('renders an empty state when there are no requests', () => {
    expect(renderPendingRequests([])).toContain('No pending requests');
  });

  it('renders escaped request details and action buttons', () => {
    const html = renderPendingRequests([
      makeRequest({
        id: 'req-<1>',
        fromInstanceId: '123456789abcdef',
        fromName: 'Remote <Admin>',
        fromHost: 'remote<&>.local',
        fromPort: 4040,
      }),
    ]);

    expect(html).toContain('<strong>Remote &lt;Admin&gt;</strong>');
    expect(html).toContain('<code>remote&lt;&amp;&gt;.local:4040</code>');
    expect(html).toContain('ID: <code>12345678...</code>');
    expect(html).toContain('data-network-id="req-&lt;1&gt;"');
    expect(html).toContain('Approve</button>');
    expect(html).toContain('Reject</button>');
  });
});

describe('renderPeerRows', () => {
  it('renders trusted peers with management actions', () => {
    const html = renderPeerRows([
      makePeer({
        instanceId: 'trusted-1',
        name: 'Trusted <Peer>',
        status: 'trusted',
        online: true,
      }),
    ]);

    expect(html).toContain('data-instance-id="trusted-1"');
    expect(html).toContain('<strong>Trusted &lt;Peer&gt;</strong>');
    expect(html).toContain('<span class="badge badge-admin">trusted</span>');
    expect(html).toContain('data-network-action="browse"');
    expect(html).toContain('data-network-action="sync"');
    expect(html).toContain('data-network-action="revoke"');
    expect(html).toContain('<span style="color:var(--green)">●</span>');
  });

  it('renders pending peers as awaiting approval', () => {
    const html = renderPeerRows([
      makePeer({ status: 'pending', online: false }),
    ]);

    expect(html).toContain(
      '<span class="badge" style="background:var(--warning);color:#000">pending</span>',
    );
    expect(html).toContain('awaiting approval...');
    expect(html).toContain('<span style="color:var(--text-muted)">○</span>');
  });

  it('renders discovered online peers with access request actions', () => {
    const html = renderPeerRows([
      makePeer({ status: 'discovered', online: true }),
    ]);

    expect(html).toContain('<span class="badge">discovered</span>');
    expect(html).toContain('data-network-action="request"');
    expect(html).not.toContain('awaiting approval...');
  });

  it('renders revoked and unknown peers with fallback badges and offline state', () => {
    const html = renderPeerRows([
      makePeer({ instanceId: 'revoked-1', status: 'revoked', online: false }),
      makePeer({
        instanceId: 'unknown-1',
        status: 'mystery' as PeerView['status'],
        online: false,
      }),
    ]);

    expect(html).toContain(
      '<span class="badge" style="background:var(--red);color:#fff">revoked</span>',
    );
    expect(html).toContain('<span class="badge">unknown</span>');
    expect(html).toContain('offline</span>');
  });
});

describe('renderNetworkPage', () => {
  it('wraps network content in the shared shell', () => {
    const html = renderNetworkPage({
      instanceId: 'instance-1',
      instanceName: 'Main Node',
      discoveryAvailable: true,
      discoveryEnabled: true,
      runtime: makeRuntime(),
      peers: [makePeer()],
      pendingRequests: [makeRequest()],
    });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title id="page-title">OmniClaw — Network</title>');
    expect(html).toContain('class="nav-link active">Network</a>');
    expect(html).toContain("window.__initPage && window.__initPage('network')");
    expect(html).toContain(
      'https://cdn.jsdelivr.net/gh/starfederation/datastar',
    );
  });
});
