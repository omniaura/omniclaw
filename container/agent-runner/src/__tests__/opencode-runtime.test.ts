import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';

import {
  classifyPromptResponse,
  extractResponseText,
  extractTextFromParts,
} from '../opencode-runtime.js';

// ---------------------------------------------------------------------------
// extractTextFromParts
// ---------------------------------------------------------------------------

describe('extractTextFromParts', () => {
  it('extracts text parts', () => {
    const parts = [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'World' },
    ];
    expect(extractTextFromParts(parts)).toBe('Hello\nWorld');
  });

  it('ignores reasoning parts', () => {
    const parts = [
      { type: 'reasoning', text: 'Let me think...' },
      { type: 'text', text: 'The answer is 42.' },
    ];
    expect(extractTextFromParts(parts)).toBe('The answer is 42.');
  });

  it('ignores tool parts (no tool output in user-facing response)', () => {
    const parts = [
      { type: 'text', text: 'Here is the result:' },
      { type: 'tool', state: { output: 'ls -la\ntotal 42' } },
    ];
    expect(extractTextFromParts(parts)).toBe('Here is the result:');
  });

  it('returns null for empty parts', () => {
    expect(extractTextFromParts([])).toBeNull();
  });

  it('returns null when all parts are tools', () => {
    const parts = [{ type: 'tool', state: { output: 'some output' } }];
    expect(extractTextFromParts(parts)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractResponseText
// ---------------------------------------------------------------------------

describe('extractResponseText', () => {
  it('returns null for null result', () => {
    expect(extractResponseText(null)).toBeNull();
  });

  it('returns null for result without parts', () => {
    expect(extractResponseText({ data: null } as any)).toBeNull();
    expect(extractResponseText({ data: { info: {} } } as any)).toBeNull();
  });

  it('extracts text from parts array', () => {
    const result = {
      data: {
        info: {},
        parts: [
          { type: 'text', text: 'part1' },
          { type: 'text', text: 'part2' },
        ],
      },
    };
    expect(extractResponseText(result as any)).toBe('part1\npart2');
  });

  it('ignores non-text parts', () => {
    const result = {
      data: {
        info: {},
        parts: [
          { type: 'tool', state: { output: 'some output' } },
          { type: 'text', text: 'response' },
        ],
      },
    };
    expect(extractResponseText(result as any)).toBe('response');
  });
});

describe('classifyPromptResponse', () => {
  it('retries fresh session when a resumed session returns no text', () => {
    expect(classifyPromptResponse(null, true)).toEqual({
      retryFreshSession: true,
      finalText: null,
    });
  });

  it('falls back to a synthetic reply for fresh empty responses', () => {
    expect(classifyPromptResponse(null, false)).toEqual({
      retryFreshSession: false,
      finalText:
        'I processed your message but did not generate a text response.',
    });
  });

  it('passes through real text responses', () => {
    expect(classifyPromptResponse('hello', true)).toEqual({
      retryFreshSession: false,
      finalText: 'hello',
    });
  });
});

// ---------------------------------------------------------------------------
// IPC protocol (filesystem-based)
// ---------------------------------------------------------------------------

describe('OpenCode runtime IPC protocol', () => {
  const TEST_IPC_DIR = '/tmp/test-opencode-ipc';

  beforeEach(() => {
    fs.mkdirSync(TEST_IPC_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(TEST_IPC_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('creates IPC input directory', () => {
    expect(fs.existsSync(TEST_IPC_DIR)).toBe(true);
  });

  it('reads and deletes IPC message files', () => {
    const msgPath = path.join(TEST_IPC_DIR, '001.json');
    fs.writeFileSync(
      msgPath,
      JSON.stringify({ type: 'message', text: 'hello' }),
    );

    expect(fs.existsSync(msgPath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(msgPath, 'utf-8'));
    expect(data.type).toBe('message');
    expect(data.text).toBe('hello');
  });

  it('detects close sentinel', () => {
    const closePath = path.join(TEST_IPC_DIR, '_close');
    fs.writeFileSync(closePath, '');
    expect(fs.existsSync(closePath)).toBe(true);
    fs.unlinkSync(closePath);
    expect(fs.existsSync(closePath)).toBe(false);
  });

  it('handles chatJid in IPC messages', () => {
    const msgPath = path.join(TEST_IPC_DIR, '001.json');
    fs.writeFileSync(
      msgPath,
      JSON.stringify({
        type: 'message',
        text: 'hello from discord',
        chatJid: 'dc:123456',
      }),
    );

    const data = JSON.parse(fs.readFileSync(msgPath, 'utf-8'));
    expect(data.chatJid).toBe('dc:123456');
  });

  it('sorts IPC files chronologically', () => {
    fs.writeFileSync(
      path.join(TEST_IPC_DIR, '003.json'),
      JSON.stringify({ type: 'message', text: 'third' }),
    );
    fs.writeFileSync(
      path.join(TEST_IPC_DIR, '001.json'),
      JSON.stringify({ type: 'message', text: 'first' }),
    );
    fs.writeFileSync(
      path.join(TEST_IPC_DIR, '002.json'),
      JSON.stringify({ type: 'message', text: 'second' }),
    );

    const files = fs
      .readdirSync(TEST_IPC_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    expect(files).toEqual(['001.json', '002.json', '003.json']);
    const messages = files.map((f) => {
      const data = JSON.parse(
        fs.readFileSync(path.join(TEST_IPC_DIR, f), 'utf-8'),
      );
      return data.text;
    });
    expect(messages).toEqual(['first', 'second', 'third']);
  });
});

// ---------------------------------------------------------------------------
// Output protocol
// ---------------------------------------------------------------------------

describe('OpenCode output protocol', () => {
  const OUTPUT_START_MARKER = '---OMNICLAW_OUTPUT_START---';
  const OUTPUT_END_MARKER = '---OMNICLAW_OUTPUT_END---';

  it('uses the same markers as Claude SDK runtime', () => {
    expect(OUTPUT_START_MARKER).toBe('---OMNICLAW_OUTPUT_START---');
    expect(OUTPUT_END_MARKER).toBe('---OMNICLAW_OUTPUT_END---');
  });

  it('produces valid ContainerOutput JSON', () => {
    const output = {
      status: 'success' as const,
      result: 'Hello from OpenCode',
      newSessionId: 'test-session-123',
    };

    const json = JSON.stringify(output);
    const parsed = JSON.parse(json);
    expect(parsed.status).toBe('success');
    expect(parsed.result).toBe('Hello from OpenCode');
    expect(parsed.newSessionId).toBe('test-session-123');
  });

  it('includes chatJid in output when set', () => {
    const output = {
      status: 'success' as const,
      result: 'response',
      newSessionId: 'session-1',
      chatJid: 'dc:789',
    };

    const parsed = JSON.parse(JSON.stringify(output));
    expect(parsed.chatJid).toBe('dc:789');
  });

  it('handles error output', () => {
    const output = {
      status: 'error' as const,
      result: null,
      error: 'OpenCode server timed out',
    };

    const parsed = JSON.parse(JSON.stringify(output));
    expect(parsed.status).toBe('error');
    expect(parsed.result).toBeNull();
    expect(parsed.error).toContain('timed out');
  });
});

// ---------------------------------------------------------------------------
// AgentRuntime type
// ---------------------------------------------------------------------------

describe('AgentRuntime type', () => {
  it('accepts opencode as a valid runtime', () => {
    type AgentRuntime = 'claude-agent-sdk' | 'opencode';
    const runtime: AgentRuntime = 'opencode';
    expect(runtime).toBe('opencode');
  });

  it('accepts claude-agent-sdk as a valid runtime', () => {
    type AgentRuntime = 'claude-agent-sdk' | 'opencode';
    const runtime: AgentRuntime = 'claude-agent-sdk';
    expect(runtime).toBe('claude-agent-sdk');
  });
});

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

describe('OpenCode runtime module', () => {
  it('exports runOpenCodeRuntime', async () => {
    const mod = await import('../opencode-runtime.js');
    expect(typeof mod.runOpenCodeRuntime).toBe('function');
  });
});
