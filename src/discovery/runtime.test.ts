import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { setRouterState, _initTestDatabase } from '../db.js';
import { logger } from '../logger.js';
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

  it('prefers persisted settings over the initial enabled flag', async () => {
    setRouterState(
      'discovery_runtime_settings',
      JSON.stringify({
        enabled: false,
        trustedNetworks: [
          {
            id: 'wifi:home',
            label: 'Home WiFi',
            trustedAt: '2026-03-01T00:00:00.000Z',
          },
        ],
      }),
    );

    const controller = new DiscoveryRuntimeController({
      initialEnabled: true,
      detectCurrentNetwork: async () => ({
        id: 'wifi:home',
        label: 'Home WiFi',
      }),
    });

    const snapshot = await controller.refresh();

    expect(snapshot).toMatchObject({
      enabled: false,
      active: false,
      currentNetwork: {
        id: 'wifi:home',
        label: 'Home WiFi',
      },
      trustedNetworks: [
        {
          id: 'wifi:home',
          label: 'Home WiFi',
          trustedAt: '2026-03-01T00:00:00.000Z',
        },
      ],
    });
  });

  it('throws when trusting a network before one has been detected', () => {
    const controller = new DiscoveryRuntimeController({
      initialEnabled: true,
      detectCurrentNetwork: async () => null,
    });

    expect(() => controller.trustCurrentNetwork()).toThrow(
      'No current Wi-Fi network detected',
    );
  });

  it('does not duplicate trusted networks and falls back to permissive mode when all trusts are removed', async () => {
    const controller = new DiscoveryRuntimeController({
      initialEnabled: true,
      detectCurrentNetwork: async () => ({
        id: 'wifi:home',
        label: 'Home WiFi',
      }),
    });

    await controller.refresh();

    const firstTrust = controller.trustCurrentNetwork();
    const secondTrust = controller.trustCurrentNetwork();

    expect(firstTrust.trustedNetworks).toHaveLength(1);
    expect(secondTrust.trustedNetworks).toHaveLength(1);
    expect(controller.isRemoteAccessAllowed()).toBe(true);

    const snapshot = controller.untrustNetwork('wifi:home');

    expect(snapshot.trustedNetworks).toEqual([]);
    expect(snapshot.active).toBe(true);

    controller.trustCurrentNetwork();
    const afterRemovingCurrent = controller.untrustNetwork('wifi:home');
    expect(afterRemovingCurrent.active).toBe(true);
    expect(controller.isRemoteAccessAllowed()).toBe(true);
  });

  it('warns and clears the current network when detection fails', async () => {
    const detector = mock(async () => ({
      id: 'wifi:home',
      label: 'Home WiFi',
    }));
    const controller = new DiscoveryRuntimeController({
      initialEnabled: true,
      detectCurrentNetwork: detector,
    });
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      await controller.refresh();
      controller.trustCurrentNetwork();

      detector.mockImplementation(async () => {
        throw new Error('wifi scan failed');
      });

      const snapshot = await controller.refresh();

      expect(snapshot.currentNetwork).toBeNull();
      expect(snapshot.active).toBe(false);
      expect(controller.isRemoteAccessAllowed()).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
        }),
        'Failed to detect current network',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('notifies only when the active state changes', async () => {
    const onActiveChange = mock(() => {});
    const detector = mock(async () => ({
      id: 'wifi:home',
      label: 'Home WiFi',
    }));
    const controller = new DiscoveryRuntimeController({
      initialEnabled: true,
      detectCurrentNetwork: detector,
      onActiveChange,
    });

    await controller.refresh();
    await controller.refresh();
    controller.trustCurrentNetwork();
    controller.setEnabled(false);
    controller.setEnabled(false);

    expect(onActiveChange).toHaveBeenCalledTimes(2);
    expect(onActiveChange).toHaveBeenNthCalledWith(
      1,
      true,
      expect.objectContaining({
        enabled: true,
        active: true,
      }),
    );
    expect(onActiveChange).toHaveBeenLastCalledWith(
      false,
      expect.objectContaining({
        enabled: false,
        active: false,
      }),
    );
  });

  it('starts polling only once and clears the interval on stop', () => {
    const setIntervalSpy = spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = spyOn(globalThis, 'clearInterval');
    const controller = new DiscoveryRuntimeController({
      initialEnabled: true,
      detectCurrentNetwork: async () => null,
      pollIntervalMs: 4321,
    });

    try {
      controller.start();
      controller.start();
      controller.stop();
      controller.stop();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 4321);
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });
});
