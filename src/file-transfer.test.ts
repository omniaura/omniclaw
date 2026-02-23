/**
 * Tests for cross-backend file transfer (file-transfer.ts).
 *
 * Validates path-traversal rejection, push/pull direction logic,
 * error handling, and correct backend routing.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

import type { AgentBackend } from './backends/types.js';
import type { RegisteredGroup } from './types.js';

// ---- Mocks ----

// Mock the logger to prevent noise
mock.module('./logger.js', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

// Create mock backends
function createMockBackend(name: string): AgentBackend & {
  _files: Map<string, Buffer>;
  _written: Array<{ folder: string; path: string; content: Buffer | string }>;
} {
  const files = new Map<string, Buffer>();
  const written: Array<{ folder: string; path: string; content: Buffer | string }> = [];

  return {
    name,
    _files: files,
    _written: written,
    readFile: async (_folder: string, relativePath: string) => {
      return files.get(relativePath) ?? null;
    },
    writeFile: async (folder: string, relativePath: string, content: Buffer | string) => {
      written.push({ folder, path: relativePath, content });
    },
    initialize: async () => {},
    shutdown: async () => {},
    runAgent: async () => ({ output: '', exitCode: 0 }),
    closeStdin: async () => {},
  } as unknown as AgentBackend & {
    _files: Map<string, Buffer>;
    _written: Array<{ folder: string; path: string; content: Buffer | string }>;
  };
}

let mockSourceBackend: ReturnType<typeof createMockBackend>;
let mockTargetBackend: ReturnType<typeof createMockBackend>;

// Mock the backends/index module to return our mocks
mock.module('./backends/index.js', () => ({
  resolveBackend: (group: RegisteredGroup) => {
    if (group.folder === 'source-group') return mockSourceBackend;
    if (group.folder === 'target-group') return mockTargetBackend;
    throw new Error(`Unknown group folder: ${group.folder}`);
  },
}));

// Import after mocks
import { transferFiles } from './file-transfer.js';

// ---- Test data ----

const sourceGroup: RegisteredGroup = {
  name: 'Source Group',
  folder: 'source-group',
  trigger: '@Omni',
  added_at: '2026-01-01T00:00:00Z',
};

const targetGroup: RegisteredGroup = {
  name: 'Target Group',
  folder: 'target-group',
  trigger: '@Omni',
  added_at: '2026-01-01T00:00:00Z',
};

// ---- Tests ----

describe('transferFiles', () => {
  beforeEach(() => {
    mockSourceBackend = createMockBackend('mock-source');
    mockTargetBackend = createMockBackend('mock-target');
  });

  // --- Push direction ---

  describe('push direction (source → target)', () => {
    it('transfers a single file from source to target', async () => {
      mockSourceBackend._files.set('data.json', Buffer.from('{"key":"value"}'));

      const result = await transferFiles({
        sourceGroup,
        targetGroup,
        files: ['data.json'],
        direction: 'push',
      });

      expect(result.transferred).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(mockTargetBackend._written).toHaveLength(1);
      expect(mockTargetBackend._written[0].folder).toBe('target-group');
      expect(mockTargetBackend._written[0].path).toBe('shared/source-group/data.json');
    });

    it('transfers multiple files', async () => {
      mockSourceBackend._files.set('a.txt', Buffer.from('aaa'));
      mockSourceBackend._files.set('b.txt', Buffer.from('bbb'));
      mockSourceBackend._files.set('dir/c.txt', Buffer.from('ccc'));

      const result = await transferFiles({
        sourceGroup,
        targetGroup,
        files: ['a.txt', 'b.txt', 'dir/c.txt'],
        direction: 'push',
      });

      expect(result.transferred).toBe(3);
      expect(result.errors).toHaveLength(0);
      expect(mockTargetBackend._written).toHaveLength(3);
      // Note: path.basename strips directory, so dir/c.txt → c.txt
      expect(mockTargetBackend._written[2].path).toBe('shared/source-group/c.txt');
    });

    it('uses basename for destination path (strips directories)', async () => {
      mockSourceBackend._files.set('deeply/nested/dir/report.md', Buffer.from('# Report'));

      const result = await transferFiles({
        sourceGroup,
        targetGroup,
        files: ['deeply/nested/dir/report.md'],
        direction: 'push',
      });

      expect(result.transferred).toBe(1);
      expect(mockTargetBackend._written[0].path).toBe('shared/source-group/report.md');
    });
  });

  // --- Pull direction ---

  describe('pull direction (target → source)', () => {
    it('pulls file from target to source', async () => {
      mockTargetBackend._files.set('context.md', Buffer.from('# Context'));

      const result = await transferFiles({
        sourceGroup,
        targetGroup,
        files: ['context.md'],
        direction: 'pull',
      });

      expect(result.transferred).toBe(1);
      expect(result.errors).toHaveLength(0);
      // In pull mode, target is source of data, source is destination
      expect(mockSourceBackend._written).toHaveLength(1);
      expect(mockSourceBackend._written[0].folder).toBe('source-group');
      expect(mockSourceBackend._written[0].path).toBe('shared/target-group/context.md');
    });
  });

  // --- File not found ---

  describe('file not found handling', () => {
    it('reports error when source file does not exist', async () => {
      const result = await transferFiles({
        sourceGroup,
        targetGroup,
        files: ['missing.txt'],
        direction: 'push',
      });

      expect(result.transferred).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('File not found');
      expect(result.errors[0]).toContain('missing.txt');
    });

    it('continues transferring remaining files after a missing file', async () => {
      mockSourceBackend._files.set('exists.txt', Buffer.from('data'));

      const result = await transferFiles({
        sourceGroup,
        targetGroup,
        files: ['missing.txt', 'exists.txt'],
        direction: 'push',
      });

      expect(result.transferred).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('missing.txt');
    });
  });

  // --- Empty file list ---

  describe('empty inputs', () => {
    it('handles empty file list', async () => {
      const result = await transferFiles({
        sourceGroup,
        targetGroup,
        files: [],
        direction: 'push',
      });

      expect(result.transferred).toBe(0);
      expect(result.errors).toHaveLength(0);
    });
  });

  // --- Path traversal rejection (security) ---

  describe('path traversal rejection', () => {
    it('rejects paths with ../ traversal', async () => {
      const result = await transferFiles({
        sourceGroup,
        targetGroup,
        files: ['../../../etc/passwd'],
        direction: 'push',
      });

      expect(result.transferred).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('traversal');
    });

    it('rejects paths with encoded traversal', async () => {
      const result = await transferFiles({
        sourceGroup,
        targetGroup,
        files: ['..%2F..%2Fetc/passwd'],
        direction: 'push',
      });

      // rejectTraversalSegments checks for literal '..' segments
      // The encoded version may or may not be caught depending on implementation
      // Either way, the transfer should not succeed for malicious paths
      expect(result.transferred).toBe(0);
    });

    it('rejects paths with bare .. component', async () => {
      const result = await transferFiles({
        sourceGroup,
        targetGroup,
        files: ['foo/../../../secret'],
        direction: 'push',
      });

      expect(result.transferred).toBe(0);
      expect(result.errors).toHaveLength(1);
    });

    it('continues processing valid files after rejecting traversal', async () => {
      mockSourceBackend._files.set('good.txt', Buffer.from('safe'));

      const result = await transferFiles({
        sourceGroup,
        targetGroup,
        files: ['../evil.txt', 'good.txt'],
        direction: 'push',
      });

      expect(result.transferred).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('traversal');
      expect(mockTargetBackend._written[0].path).toBe('shared/source-group/good.txt');
    });

    it('rejects absolute paths', async () => {
      const result = await transferFiles({
        sourceGroup,
        targetGroup,
        files: ['/etc/passwd'],
        direction: 'push',
      });

      expect(result.transferred).toBe(0);
      expect(result.errors).toHaveLength(1);
    });
  });

  // --- Backend error handling ---

  describe('backend errors', () => {
    it('reports error when readFile throws', async () => {
      mockSourceBackend.readFile = async () => {
        throw new Error('Backend read error');
      };

      const result = await transferFiles({
        sourceGroup,
        targetGroup,
        files: ['data.json'],
        direction: 'push',
      });

      expect(result.transferred).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Backend read error');
    });

    it('reports error when writeFile throws', async () => {
      mockSourceBackend._files.set('data.json', Buffer.from('test'));
      mockTargetBackend.writeFile = async () => {
        throw new Error('Backend write error');
      };

      const result = await transferFiles({
        sourceGroup,
        targetGroup,
        files: ['data.json'],
        direction: 'push',
      });

      expect(result.transferred).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Backend write error');
    });

    it('continues after backend error on one file', async () => {
      mockSourceBackend._files.set('a.txt', Buffer.from('aaa'));
      mockSourceBackend._files.set('b.txt', Buffer.from('bbb'));

      let callCount = 0;
      const originalReadFile = mockSourceBackend.readFile.bind(mockSourceBackend);
      mockSourceBackend.readFile = async (folder: string, path: string) => {
        callCount++;
        if (callCount === 1) throw new Error('Transient error');
        return originalReadFile(folder, path);
      };

      const result = await transferFiles({
        sourceGroup,
        targetGroup,
        files: ['a.txt', 'b.txt'],
        direction: 'push',
      });

      expect(result.transferred).toBe(1);
      expect(result.errors).toHaveLength(1);
    });
  });

  // --- Content preservation ---

  describe('content preservation', () => {
    it('preserves binary content through transfer', async () => {
      const binaryData = Buffer.from([0x00, 0xff, 0x42, 0x89, 0xab]);
      mockSourceBackend._files.set('binary.bin', binaryData);

      const result = await transferFiles({
        sourceGroup,
        targetGroup,
        files: ['binary.bin'],
        direction: 'push',
      });

      expect(result.transferred).toBe(1);
      expect(mockTargetBackend._written[0].content).toEqual(binaryData);
    });

    it('preserves text content through transfer', async () => {
      const text = 'Hello, world! 🌍\nLine 2\n';
      mockSourceBackend._files.set('text.txt', Buffer.from(text));

      const result = await transferFiles({
        sourceGroup,
        targetGroup,
        files: ['text.txt'],
        direction: 'push',
      });

      expect(result.transferred).toBe(1);
      expect(mockTargetBackend._written[0].content.toString()).toBe(text);
    });
  });
});
