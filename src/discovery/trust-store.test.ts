import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import { createSchema } from '../db.js';
import { TrustStore } from './trust-store.js';

function makeTrustStore() {
  const db = new Database(':memory:');
  createSchema(db);
  return { db, trustStore: new TrustStore(db) };
}

describe('TrustStore', () => {
  it('transitions peers through discovered, pending, trusted, and revoked states', () => {
    const { trustStore } = makeTrustStore();

    expect(
      trustStore.upsertPeer('peer-1', 'Peer One', '10.0.0.10', 7001),
    ).toMatchObject({
      instanceId: 'peer-1',
      status: 'discovered',
      host: '10.0.0.10',
      port: 7001,
    });

    expect(
      trustStore.markPeerPending(
        'peer-1',
        'Peer Pending',
        '10.0.0.11',
        7002,
        'pair-token',
        'private-key',
      ),
    ).toMatchObject({
      instanceId: 'peer-1',
      name: 'Peer Pending',
      status: 'pending',
      host: '10.0.0.11',
      port: 7002,
    });

    trustStore.completePendingPairing(
      'peer-1',
      'Peer Trusted',
      'shared-secret',
      'pair-token',
    );

    expect(trustStore.getPeer('peer-1')).toMatchObject({
      instanceId: 'peer-1',
      name: 'Peer Trusted',
      status: 'trusted',
      sharedSecret: 'shared-secret',
    });
    expect(trustStore.isPeerTrusted('peer-1')).toBe(true);
    expect(trustStore.getPeerSecret('peer-1')).toBe('shared-secret');
    expect(trustStore.getTrustedPeers()).toHaveLength(1);

    trustStore.revokePeer('peer-1');

    expect(trustStore.getPeer('peer-1')).toMatchObject({
      instanceId: 'peer-1',
      status: 'revoked',
      sharedSecret: null,
    });
    expect(trustStore.isPeerTrusted('peer-1')).toBe(false);
    expect(trustStore.getPeerSecret('peer-1')).toBeNull();
    expect(trustStore.getAllPeers()).toEqual([]);
  });

  it('resets pending peers back to discovered and clears pairing secrets', () => {
    const { db, trustStore } = makeTrustStore();

    trustStore.markPeerPending(
      'peer-2',
      'Peer Two',
      '10.0.0.20',
      7003,
      'pair-token-2',
      'private-key-2',
    );

    trustStore.resetPeerToDiscovered('peer-2');

    expect(trustStore.getPeer('peer-2')).toMatchObject({
      instanceId: 'peer-2',
      status: 'discovered',
      sharedSecret: null,
    });

    const row = db
      .prepare(
        'SELECT pairing_token, pairing_private_key FROM discovery_peers WHERE instance_id = ?',
      )
      .get('peer-2') as {
      pairing_token: string | null;
      pairing_private_key: string | null;
    };

    expect(row).toEqual({
      pairing_token: null,
      pairing_private_key: null,
    });
  });

  it('reuses an existing pending request for the same peer', () => {
    const { trustStore } = makeTrustStore();

    const first = trustStore.createPairRequest(
      'peer-3',
      'Peer Three',
      '10.0.0.30',
      7004,
      'callback-a',
      'pub-a',
    );
    const second = trustStore.createPairRequest(
      'peer-3',
      'Peer Three Updated',
      '10.0.0.31',
      7005,
      'callback-b',
      'pub-b',
    );

    expect(second.id).toBe(first.id);
    expect(trustStore.getPendingRequests()).toHaveLength(1);
    expect(trustStore.getRequestById(first.id)).toMatchObject({
      id: first.id,
      fromName: 'Peer Three Updated',
      fromHost: '10.0.0.31',
      fromPort: 7005,
      callbackToken: 'callback-b',
      keyAgreementPublicKey: 'pub-b',
      status: 'pending',
    });
  });

  it('approves and rejects pair requests with strict pending-state checks', () => {
    const { trustStore } = makeTrustStore();

    const approvedRequest = trustStore.createPairRequest(
      'peer-4',
      'Peer Four',
      '10.0.0.40',
      7006,
      'callback-c',
    );
    const rejectedRequest = trustStore.createPairRequest(
      'peer-5',
      'Peer Five',
      '10.0.0.50',
      7007,
      'callback-d',
    );

    const approval = trustStore.approvePairRequest(approvedRequest.id);

    expect(approval.sharedSecret).toHaveLength(64);
    expect(approval.request).toMatchObject({
      id: approvedRequest.id,
      status: 'approved',
      fromInstanceId: 'peer-4',
    });
    expect(trustStore.getPeer('peer-4')).toMatchObject({
      instanceId: 'peer-4',
      status: 'trusted',
      sharedSecret: approval.sharedSecret,
    });

    expect(() => trustStore.approvePairRequest(approvedRequest.id)).toThrow(
      'Request already approved',
    );

    trustStore.rejectPairRequest(rejectedRequest.id);
    expect(trustStore.getRequestById(rejectedRequest.id)).toMatchObject({
      id: rejectedRequest.id,
      status: 'rejected',
    });
    expect(() => trustStore.rejectPairRequest(rejectedRequest.id)).toThrow(
      `Request not pending or not found: ${rejectedRequest.id}`,
    );
  });

  it('persists a generated instance id and reuses it on later reads', () => {
    const { db, trustStore } = makeTrustStore();

    const first = trustStore.getOrCreateInstanceId(db);
    const second = trustStore.getOrCreateInstanceId(db);

    expect(first).toBe(second);
    expect(first).toHaveLength(36);
  });
});
