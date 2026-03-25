import { createStore, reconcile } from 'solid-js/store';

export interface PeerInfo {
  instanceId: string;
  instanceName: string;
  host: string;
  port: number;
  status: string;
  online: boolean;
}

interface NetworkState {
  peers: PeerInfo[];
}

const [network, setNetwork] = createStore<NetworkState>({ peers: [] });

export { network };

export function updatePeers(data: PeerInfo[]) {
  setNetwork('peers', reconcile(data));
}

export function addPeer(peer: PeerInfo) {
  setNetwork('peers', (prev) => [...prev, peer]);
}

export function removePeer(instanceId: string) {
  setNetwork('peers', (prev) =>
    prev.filter((p) => p.instanceId !== instanceId),
  );
}
