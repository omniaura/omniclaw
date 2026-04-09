import { afterEach, describe, expect, it, mock } from 'bun:test';

import { getBackend } from './index.js';
import { LocalBackend } from './local-backend.js';

afterEach(() => {
  mock.restore();
});

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

  describe('module-level orchestration', () => {
    it('resolveBackend uses the entity backend type', async () => {
      class FakeLocalBackend {
        name = 'fake';
        initialize = mock(async () => {});
        shutdown = mock(async () => {});
        runAgent = mock(async () => ({ type: 'done' }));
        sendMessage = mock(() => true);
        closeStdin = mock(() => {});
        writeIpcData = mock(() => {});
        readFile = mock(async () => null);
        writeFile = mock(async () => {});
      }

      mock.module('./local-backend.js', () => ({
        LocalBackend: FakeLocalBackend,
      }));

      const backendModule = await import(
        `./index.ts?test=${Math.random().toString(36).slice(2)}`,
      );

      const backend = backendModule.resolveBackend({
        id: 'agent-1',
        jid: 'dc:1',
        name: 'Agent',
        trigger: '@Agent',
        folder: 'agent',
        isAdmin: false,
        backend: 'docker',
        agentRuntime: 'claude-agent-sdk',
      });

      expect(backend).toBeInstanceOf(FakeLocalBackend);
    });

    it('initializeBackends initializes only the default backend when no entities are provided', async () => {
      const initializeCalls: string[] = [];
      const loggerInfo = mock(() => {});

      class FakeLocalBackend {
        name = 'fake';
        initialize = mock(async () => {
          initializeCalls.push('initialize');
        });
        shutdown = mock(async () => {});
        runAgent = mock(async () => ({ type: 'done' }));
        sendMessage = mock(() => true);
        closeStdin = mock(() => {});
        writeIpcData = mock(() => {});
        readFile = mock(async () => null);
        writeFile = mock(async () => {});
      }

      mock.module('./local-backend.js', () => ({
        LocalBackend: FakeLocalBackend,
      }));
      mock.module('../logger.js', () => ({
        logger: { info: loggerInfo, warn: mock(() => {}) },
      }));

      const backendModule = await import(
        `./index.ts?test=${Math.random().toString(36).slice(2)}`,
      );

      await backendModule.initializeBackends({});

      expect(initializeCalls).toEqual(['initialize']);
      expect(loggerInfo).toHaveBeenCalledWith(
        { backends: ['apple-container'] },
        'Initializing backends',
      );
    });

    it('initializeBackends deduplicates repeated backend types', async () => {
      const initializeCalls: string[] = [];

      class FakeLocalBackend {
        static nextName = 'apple-container';

        name = FakeLocalBackend.nextName;
        initialize = mock(async () => {
          initializeCalls.push(this.name);
        });
        shutdown = mock(async () => {});
        runAgent = mock(async () => ({ type: 'done' }));
        sendMessage = mock(() => true);
        closeStdin = mock(() => {});
        writeIpcData = mock(() => {});
        readFile = mock(async () => null);
        writeFile = mock(async () => {});

        constructor() {
          FakeLocalBackend.nextName = 'docker';
        }
      }

      mock.module('./local-backend.js', () => ({
        LocalBackend: FakeLocalBackend,
      }));
      mock.module('../logger.js', () => ({
        logger: { info: mock(() => {}), warn: mock(() => {}) },
      }));

      const backendModule = await import(
        `./index.ts?test=${Math.random().toString(36).slice(2)}`,
      );

      await backendModule.initializeBackends({
        a: {
          id: 'agent-a',
          jid: 'dc:a',
          name: 'A',
          trigger: '@A',
          folder: 'a',
          isAdmin: false,
          backend: 'docker',
          agentRuntime: 'claude-agent-sdk',
        },
        b: {
          id: 'agent-b',
          jid: 'dc:b',
          name: 'B',
          trigger: '@B',
          folder: 'b',
          isAdmin: false,
          backend: 'docker',
          agentRuntime: 'claude-agent-sdk',
        },
        c: {
          jid: 'main@g.us',
          name: 'Main',
          folder: 'main',
          trigger: '@Main',
          backend: 'apple-container',
        },
      });

      expect(initializeCalls).toHaveLength(2);
      expect(new Set(initializeCalls)).toEqual(
        new Set(['docker', 'apple-container']),
      );
    });

    it('shutdownBackends warns and continues when a backend shutdown fails', async () => {
      const shutdownCalls: string[] = [];
      const loggerWarn = mock(() => {});

      class FakeLocalBackend {
        static nextName = 'apple-container';

        name = FakeLocalBackend.nextName;
        initialize = mock(async () => {});
        shutdown = mock(async () => {
          shutdownCalls.push(this.name);
          if (this.name === 'docker') {
            throw new Error('docker stop failed');
          }
        });
        runAgent = mock(async () => ({ type: 'done' }));
        sendMessage = mock(() => true);
        closeStdin = mock(() => {});
        writeIpcData = mock(() => {});
        readFile = mock(async () => null);
        writeFile = mock(async () => {});

        constructor() {
          FakeLocalBackend.nextName = 'docker';
        }
      }

      mock.module('./local-backend.js', () => ({
        LocalBackend: FakeLocalBackend,
      }));
      mock.module('../logger.js', () => ({
        logger: { info: mock(() => {}), warn: loggerWarn },
      }));

      const backendModule = await import(
        `./index.ts?test=${Math.random().toString(36).slice(2)}`,
      );

      await backendModule.initializeBackends({
        a: {
          jid: 'main@g.us',
          name: 'Main',
          folder: 'main',
          trigger: '@Main',
          backend: 'apple-container',
        },
        b: {
          id: 'agent-b',
          jid: 'dc:b',
          name: 'B',
          trigger: '@B',
          folder: 'b',
          isAdmin: false,
          backend: 'docker',
          agentRuntime: 'claude-agent-sdk',
        },
      });

      await backendModule.shutdownBackends();

      expect(shutdownCalls).toEqual(['apple-container', 'docker']);
      expect(loggerWarn).toHaveBeenCalledWith(
        {
          backend: 'docker',
          error: expect.any(Error),
        },
        'Error shutting down backend',
      );
    });
  });
});
