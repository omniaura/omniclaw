import { describe, it, expect } from 'bun:test';
import { createSanitizeBashHook, createSanitizeReadHook, buildContent } from '../index.ts';

describe('Security Hooks - Issue #79', () => {
  describe('Bash Hook', () => {
    it('should block cat /proc/self/environ', async () => {
      const hook = createSanitizeBashHook();
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'cat /proc/self/environ' },
      };
      await expect(hook(input as any, 'id', {} as any)).rejects.toThrow(/proc.*environ.*not allowed/i);
    });

    it('should block grep in /proc/1234/environ', async () => {
      const hook = createSanitizeBashHook();
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'grep ANTHROPIC /proc/1234/environ' },
      };
      await expect(hook(input as any, 'id', {} as any)).rejects.toThrow(/proc.*environ.*not allowed/i);
    });

    it('should block reading /tmp/input.json', async () => {
      const hook = createSanitizeBashHook();
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'cat /tmp/input.json' },
      };
      await expect(hook(input as any, 'id', {} as any)).rejects.toThrow(/restricted file/i);
    });

    it('should block access to /workspace/env-dir/', async () => {
      const hook = createSanitizeBashHook();
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'cat /workspace/env-dir/env' },
      };
      await expect(hook(input as any, 'id', {} as any)).rejects.toThrow(/restricted file/i);
    });

    it('should block cat /workspace/project/.env', async () => {
      const hook = createSanitizeBashHook();
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'cat /workspace/project/.env' },
      };
      await expect(hook(input as any, 'id', {} as any)).rejects.toThrow(/restricted file/i);
    });

    it('should block grep in /workspace/project/.env', async () => {
      const hook = createSanitizeBashHook();
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'grep ANTHROPIC /workspace/project/.env' },
      };
      await expect(hook(input as any, 'id', {} as any)).rejects.toThrow(/restricted file/i);
    });

    it('should block piped access to /workspace/project/.env', async () => {
      const hook = createSanitizeBashHook();
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'cat /workspace/project/.env | head' },
      };
      await expect(hook(input as any, 'id', {} as any)).rejects.toThrow(/restricted file/i);
    });

    it('should block access to /proc/self/mountinfo', async () => {
      const hook = createSanitizeBashHook();
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'cat /proc/self/mountinfo' },
      };
      await expect(hook(input as any, 'id', {} as any)).rejects.toThrow(/restricted file/i);
    });

    it('should block access to /etc/mtab', async () => {
      const hook = createSanitizeBashHook();
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'cat /etc/mtab' },
      };
      await expect(hook(input as any, 'id', {} as any)).rejects.toThrow(/restricted file/i);
    });

    it('should block access to /etc/fstab', async () => {
      const hook = createSanitizeBashHook();
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'cat /etc/fstab' },
      };
      await expect(hook(input as any, 'id', {} as any)).rejects.toThrow(/restricted file/i);
    });

    it('should allow safe commands and prepend unset', async () => {
      const hook = createSanitizeBashHook();
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'ls /workspace/group' },
      };
      const result = await hook(input as any, 'id', {} as any);
      expect(result.hookSpecificOutput?.updatedInput?.command).toContain('unset');
      expect(result.hookSpecificOutput?.updatedInput?.command).toContain('ls /workspace/group');
    });

    it('should return empty object when no command provided', async () => {
      const hook = createSanitizeBashHook();
      const input = {
        tool_name: 'Bash',
        tool_input: {},
      };
      const result = await hook(input as any, 'id', {} as any);
      expect(result).toEqual({});
    });
  });

  describe('Read Hook', () => {
    it('should block /proc/self/environ', async () => {
      const hook = createSanitizeReadHook();
      const input = {
        tool_name: 'Read',
        tool_input: { file_path: '/proc/self/environ' },
      };
      await expect(hook(input as any, 'id', {} as any)).rejects.toThrow(/not allowed.*security/i);
    });

    it('should block /proc/1234/environ', async () => {
      const hook = createSanitizeReadHook();
      const input = {
        tool_name: 'Read',
        tool_input: { file_path: '/proc/1234/environ' },
      };
      await expect(hook(input as any, 'id', {} as any)).rejects.toThrow(/not allowed.*security/i);
    });

    it('should block /tmp/input.json', async () => {
      const hook = createSanitizeReadHook();
      const input = {
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/input.json' },
      };
      await expect(hook(input as any, 'id', {} as any)).rejects.toThrow(/not allowed.*security/i);
    });

    it('should block /workspace/env-dir/env', async () => {
      const hook = createSanitizeReadHook();
      const input = {
        tool_name: 'Read',
        tool_input: { file_path: '/workspace/env-dir/env' },
      };
      await expect(hook(input as any, 'id', {} as any)).rejects.toThrow(/not allowed.*security/i);
    });

    it('should block /workspace/project/.env', async () => {
      const hook = createSanitizeReadHook();
      const input = {
        tool_name: 'Read',
        tool_input: { file_path: '/workspace/project/.env' },
      };
      await expect(hook(input as any, 'id', {} as any)).rejects.toThrow(/not allowed.*security/i);
    });

    it('should block mount enumeration files', async () => {
      const hook = createSanitizeReadHook();
      const files = [
        '/proc/self/mountinfo',
        '/proc/self/mounts',
        '/etc/mtab',
        '/etc/fstab',
      ];
      for (const file of files) {
        const input = {
          tool_name: 'Read',
          tool_input: { file_path: file },
        };
        await expect(hook(input as any, 'id', {} as any)).rejects.toThrow(/not allowed.*security/i);
      }
    });

    it('should allow safe file reads', async () => {
      const hook = createSanitizeReadHook();
      const input = {
        tool_name: 'Read',
        tool_input: { file_path: '/workspace/group/CLAUDE.md' },
      };
      const result = await hook(input as any, 'id', {} as any);
      expect(result).toEqual({});
    });

    it('should return empty object when no file_path provided', async () => {
      const hook = createSanitizeReadHook();
      const input = {
        tool_name: 'Read',
        tool_input: {},
      };
      const result = await hook(input as any, 'id', {} as any);
      expect(result).toEqual({});
    });

    it('should block path traversal attempts to environ', async () => {
      const hook = createSanitizeReadHook();
      const input = {
        tool_name: 'Read',
        // path.resolve normalizes /proc/1/../../proc/self/environ -> /proc/self/environ
        tool_input: { file_path: '/proc/1/../../proc/self/environ' },
      };
      await expect(hook(input as any, 'id', {} as any)).rejects.toThrow(/not allowed.*security/i);
    });
  });

  describe('buildContent - Image Path Traversal (Issue #40)', () => {
    it('should block path traversal to env-dir via image attachment', () => {
      const result = buildContent('[attachment:image file=../../../../workspace/env-dir/env]');
      // Should NOT attempt to read the file — should return blocked text
      expect(result).toEqual([{ type: 'text', text: '[Image blocked: invalid path]' }]);
    });

    it('should block path traversal to /etc/passwd', () => {
      const result = buildContent('[attachment:image file=../../../etc/passwd]');
      expect(result).toEqual([{ type: 'text', text: '[Image blocked: invalid path]' }]);
    });

    it('should block relative traversal with ../', () => {
      const result = buildContent('[attachment:image file=../secret.txt]');
      expect(result).toEqual([{ type: 'text', text: '[Image blocked: invalid path]' }]);
    });

    it('should block traversal to /proc/self/environ', () => {
      const result = buildContent('[attachment:image file=../../../../proc/self/environ]');
      expect(result).toEqual([{ type: 'text', text: '[Image blocked: invalid path]' }]);
    });

    it('should allow legitimate filenames without traversal', () => {
      // This file won't exist, so it should return "Image unavailable" (not blocked)
      const result = buildContent('[attachment:image file=12345-photo.png]');
      expect(result).toEqual([{ type: 'text', text: '[Image unavailable]' }]);
    });

    it('should return plain text when no image markers present', () => {
      const text = 'Hello, this is a normal message';
      const result = buildContent(text);
      expect(result).toBe(text);
    });

    it('should preserve surrounding text with blocked images', () => {
      const result = buildContent('Before [attachment:image file=../../etc/passwd] After');
      expect(Array.isArray(result)).toBe(true);
      const blocks = result as Array<{ type: string; text?: string }>;
      expect(blocks[0]).toEqual({ type: 'text', text: 'Before ' });
      expect(blocks[1]).toEqual({ type: 'text', text: '[Image blocked: invalid path]' });
      expect(blocks[2]).toEqual({ type: 'text', text: ' After' });
    });
  });
});
