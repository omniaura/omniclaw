import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import { createSchema } from '../db.js';
import {
  decryptPairingSecret,
  encryptPairingSecret,
  generatePairingKeyPair,
} from './pairing-crypto.js';
import { TrustStore } from './trust-store.js';

describe('pairing crypto', () => {
  it('round-trips encrypted pairing secrets', () => {
    const keyPair = generatePairingKeyPair();
    const envelope = encryptPairingSecret(keyPair.publicKey, {
      sharedSecret: 'test-secret',
    });

    expect(decryptPairingSecret(keyPair.privateKey, envelope)).toEqual({
      sharedSecret: 'test-secret',
    });
  });

  it('completes pending encrypted pairings from stored private keys', () => {
    const db = new Database(':memory:');
    createSchema(db);
    const trustStore = new TrustStore(db);
    const keyPair = generatePairingKeyPair();

    trustStore.markPeerPending(
      'peer-1',
      'Peer One',
      '127.0.0.1',
      6001,
      'pair-token',
      keyPair.privateKey,
    );

    const approval = encryptPairingSecret(keyPair.publicKey, {
      sharedSecret: 'encrypted-secret',
    });

    trustStore.completePendingEncryptedPairing(
      'peer-1',
      'Peer One',
      approval,
      'pair-token',
    );

    expect(trustStore.getPeer('peer-1')).toMatchObject({
      instanceId: 'peer-1',
      status: 'trusted',
      sharedSecret: 'encrypted-secret',
    });
  });
});
