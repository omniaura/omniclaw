/**
 * mDNS service advertisement and browsing for LAN peer discovery.
 * Uses bonjour-service (pure JS mDNS implementation).
 */
import { Bonjour } from 'bonjour-service';

import { logger } from '../logger.js';
import type {
  DiscoveredPeer,
  DiscoveryConfig,
  DiscoveryHandle,
} from './types.js';

const SERVICE_TYPE = 'omniclaw';
const OMNICLAW_SERVICE = '_omniclaw._tcp';

export function selectPeerHost(
  host: string | undefined,
  addresses: string[] | undefined,
): string {
  const preferredAddress = (addresses || []).find(
    (address) =>
      address &&
      !address.startsWith('127.') &&
      address !== '::1' &&
      address !== '::ffff:127.0.0.1',
  );

  return preferredAddress || host || 'unknown';
}

export function startDiscovery(config: DiscoveryConfig): DiscoveryHandle {
  const { instanceId, instanceName, port, version, onPeerFound, onPeerLost } =
    config;
  const peers = new Map<string, DiscoveredPeer>();

  const bonjour = new Bonjour();

  // Advertise this instance.
  // Use a distinct host to avoid conflicting with macOS's built-in
  // mDNSResponder, which otherwise detects a duplicate hostname and
  // keeps renaming the machine (e.g. Peyton-MBP-2, Peyton-MBP-3…).
  const service = bonjour.publish({
    name: `omniclaw-${instanceName}`,
    host: `omniclaw-${instanceName}.local`,
    type: SERVICE_TYPE,
    port,
    txt: {
      instanceId,
      version,
      name: instanceName,
    },
  });

  logger.info(
    { instanceId, instanceName, port, service: OMNICLAW_SERVICE },
    'mDNS: advertising OmniClaw instance',
  );

  // Browse for peers
  const browser = bonjour.find({ type: SERVICE_TYPE });

  browser.on('up', (svc) => {
    const peerId = svc.txt?.instanceId;
    if (!peerId || peerId === instanceId) return; // skip self

    const peer: DiscoveredPeer = {
      instanceId: peerId,
      name: svc.txt?.name || svc.name || 'unknown',
      host: selectPeerHost(svc.host, svc.addresses),
      port: svc.port,
      addresses: svc.addresses || [],
      version: svc.txt?.version || 'unknown',
      firstSeen: new Date().toISOString(),
    };

    peers.set(peerId, peer);
    logger.info(
      { peerId, peerName: peer.name, host: peer.host, port: peer.port },
      'mDNS: discovered peer',
    );

    onPeerFound?.(peer);
  });

  browser.on('down', (svc) => {
    const peerId = svc.txt?.instanceId;
    if (!peerId || peerId === instanceId) return;

    peers.delete(peerId);
    logger.info({ peerId }, 'mDNS: peer went offline');

    onPeerLost?.(peerId);
  });

  return {
    getPeers: () => peers,
    stop() {
      try {
        service.stop?.();
      } catch {
        // ignore cleanup errors
      }
      try {
        browser.stop();
      } catch {
        // ignore cleanup errors
      }
      try {
        bonjour.destroy();
      } catch {
        // ignore cleanup errors
      }
      peers.clear();
      logger.info('mDNS: discovery stopped');
    },
  };
}
