import { describe, it, expect } from 'bun:test';
import { getBackend } from './index.js';
import { LocalBackend } from './local-backend.js';

/**
 * Tests for backends/index.ts — the backend factory.
 *
 * Note: resolveBackend is not tested here because file-transfer.test.ts
 * uses mock.module to replace backends/index.js globally. resolveBackend
 * is a thin wrapper over getBackendType + getBackend, both tested separately.
 */

describe('backends/index', () => {
  describe('getBackend', () => {
    it('returns a LocalBackend for apple-container', () => {
      const backend = getBackend('apple-container');
      expect(backend).toBeInstanceOf(LocalBackend);
    });

    it('returns a LocalBackend for docker', () => {
      const backend = getBackend('docker');
      expect(backend).toBeInstanceOf(LocalBackend);
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
});
