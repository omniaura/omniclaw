/**
 * Trust store — manages peer trust state in SQLite.
 * Provides CRUD for discovery_peers and pair_requests tables.
 */
import { randomBytes, randomUUID } from 'crypto';
import { Database } from 'bun:sqlite';

import { logger } from '../logger.js';
import { decryptPairingSecret } from './pairing-crypto.js';
import type { EncryptedPairingEnvelope } from './types.js';
import type { PairRequest, StoredPeer } from './types.js';

/** Row type for discovery_peers table */
interface PeerRow {
  instance_id: string;
  name: string;
  shared_secret: string | null;
  pairing_token: string | null;
  pairing_private_key: string | null;
  status: string;
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
  callback_token: string | null;
  key_agreement_public_key: string | null;
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
    callbackToken: row.callback_token,
    keyAgreementPublicKey: row.key_agreement_public_key,
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

  markPeerPending(
    instanceId: string,
    name: string,
    host: string | null,
    port: number | null,
    pairingToken: string,
    pairingPrivateKey: string,
  ): StoredPeer {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO discovery_peers (instance_id, name, host, port, status, pairing_token, created_at, last_seen)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET
            name = excluded.name,
            host = excluded.host,
            port = excluded.port,
            status = 'pending',
            pairing_token = excluded.pairing_token,
            last_seen = excluded.last_seen`,
      )
      .run(instanceId, name, host, port, pairingToken, now, now);
    this.db
      .prepare(
        'UPDATE discovery_peers SET pairing_private_key = ? WHERE instance_id = ?',
      )
      .run(pairingPrivateKey, instanceId);

    return this.getPeer(instanceId)!;
  }

  resetPeerToDiscovered(instanceId: string): void {
    this.db
      .prepare(
        "UPDATE discovery_peers SET status = 'discovered', pairing_token = NULL, pairing_private_key = NULL WHERE instance_id = ?",
      )
      .run(instanceId);
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

  revokePeer(instanceId: string): void {
    this.db
      .prepare(
        "UPDATE discovery_peers SET status = 'revoked', shared_secret = NULL, pairing_token = NULL, pairing_private_key = NULL WHERE instance_id = ?",
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
    callbackToken: string,
    keyAgreementPublicKey?: string,
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
          'UPDATE pair_requests SET from_name = ?, from_host = ?, from_port = ?, callback_token = ?, key_agreement_public_key = ?, created_at = ? WHERE id = ?',
        )
        .run(
          fromName,
          fromHost,
          fromPort,
          callbackToken,
          keyAgreementPublicKey ?? null,
          new Date().toISOString(),
          existing.id,
        );
      return mapRowToPairRequest({
        ...existing,
        from_name: fromName,
        from_host: fromHost,
        from_port: fromPort,
        callback_token: callbackToken,
        key_agreement_public_key: keyAgreementPublicKey ?? null,
      });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pair_requests (id, from_instance_id, from_name, from_host, from_port, status, created_at, callback_token, key_agreement_public_key)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        id,
        fromInstanceId,
        fromName,
        fromHost,
        fromPort,
        now,
        callbackToken,
        keyAgreementPublicKey ?? null,
      );

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
      callbackToken,
      keyAgreementPublicKey: keyAgreementPublicKey ?? null,
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
          `INSERT INTO discovery_peers (instance_id, name, host, port, status, shared_secret, approved_at, last_seen, created_at, pairing_token)
           VALUES (?, ?, ?, ?, 'trusted', ?, ?, ?, ?, NULL)
           ON CONFLICT(instance_id) DO UPDATE SET
              name = excluded.name,
              host = excluded.host,
              port = excluded.port,
              status = 'trusted',
              shared_secret = excluded.shared_secret,
              approved_at = excluded.approved_at,
              last_seen = excluded.last_seen,
              pairing_token = NULL`,
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
      throw new Error(`Request not pending or not found: ${requestId}`);
    }
    logger.info({ requestId }, 'Pair request rejected');
  }

  completePendingPairing(
    instanceId: string,
    name: string,
    sharedSecret: string,
    callbackToken: string,
  ): void {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE discovery_peers
         SET name = ?, status = 'trusted', shared_secret = ?, approved_at = ?, last_seen = ?, pairing_token = NULL, pairing_private_key = NULL
         WHERE instance_id = ? AND status = 'pending' AND pairing_token = ?`,
      )
      .run(name, sharedSecret, now, now, instanceId, callbackToken);

    if (result.changes !== 1) {
      throw new Error(`No pending pairing found for peer: ${instanceId}`);
    }
  }

  completePendingEncryptedPairing(
    instanceId: string,
    name: string,
    approval: EncryptedPairingEnvelope,
    callbackToken: string,
  ): void {
    const row = this.db
      .prepare(
        `SELECT pairing_private_key FROM discovery_peers
         WHERE instance_id = ? AND status = 'pending' AND pairing_token = ?`,
      )
      .get(instanceId, callbackToken) as {
      pairing_private_key: string | null;
    } | null;

    if (!row?.pairing_private_key) {
      throw new Error(
        `No pending encrypted pairing found for peer: ${instanceId}`,
      );
    }

    const payload = decryptPairingSecret(row.pairing_private_key, approval);
    this.completePendingPairing(
      instanceId,
      name,
      payload.sharedSecret,
      callbackToken,
    );
  }

  // --- Instance ID Management ---

  getOrCreateInstanceId(db: Database): string {
    const row = db
      .prepare(
        "SELECT value FROM router_state WHERE key = 'discovery_instance_id'",
      )
      .get() as { value: string } | null;

    if (row) return row.value;

    const instanceId = randomUUID();
    db.prepare(
      'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
    ).run('discovery_instance_id', instanceId);

    logger.info({ instanceId }, 'Generated new discovery instance ID');
    return instanceId;
  }
}
