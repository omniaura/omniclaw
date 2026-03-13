import {
  writePersistentJson,
  readPersistentJson,
} from '../persistent-state.js';
import { logger } from '../logger.js';
import type {
  DiscoveryNetworkIdentity,
  DiscoveryRuntimeSnapshot,
  TrustedNetwork,
} from './types.js';

const SETTINGS_KEY = 'discovery_runtime_settings';

interface DiscoveryRuntimeSettings {
  enabled: boolean;
  trustedNetworks: TrustedNetwork[];
}

interface DiscoveryRuntimeControllerOptions {
  initialEnabled: boolean;
  detectCurrentNetwork: () => Promise<DiscoveryNetworkIdentity | null>;
  onActiveChange?: (
    active: boolean,
    snapshot: DiscoveryRuntimeSnapshot,
  ) => void;
  pollIntervalMs?: number;
}

export class DiscoveryRuntimeController {
  private readonly detectCurrentNetworkFn: () => Promise<DiscoveryNetworkIdentity | null>;
  private readonly onActiveChange?: (
    active: boolean,
    snapshot: DiscoveryRuntimeSnapshot,
  ) => void;
  private readonly pollIntervalMs: number;

  private enabled: boolean;
  private trustedNetworks: TrustedNetwork[];
  private currentNetwork: DiscoveryNetworkIdentity | null = null;
  private active = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DiscoveryRuntimeControllerOptions) {
    this.detectCurrentNetworkFn = options.detectCurrentNetwork;
    this.onActiveChange = options.onActiveChange;
    this.pollIntervalMs = options.pollIntervalMs ?? 15000;

    const persisted =
      readPersistentJson<DiscoveryRuntimeSettings>(SETTINGS_KEY);
    this.enabled = persisted?.enabled ?? options.initialEnabled;
    this.trustedNetworks = persisted?.trustedNetworks ?? [];
  }

  getSnapshot(): DiscoveryRuntimeSnapshot {
    return {
      enabled: this.enabled,
      active: this.active,
      currentNetwork: this.currentNetwork,
      trustedNetworks: [...this.trustedNetworks],
    };
  }

  async refresh(): Promise<DiscoveryRuntimeSnapshot> {
    try {
      this.currentNetwork = await this.detectCurrentNetworkFn();
    } catch (err) {
      logger.warn({ err }, 'Failed to detect current network');
      this.currentNetwork = null;
    }

    this.recomputeActive();
    return this.getSnapshot();
  }

  setEnabled(enabled: boolean): DiscoveryRuntimeSnapshot {
    this.enabled = enabled;
    this.persist();
    this.recomputeActive();
    return this.getSnapshot();
  }

  trustCurrentNetwork(): DiscoveryRuntimeSnapshot {
    if (!this.currentNetwork) {
      throw new Error('No current Wi-Fi network detected');
    }

    if (
      !this.trustedNetworks.some((item) => item.id === this.currentNetwork!.id)
    ) {
      this.trustedNetworks.push({
        id: this.currentNetwork.id,
        label: this.currentNetwork.label,
        trustedAt: new Date().toISOString(),
      });
      this.persist();
    }

    this.recomputeActive();
    return this.getSnapshot();
  }

  untrustNetwork(networkId: string): DiscoveryRuntimeSnapshot {
    this.trustedNetworks = this.trustedNetworks.filter(
      (item) => item.id !== networkId,
    );
    this.persist();
    this.recomputeActive();
    return this.getSnapshot();
  }

  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  isRemoteAccessAllowed(): boolean {
    return this.active;
  }

  private recomputeActive(): void {
    const currentActive =
      this.enabled &&
      (this.trustedNetworks.length === 0 ||
        (!!this.currentNetwork?.id &&
          this.trustedNetworks.some(
            (item) => item.id === this.currentNetwork?.id,
          )));

    if (currentActive === this.active) return;
    this.active = currentActive;
    this.onActiveChange?.(this.active, this.getSnapshot());
  }

  private persist(): void {
    writePersistentJson(SETTINGS_KEY, {
      enabled: this.enabled,
      trustedNetworks: this.trustedNetworks,
    });
  }
}
