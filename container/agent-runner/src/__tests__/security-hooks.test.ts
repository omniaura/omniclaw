import { describe, it, expect } from 'bun:test';
import { createSanitizeBashHook, createSanitizeReadHook } from '../index.ts';

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
});
