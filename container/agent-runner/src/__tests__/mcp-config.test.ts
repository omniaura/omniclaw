import { describe, expect, it } from 'bun:test';

import {
  buildAllowedTools,
  isPathAllowedForSharedVmAgent,
  normalizeExternalMcpServers,
  resolveCurrentChatFile,
  validateExternalMcpCommand,
} from '../index.ts';

describe('external MCP config security', () => {
  it('adds allowed tool patterns for external MCP servers', () => {
    const normalized = normalizeExternalMcpServers({
      gmail: { type: 'http', url: 'https://example.com/mcp' },
      calendar: { command: 'bun', args: ['calendar-mcp.ts'] },
    });

    expect(buildAllowedTools(normalized)).toEqual(
      expect.arrayContaining([
        'mcp__omniclaw__*',
        'mcp__gmail__*',
        'mcp__calendar__*',
      ]),
    );
  });

  it('rejects reserved omniclaw MCP server names', () => {
    expect(() =>
      normalizeExternalMcpServers({
        omniclaw: { command: 'bun', args: ['fake.ts'] },
      }),
    ).toThrow(/reserved/i);
  });

  it('rejects invalid MCP server names', () => {
    expect(() =>
      normalizeExternalMcpServers({
        'bad name': { command: 'bun', args: ['fake.ts'] },
      }),
    ).toThrow(/invalid name/i);
  });

  it('rejects stdio command traversal attempts', () => {
    expect(() =>
      validateExternalMcpCommand('gmail', '../bin/server.js'),
    ).toThrow(/path traversal/i);
  });

  it('rejects absolute stdio commands outside mounted workspaces', () => {
    expect(() => validateExternalMcpCommand('gmail', '/etc/passwd')).toThrow(
      /mounted workspace paths/i,
    );
  });

  it('normalizes relative stdio commands into workspace paths', () => {
    expect(validateExternalMcpCommand('gmail', './tools/gmail-server.ts')).toBe(
      '/workspace/group/tools/gmail-server.ts',
    );
  });

  it('accepts bare executable names for stdio MCP servers', () => {
    expect(validateExternalMcpCommand('gmail', 'npx')).toBe('npx');
  });

  it('uses a process-scoped current chat file by default', () => {
    expect(resolveCurrentChatFile()).toBe(
      `/tmp/current_chat_jid-${process.pid}`,
    );
  });

  it('does not allow shared-VM agents to target sibling group folders', () => {
    expect(isPathAllowedForSharedVmAgent('/workspace/group/CLAUDE.md')).toBe(
      true,
    );
    expect(
      isPathAllowedForSharedVmAgent('/workspace/groups/other/CLAUDE.md'),
    ).toBe(false);
  });

  it('rejects non-http MCP URLs', () => {
    expect(() =>
      normalizeExternalMcpServers({
        gmail: { type: 'http', url: 'file:///tmp/socket' },
      }),
    ).toThrow(/http or https/i);
  });
});
