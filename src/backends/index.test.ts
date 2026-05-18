import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { LOCAL_RUNTIME } from '../config.js';
import { logger } from '../logger.js';
import { getBackend, initializeBackends, shutdownBackends } from './index.js';
import { LocalBackend } from './local-backend.js';

/**
 * Tests for backends/index.ts — the backend factory.
 *
 * Note: resolveBackend is intentionally not tested here because
 * file-transfer.test.ts uses mock.module to replace backends/index.js globally.
 * resolveBackend is a thin wrapper over getBackendType + getBackend.
 */

describe('backends/index', () => {
  afterEach(() => {
    mock.restore();
  });

  describe('getBackend', () => {
    it('returns a LocalBackend for apple-container', () => {
      const backend = getBackend('apple-container');
      expect(backend).toBeInstanceOf(LocalBackend);
    });

    it('returns a LocalBackend for docker', () => {
      const backend = getBackend('docker');
      expect(backend).toBeInstanceOf(LocalBackend);
    });

    it('delegates cursor-sdk to the active container backend singleton', () => {
      const cursor = getBackend('cursor-sdk');
      const container = getBackend(
        LOCAL_RUNTIME === 'docker' ? 'docker' : 'apple-container',
      );
      expect(cursor).toBe(container);
      expect(cursor).toBeInstanceOf(LocalBackend);
    });

    it('returns the same singleton for repeated calls', () => {
      const a = getBackend('apple-container');
      const b = getBackend('apple-container');
      expect(a).toBe(b);
    });

    it('throws for unknown backend type', () => {
      expect(() => getBackend('nonexistent' as any)).toThrow(
        'Unknown backend type',
      );
    });

    it('backend has a valid name property', () => {
      const backend = getBackend('apple-container');
      expect(['docker', 'apple-container']).toContain(backend.name);
    });

    it('backend implements AgentBackend interface', () => {
      const backend = getBackend('apple-container');
      expect(typeof backend.runAgent).toBe('function');
      expect(typeof backend.sendMessage).toBe('function');
      expect(typeof backend.closeStdin).toBe('function');
      expect(typeof backend.writeIpcData).toBe('function');
      expect(typeof backend.readFile).toBe('function');
      expect(typeof backend.writeFile).toBe('function');
      expect(typeof backend.initialize).toBe('function');
      expect(typeof backend.shutdown).toBe('function');
    });
  });

  describe('initializeBackends', () => {
    it('initializes only the default backend when no entities are provided', async () => {
      const appleBackend = getBackend('apple-container');
      const dockerBackend = getBackend('docker');
      const appleInitSpy = spyOn(
        appleBackend,
        'initialize',
      ).mockResolvedValue();
      const dockerInitSpy = spyOn(
        dockerBackend,
        'initialize',
      ).mockResolvedValue();

      await initializeBackends({});

      expect(appleInitSpy).toHaveBeenCalledTimes(1);
      expect(dockerInitSpy).not.toHaveBeenCalled();
    });

    it('deduplicates backend initialization across entities', async () => {
      const appleBackend = getBackend('apple-container');
      const dockerBackend = getBackend('docker');
      const appleInitSpy = spyOn(
        appleBackend,
        'initialize',
      ).mockResolvedValue();
      const dockerInitSpy = spyOn(
        dockerBackend,
        'initialize',
      ).mockResolvedValue();

      await initializeBackends({
        alpha: {
          name: 'Alpha',
          folder: 'alpha',
          trigger: '@Alpha',
          added_at: new Date().toISOString(),
        },
        beta: {
          name: 'Beta',
          folder: 'beta',
          trigger: '@Beta',
          added_at: new Date().toISOString(),
          backend: 'docker',
        },
        gamma: {
          name: 'Gamma',
          folder: 'gamma',
          trigger: '@Gamma',
          added_at: new Date().toISOString(),
          backend: 'docker',
        },
      });

      expect(appleInitSpy).toHaveBeenCalledTimes(1);
      expect(dockerInitSpy).toHaveBeenCalledTimes(1);
    });

    it('maps cursor-sdk entities to the active local runtime backend', async () => {
      const localType =
        LOCAL_RUNTIME === 'docker' ? 'docker' : 'apple-container';
      const localBackend = getBackend(localType);
      const otherBackend = getBackend(
        localType === 'docker' ? 'apple-container' : 'docker',
      );
      const localInitSpy = spyOn(
        localBackend,
        'initialize',
      ).mockResolvedValue();
      const otherInitSpy = spyOn(
        otherBackend,
        'initialize',
      ).mockResolvedValue();

      await initializeBackends({
        cursor: {
          name: 'Cursor Agent',
          folder: 'cursor-agent',
          trigger: '@Cursor',
          added_at: new Date().toISOString(),
          backend: 'cursor-sdk',
        },
      });

      expect(localInitSpy).toHaveBeenCalledTimes(1);
      expect(otherInitSpy).not.toHaveBeenCalled();
    });
  });

  describe('shutdownBackends', () => {
    it('attempts to shut down all initialized backends', async () => {
      const appleBackend = getBackend('apple-container');
      const dockerBackend = getBackend('docker');
      const appleShutdownSpy = spyOn(
        appleBackend,
        'shutdown',
      ).mockResolvedValue();
      const dockerShutdownSpy = spyOn(
        dockerBackend,
        'shutdown',
      ).mockResolvedValue();

      await shutdownBackends();

      expect(appleShutdownSpy).toHaveBeenCalledTimes(1);
      expect(dockerShutdownSpy).toHaveBeenCalledTimes(1);
    });

    it('logs and continues when a backend shutdown fails', async () => {
      const appleBackend = getBackend('apple-container');
      const dockerBackend = getBackend('docker');
      const failure = new Error('shutdown failed');
      const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});

      spyOn(appleBackend, 'shutdown').mockRejectedValue(failure);
      const dockerShutdownSpy = spyOn(
        dockerBackend,
        'shutdown',
      ).mockResolvedValue();

      await shutdownBackends();

      expect(warnSpy).toHaveBeenCalledWith(
        { backend: 'apple-container', error: failure },
        'Error shutting down backend',
      );
      expect(dockerShutdownSpy).toHaveBeenCalledTimes(1);
    });
  });
});
