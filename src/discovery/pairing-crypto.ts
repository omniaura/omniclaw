import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from 'crypto';

import type { EncryptedPairingEnvelope } from './types.js';

const PAIRING_ALGORITHM = 'x25519-aes-256-gcm';
const PAIRING_CONTEXT = 'omniclaw-discovery-pairing-v1';

export function generatePairingKeyPair(): {
  publicKey: string;
  privateKey: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}

export function encryptPairingSecret(
  recipientPublicKeyPem: string,
  payload: { sharedSecret: string },
): EncryptedPairingEnvelope {
  const { publicKey, privateKey } = generatePairingKeyPair();
  const derivedKey = derivePairingKey(privateKey, recipientPublicKeyPem);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derivedKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);

  return {
    algorithm: PAIRING_ALGORITHM,
    senderPublicKey: publicKey,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptPairingSecret(
  recipientPrivateKeyPem: string,
  envelope: EncryptedPairingEnvelope,
): { sharedSecret: string } {
  if (envelope.algorithm !== PAIRING_ALGORITHM) {
    throw new Error(`Unsupported pairing algorithm: ${envelope.algorithm}`);
  }

  const derivedKey = derivePairingKey(
    recipientPrivateKeyPem,
    envelope.senderPublicKey,
  );
  const decipher = createDecipheriv(
    'aes-256-gcm',
    derivedKey,
    Buffer.from(envelope.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');

  return JSON.parse(plaintext) as { sharedSecret: string };
}

function derivePairingKey(privateKeyPem: string, publicKeyPem: string): Buffer {
  const sharedSecret = diffieHellman({
    privateKey: createPrivateKey(privateKeyPem),
    publicKey: createPublicKey(publicKeyPem),
  });

  return createHash('sha256')
    .update(PAIRING_CONTEXT)
    .update(sharedSecret)
    .digest();
}
