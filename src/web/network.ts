/**
 * Network page renderer — shows LAN peer discovery, trust management,
 * and remote agent browsing.
 */
import { renderShell, escapeHtml } from './shared.js';
import { allPageScripts } from './page-scripts.js';
import type { PeerView, PairRequest } from '../discovery/types.js';

export interface NetworkPageState {
  instanceId: string;
  instanceName: string;
  discoveryEnabled: boolean;
  peers: PeerView[];
  pendingRequests: PairRequest[];
}

/** Render just the network page content (no shell wrapper). */
export function renderNetworkContent(pageState: NetworkPageState): string {
  const { instanceId, instanceName, discoveryEnabled, peers, pendingRequests } =
    pageState;

  const trustedCount = peers.filter((p) => p.status === 'trusted').length;
  const onlineCount = peers.filter((p) => p.online).length;

  return (
    `<div data-init="window.__initPage && window.__initPage('network')">` +
    // Instance info card
    `<div class="stats-grid" style="margin-bottom:1.5rem">` +
    `<div class="stat-card"><div class="label">instance</div><div class="value" style="font-size:0.85rem">${escapeHtml(instanceName)}</div></div>` +
    `<div class="stat-card"><div class="label">discovery</div><div class="value">${discoveryEnabled ? '<span style="color:var(--green)">active</span>' : '<span style="color:var(--text-muted)">disabled</span>'}</div></div>` +
    `<div class="stat-card"><div class="label">peers online</div><div class="value" id="stat-peers-online">${onlineCount}</div></div>` +
    `<div class="stat-card"><div class="label">trusted</div><div class="value" id="stat-peers-trusted">${trustedCount}</div></div>` +
    `</div>` +
    // Instance ID
    `<div style="margin-bottom:1.5rem;padding:0.75rem 1rem;background:var(--surface);border-radius:8px;border:1px solid var(--border)">` +
    `<span style="color:var(--text-muted);font-size:0.8rem">instance id:</span> ` +
    `<code style="color:var(--text);font-size:0.8rem">${escapeHtml(instanceId)}</code>` +
    `</div>` +
    // Main layout: peers + pending
    `<div style="display:grid;grid-template-columns:1fr 320px;gap:1.5rem;align-items:start">` +
    // Peers table
    `<div class="card">` +
    `<div class="section-header"><h2>discovered peers</h2></div>` +
    `<div id="peers-container">` +
    renderPeersTable(peers) +
    `</div>` +
    `</div>` +
    // Pending requests panel
    `<div class="card" id="pending-panel">` +
    `<div class="section-header"><h2>pending requests <span class="badge" id="pending-count">${pendingRequests.length}</span></h2></div>` +
    `<div id="pending-requests">` +
    renderPendingRequests(pendingRequests) +
    `</div>` +
    `</div>` +
    `</div>` +
    // Remote agents section (populated dynamically)
    `<div id="remote-agents" style="margin-top:1.5rem"></div>` +
    // Context sync panel (populated dynamically)
    `<div id="sync-panel" style="margin-top:1.5rem"></div>` +
    `</div>`
  );
}

function renderPeersTable(peers: PeerView[]): string {
  if (peers.length === 0) {
    return `<div style="padding:2rem;text-align:center;color:var(--text-muted)">No peers discovered yet. Ensure DISCOVERY_ENABLED=true on all instances.</div>`;
  }

  const rows = renderPeerRows(peers);

  return (
    `<table class="data-table"><thead><tr>` +
    `<th>name</th><th>address</th><th>trust</th><th>online</th><th>actions</th>` +
    `</tr></thead>` +
    `<tbody id="peers-tbody">${rows}</tbody></table>`
  );
}

function renderStatusBadge(
  status: PeerView['status'],
  online: boolean,
): string {
  switch (status) {
    case 'discovered':
      return '<span class="badge">discovered</span>';
    case 'trusted':
      return '<span class="badge badge-admin">trusted</span>';
    case 'pending':
      return '<span class="badge" style="background:var(--warning);color:#000">pending</span>';
    case 'revoked':
      return '<span class="badge" style="background:var(--red);color:#fff">revoked</span>';
    default:
      return '<span class="badge">unknown</span>';
  }
}

function renderPeerActions(peer: PeerView): string {
  if (peer.status === 'trusted') {
    return (
      `<button class="btn btn-sm" data-network-action="browse" data-network-id="${escapeHtml(peer.instanceId)}">Browse</button> ` +
      `<button class="btn btn-sm btn-primary" data-network-action="sync" data-network-id="${escapeHtml(peer.instanceId)}">Sync</button> ` +
      `<button class="btn btn-sm btn-danger" data-network-action="revoke" data-network-id="${escapeHtml(peer.instanceId)}">Revoke</button>`
    );
  }
  if (peer.status === 'pending') {
    return `<span style="color:var(--text-muted);font-size:0.8rem">awaiting approval...</span>`;
  }
  if (peer.online) {
    return `<button class="btn btn-sm btn-primary" data-network-action="request" data-network-id="${escapeHtml(peer.instanceId)}">Request Access</button>`;
  }
  return `<span style="color:var(--text-muted);font-size:0.8rem">offline</span>`;
}

export function renderPendingRequests(requests: PairRequest[]): string {
  if (requests.length === 0) {
    return `<div style="padding:1.5rem;text-align:center;color:var(--text-muted);font-size:0.85rem">No pending requests</div>`;
  }

  return requests
    .map(
      (req) =>
        `<div class="task-card" style="margin-bottom:0.75rem">` +
        `<div style="margin-bottom:0.5rem"><strong>${escapeHtml(req.fromName)}</strong></div>` +
        `<div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:0.5rem">` +
        `<code>${escapeHtml(req.fromHost)}:${req.fromPort}</code><br>` +
        `ID: <code>${escapeHtml(req.fromInstanceId.slice(0, 8))}...</code>` +
        `</div>` +
        `<div style="display:flex;gap:0.5rem">` +
        `<button class="btn btn-sm btn-primary" data-network-action="approve" data-network-id="${escapeHtml(req.id)}">Approve</button>` +
        `<button class="btn btn-sm btn-danger" data-network-action="reject" data-network-id="${escapeHtml(req.id)}">Reject</button>` +
        `</div></div>`,
    )
    .join('\n');
}

export function renderPeerRows(peers: PeerView[]): string {
  return peers
    .map((peer) => {
      const statusBadge = renderStatusBadge(peer.status, peer.online);
      const actions = renderPeerActions(peer);

      return (
        `<tr data-instance-id="${escapeHtml(peer.instanceId)}">` +
        `<td><strong>${escapeHtml(peer.name)}</strong></td>` +
        `<td><code>${escapeHtml(peer.host)}:${peer.port}</code></td>` +
        `<td>${statusBadge}</td>` +
        `<td>${peer.online ? '<span style="color:var(--green)">●</span>' : '<span style="color:var(--text-muted)">○</span>'}</td>` +
        `<td>${actions}</td>` +
        `</tr>`
      );
    })
    .join('\n');
}

/** Full network page with SPA shell. */
export function renderNetworkPage(pageState: NetworkPageState): string {
  return renderShell(
    '/network',
    'Network',
    renderNetworkContent(pageState),
    allPageScripts(),
  );
}
