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
  callbackToken: string | null;
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
  callbackToken: string;
}

/** Response from POST /api/discovery/pair when a request is accepted for review */
export interface PairResponse {
  status: 'pending' | 'already_trusted';
  requestId?: string;
}

/** Response when admin approves a pair request (sent back to requester via callback) */
export interface PairApprovalCallback {
  approved: true;
  sharedSecret: string;
  instanceId: string;
  name: string;
  callbackToken: string;
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

/** A context file entry with its content hash for sync comparison. */
export interface ContextFileEntry {
  /** Relative path from groups dir (e.g. "my-group/CLAUDE.md") */
  path: string;
  /** SHA-256 hex hash of the content */
  hash: string;
  /** File size in bytes */
  size: number;
  /** Last modified time as ISO string */
  mtime: string;
}

/** Result of comparing local vs remote context files. */
export interface ContextSyncComparison {
  /** Files that exist on both sides with same content */
  same: ContextFileEntry[];
  /** Files that exist on both sides but differ */
  differs: Array<{ local: ContextFileEntry; remote: ContextFileEntry }>;
  /** Files that only exist locally */
  localOnly: ContextFileEntry[];
  /** Files that only exist on the remote */
  remoteOnly: ContextFileEntry[];
}
