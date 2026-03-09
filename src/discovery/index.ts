export { startDiscovery } from './mdns.js';
export { TrustStore } from './trust-store.js';
export { PeerClient } from './peer-client.js';
export {
  handleDiscoveryRequest,
  checkPeerAuth,
  type DiscoveryRouteContext,
} from './routes.js';
export type {
  ContextFileEntry,
  ContextSyncComparison,
  DiscoveredPeer,
  StoredPeer,
  PairRequest,
  PeerView,
  PeerInfoResponse,
  DiscoveryConfig,
  DiscoveryHandle,
} from './types.js';
