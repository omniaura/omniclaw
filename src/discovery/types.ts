/** A peer discovered on the local network via mDNS. */
export interface DiscoveredPeer {
  instanceId: string;
  name: string;
  host: string;
  port: number;
  addresses: string[];
  version: string;
  firstSeen: string;
}

/** A peer stored in the database with trust state. */
export interface StoredPeer {
  instanceId: string;
  name: string;
  sharedSecret: string | null;
  status: PeerStatus;
  host: string | null;
  port: number | null;
  approvedAt: string | null;
  lastSeen: string | null;
  createdAt: string;
}

export type PeerStatus = 'discovered' | 'pending' | 'trusted' | 'revoked';

/** An inbound pairing request from a remote instance. */
export interface PairRequest {
  id: string;
  fromInstanceId: string;
  fromName: string;
  fromHost: string;
  fromPort: number;
  status: 'pending' | 'approved' | 'rejected';
  sharedSecret: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** Combined view of a peer: mDNS discovery + DB trust state. */
export interface PeerView {
  instanceId: string;
  name: string;
  host: string;
  port: number;
  addresses: string[];
  status: PeerStatus;
  online: boolean;
  approvedAt: string | null;
  lastSeen: string | null;
}

/** Response from GET /api/discovery/info */
export interface PeerInfoResponse {
  instanceId: string;
  name: string;
  version: string;
  agentCount: number;
}

/** Body for POST /api/discovery/pair */
export interface PairRequestBody {
  instanceId: string;
  name: string;
  host: string;
  port: number;
}

/** Response from POST /api/discovery/pair when a request is accepted for review */
export interface PairResponse {
  status: 'pending' | 'already_trusted';
  requestId?: string;
  sharedSecret?: string;
}

/** Response when admin approves a pair request (sent back to requester via callback) */
export interface PairApprovalCallback {
  approved: true;
  sharedSecret: string;
  instanceId: string;
  name: string;
}

export interface DiscoveryConfig {
  instanceId: string;
  instanceName: string;
  port: number;
  version: string;
  onPeerFound?: (peer: DiscoveredPeer) => void;
  onPeerLost?: (instanceId: string) => void;
}

export interface DiscoveryHandle {
  getPeers(): Map<string, DiscoveredPeer>;
  stop(): void;
}
