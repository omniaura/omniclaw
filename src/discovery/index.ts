export { startDiscovery } from './mdns.js';
export { DiscoveryRuntimeController } from './runtime.js';
export { detectCurrentNetwork } from './network-identity.js';
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
  RemoteAgentSummary,
  RemotePeerAgents,
  TrustedNetwork,
  DiscoveryRuntimeSnapshot,
  DiscoveryNetworkIdentity,
  DiscoveryConfig,
  DiscoveryHandle,
} from './types.js';
