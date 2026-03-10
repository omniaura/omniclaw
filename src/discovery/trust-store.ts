/**
 * Trust store — manages peer trust state in SQLite.
 * Provides CRUD for discovery_peers and pair_requests tables.
 */
import { randomBytes, randomUUID } from 'crypto';
import { Database } from 'bun:sqlite';

import { logger } from '../logger.js';
import type { PairRequest, StoredPeer } from './types.js';

/** Row type for discovery_peers table */
interface PeerRow {
  instance_id: string;
  name: string;
  shared_secret: string | null;
  status: string;
  pair_request_id: string | null;
  host: string | null;
  port: number | null;
  approved_at: string | null;
  last_seen: string | null;
  created_at: string;
}

/** Row type for pair_requests table */
interface PairRequestRow {
  id: string;
  from_instance_id: string;
  from_name: string;
  from_host: string;
  from_port: number;
  status: string;
  shared_secret: string | null;
  created_at: string;
  resolved_at: string | null;
}

function mapRowToPeer(row: PeerRow): StoredPeer {
  return {
    instanceId: row.instance_id,
    name: row.name,
    sharedSecret: row.shared_secret,
    status: row.status as StoredPeer['status'],
    pairRequestId: row.pair_request_id,
    host: row.host,
    port: row.port,
    approvedAt: row.approved_at,
    lastSeen: row.last_seen,
    createdAt: row.created_at,
  };
}

function mapRowToPairRequest(row: PairRequestRow): PairRequest {
  return {
    id: row.id,
    fromInstanceId: row.from_instance_id,
    fromName: row.from_name,
    fromHost: row.from_host,
    fromPort: row.from_port,
    status: row.status as PairRequest['status'],
    sharedSecret: row.shared_secret,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export class TrustStore {
  constructor(private db: Database) {}

  // --- Peer CRUD ---

  upsertPeer(
    instanceId: string,
    name: string,
    host: string | null,
    port: number | null,
  ): StoredPeer {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO discovery_peers (instance_id, name, host, port, status, created_at, last_seen)
         VALUES (?, ?, ?, ?, 'discovered', ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET
           name = excluded.name,
           host = excluded.host,
           port = excluded.port,
           last_seen = excluded.last_seen`,
      )
      .run(instanceId, name, host, port, now, now);

    return this.getPeer(instanceId)!;
  }

  getPeer(instanceId: string): StoredPeer | null {
    const row = this.db
      .prepare('SELECT * FROM discovery_peers WHERE instance_id = ?')
      .get(instanceId) as PeerRow | null;
    return row ? mapRowToPeer(row) : null;
  }

  getAllPeers(): StoredPeer[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM discovery_peers WHERE status != ? ORDER BY created_at DESC',
      )
      .all('revoked') as PeerRow[];
    return rows.map(mapRowToPeer);
  }

  getTrustedPeers(): StoredPeer[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM discovery_peers WHERE status = 'trusted' ORDER BY approved_at DESC",
      )
      .all() as PeerRow[];
    return rows.map(mapRowToPeer);
  }

  isPeerTrusted(instanceId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM discovery_peers WHERE instance_id = ? AND status = 'trusted'",
      )
      .get(instanceId) as { 1: number } | null;
    return row !== null;
  }

  getPeerSecret(instanceId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT shared_secret FROM discovery_peers WHERE instance_id = ? AND status = 'trusted'",
      )
      .get(instanceId) as { shared_secret: string | null } | null;
    return row?.shared_secret || null;
  }

  updatePeerLastSeen(instanceId: string): void {
    this.db
      .prepare('UPDATE discovery_peers SET last_seen = ? WHERE instance_id = ?')
      .run(new Date().toISOString(), instanceId);
  }

  markPeerPending(
    instanceId: string,
    name: string,
    host: string | null,
    port: number | null,
    requestId: string,
  ): StoredPeer {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO discovery_peers (instance_id, name, host, port, status, pair_request_id, created_at, last_seen)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET
           name = excluded.name,
           host = excluded.host,
           port = excluded.port,
           status = 'pending',
           pair_request_id = excluded.pair_request_id,
           last_seen = excluded.last_seen`,
      )
      .run(instanceId, name, host, port, requestId, now, now);

    return this.getPeer(instanceId)!;
  }

  trustPeer(
    instanceId: string,
    name: string,
    host: string | null,
    port: number | null,
    sharedSecret: string,
  ): StoredPeer {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO discovery_peers (instance_id, name, host, port, status, shared_secret, pair_request_id, approved_at, last_seen, created_at)
         VALUES (?, ?, ?, ?, 'trusted', ?, NULL, ?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET
           name = excluded.name,
           host = excluded.host,
           port = excluded.port,
           status = 'trusted',
           shared_secret = excluded.shared_secret,
           pair_request_id = NULL,
           approved_at = excluded.approved_at,
           last_seen = excluded.last_seen`,
      )
      .run(instanceId, name, host, port, sharedSecret, now, now, now);

    return this.getPeer(instanceId)!;
  }

  revokePeer(instanceId: string): void {
    this.db
      .prepare(
        "UPDATE discovery_peers SET status = 'revoked', shared_secret = NULL, pair_request_id = NULL WHERE instance_id = ?",
      )
      .run(instanceId);
    logger.info({ instanceId }, 'Trust revoked for peer');
  }

  deletePeer(instanceId: string): void {
    this.db
      .prepare('DELETE FROM discovery_peers WHERE instance_id = ?')
      .run(instanceId);
  }

  // --- Pair Request CRUD ---

  createPairRequest(
    fromInstanceId: string,
    fromName: string,
    fromHost: string,
    fromPort: number,
  ): PairRequest {
    // Check for existing pending request from same instance
    const existing = this.db
      .prepare(
        "SELECT * FROM pair_requests WHERE from_instance_id = ? AND status = 'pending'",
      )
      .get(fromInstanceId) as PairRequestRow | null;

    if (existing) {
      // Update existing request
      this.db
        .prepare(
          'UPDATE pair_requests SET from_name = ?, from_host = ?, from_port = ?, created_at = ? WHERE id = ?',
        )
        .run(
          fromName,
          fromHost,
          fromPort,
          new Date().toISOString(),
          existing.id,
        );
      return mapRowToPairRequest({
        ...existing,
        from_name: fromName,
        from_host: fromHost,
        from_port: fromPort,
      });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pair_requests (id, from_instance_id, from_name, from_host, from_port, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(id, fromInstanceId, fromName, fromHost, fromPort, now);

    logger.info(
      { requestId: id, fromInstanceId, fromName },
      'New pair request received',
    );

    return {
      id,
      fromInstanceId,
      fromName,
      fromHost,
      fromPort,
      status: 'pending',
      sharedSecret: null,
      createdAt: now,
      resolvedAt: null,
    };
  }

  getPendingRequests(): PairRequest[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM pair_requests WHERE status = 'pending' ORDER BY created_at DESC",
      )
      .all() as PairRequestRow[];
    return rows.map(mapRowToPairRequest);
  }

  getRequestById(id: string): PairRequest | null {
    const row = this.db
      .prepare('SELECT * FROM pair_requests WHERE id = ?')
      .get(id) as PairRequestRow | null;
    return row ? mapRowToPairRequest(row) : null;
  }

  /**
   * Approve a pair request: generates shared secret, marks request approved,
   * and upserts the peer as trusted.
   * Returns the shared secret to send back to the requester.
   */
  approvePairRequest(requestId: string): {
    sharedSecret: string;
    request: PairRequest;
  } {
    const request = this.getRequestById(requestId);
    if (!request) throw new Error(`Pair request not found: ${requestId}`);
    if (request.status !== 'pending')
      throw new Error(`Request already ${request.status}`);

    const sharedSecret = randomBytes(32).toString('hex');
    const now = new Date().toISOString();

    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE pair_requests SET status = 'approved', shared_secret = ?, resolved_at = ? WHERE id = ?",
        )
        .run(sharedSecret, now, requestId);

      this.db
        .prepare(
          `INSERT INTO discovery_peers (instance_id, name, host, port, status, shared_secret, pair_request_id, approved_at, last_seen, created_at)
           VALUES (?, ?, ?, ?, 'trusted', ?, NULL, ?, ?, ?)
           ON CONFLICT(instance_id) DO UPDATE SET
             name = excluded.name,
             host = excluded.host,
             port = excluded.port,
             status = 'trusted',
             shared_secret = excluded.shared_secret,
             pair_request_id = NULL,
             approved_at = excluded.approved_at,
             last_seen = excluded.last_seen`,
        )
        .run(
          request.fromInstanceId,
          request.fromName,
          request.fromHost,
          request.fromPort,
          sharedSecret,
          now,
          now,
          now,
        );
    })();

    logger.info(
      { requestId, instanceId: request.fromInstanceId },
      'Pair request approved',
    );

    return {
      sharedSecret,
      request: {
        ...request,
        status: 'approved',
        sharedSecret,
        resolvedAt: now,
      },
    };
  }

  rejectPairRequest(requestId: string): void {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE pair_requests SET status = 'rejected', resolved_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(now, requestId);
    if (result.changes !== 1) {
      const request = this.getRequestById(requestId);
      if (!request) throw new Error(`Pair request not found: ${requestId}`);
      throw new Error(`Request already ${request.status}`);
    }
    logger.info({ requestId }, 'Pair request rejected');
  }

  getPairingStatus(
    requestId: string,
    requesterInstanceId: string,
  ): {
    status: 'pending' | 'approved';
    sharedSecret?: string;
    name?: string;
  } | null {
    const request = this.getRequestById(requestId);
    if (!request || request.fromInstanceId !== requesterInstanceId) return null;

    if (request.status === 'approved' && request.sharedSecret) {
      return {
        status: 'approved',
        sharedSecret: request.sharedSecret,
        name: request.fromName,
      };
    }

    if (request.status === 'pending') {
      return { status: 'pending' };
    }

    return null;
  }

  // --- Instance ID Management ---

  getOrCreateInstanceId(): string {
    const row = this.db
      .prepare(
        "SELECT value FROM router_state WHERE key = 'discovery_instance_id'",
      )
      .get() as { value: string } | null;

    if (row) return row.value;

    const instanceId = randomUUID();
    this.db
      .prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)')
      .run('discovery_instance_id', instanceId);

    logger.info({ instanceId }, 'Generated new discovery instance ID');
    return instanceId;
  }
}
