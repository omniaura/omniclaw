import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { setRouterState, _initTestDatabase } from '../db.js';
import { DiscoveryRuntimeController } from './runtime.js';

describe('DiscoveryRuntimeController', () => {
  beforeEach(() => {
    _initTestDatabase();
    setRouterState('discovery_runtime_settings', '');
  });

  it('uses the env-provided initial enabled state when nothing is persisted', async () => {
    const controller = new DiscoveryRuntimeController({
      initialEnabled: true,
      detectCurrentNetwork: async () => null,
    });

    const snapshot = await controller.refresh();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.active).toBe(true);
  });

  it('disables active discovery off untrusted Wi-Fi when trusted networks exist', async () => {
    const detector = mock(async () => ({
      id: 'wifi:home',
      label: 'Home WiFi',
    }));
    const controller = new DiscoveryRuntimeController({
      initialEnabled: true,
      detectCurrentNetwork: detector,
    });

    await controller.refresh();
    controller.trustCurrentNetwork();

    detector.mockImplementation(async () => ({
      id: 'wifi:coffee',
      label: 'Coffee Shop',
    }));

    const snapshot = await controller.refresh();
    expect(snapshot.active).toBe(false);
  });

  it('lets the user disable discovery manually regardless of network trust', async () => {
    const controller = new DiscoveryRuntimeController({
      initialEnabled: true,
      detectCurrentNetwork: async () => ({
        id: 'wifi:home',
        label: 'Home WiFi',
      }),
    });

    await controller.refresh();
    controller.trustCurrentNetwork();
    const snapshot = controller.setEnabled(false);

    expect(snapshot.enabled).toBe(false);
    expect(snapshot.active).toBe(false);
  });
});
