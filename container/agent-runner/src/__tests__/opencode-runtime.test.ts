import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';

import {
  extractResponseText,
  extractTextFromParts,
  collectCandidateStrings,
  extractTextFromMessage,
  extractLatestAssistantFromMessages,
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

  it('extracts reasoning parts', () => {
    const parts = [
      { type: 'reasoning', text: 'Let me think...' },
      { type: 'text', text: 'The answer is 42.' },
    ];
    expect(extractTextFromParts(parts)).toBe(
      'Let me think...\nThe answer is 42.',
    );
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

  it('skips parts with non-string text', () => {
    const parts = [
      { type: 'text', text: 123 },
      { type: 'text', text: 'valid' },
    ];
    expect(extractTextFromParts(parts)).toBe('valid');
  });

  it('handles null/undefined elements gracefully', () => {
    const parts = [null, undefined, { type: 'text', text: 'ok' }];
    expect(extractTextFromParts(parts as any)).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// collectCandidateStrings
// ---------------------------------------------------------------------------

describe('collectCandidateStrings', () => {
  it('collects top-level string', () => {
    expect(collectCandidateStrings('hello')).toEqual(['hello']);
  });

  it('collects strings from arrays', () => {
    expect(collectCandidateStrings(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('prefers known keys in objects', () => {
    const obj = { text: 'preferred', other: 'also here' };
    const result = collectCandidateStrings(obj);
    expect(result[0]).toBe('preferred');
    expect(result).toContain('also here');
  });

  it('returns empty for null/undefined', () => {
    expect(collectCandidateStrings(null)).toEqual([]);
    expect(collectCandidateStrings(undefined)).toEqual([]);
  });

  it('respects max depth', () => {
    // Build a deeply nested structure
    let obj: any = { text: 'deep' };
    for (let i = 0; i < 10; i++) obj = { nested: obj };
    // Should stop at depth 5, so the deep text won't be found
    const result = collectCandidateStrings(obj);
    expect(result).not.toContain('deep');
  });

  it('skips empty/whitespace strings', () => {
    expect(collectCandidateStrings(['', '  ', 'valid'])).toEqual(['valid']);
  });
});

// ---------------------------------------------------------------------------
// extractTextFromMessage
// ---------------------------------------------------------------------------

describe('extractTextFromMessage', () => {
  it('returns null for null input', () => {
    expect(extractTextFromMessage(null)).toBeNull();
  });

  it('extracts string content directly', () => {
    expect(extractTextFromMessage({ content: 'hello' })).toBe('hello');
  });

  it('extracts from array content (parts format)', () => {
    const msg = {
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    };
    expect(extractTextFromMessage(msg)).toBe('first\nsecond');
  });

  it('extracts from parts array (OpenCode format)', () => {
    const msg = {
      parts: [{ type: 'text', text: 'from parts' }],
    };
    expect(extractTextFromMessage(msg)).toBe('from parts');
  });

  it('returns null for message with no recognizable content', () => {
    expect(extractTextFromMessage({ foo: 'bar' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractLatestAssistantFromMessages
// ---------------------------------------------------------------------------

describe('extractLatestAssistantFromMessages', () => {
  it('returns the last assistant message', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'first response' },
      { role: 'user', content: 'thanks' },
      { role: 'assistant', content: 'second response' },
    ];
    expect(extractLatestAssistantFromMessages(messages)).toBe(
      'second response',
    );
  });

  it('returns null for empty messages', () => {
    expect(extractLatestAssistantFromMessages([])).toBeNull();
  });

  it('returns null when no assistant messages', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    expect(extractLatestAssistantFromMessages(messages)).toBeNull();
  });

  it('handles OpenCode info/parts format', () => {
    const messages = [
      {
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: 'opencode response' }],
      },
    ];
    expect(extractLatestAssistantFromMessages(messages)).toBe(
      'opencode response',
    );
  });

  it('handles type: assistant format', () => {
    const messages = [{ type: 'assistant', content: 'typed response' }];
    expect(extractLatestAssistantFromMessages(messages)).toBe('typed response');
  });
});

// ---------------------------------------------------------------------------
// extractResponseText
// ---------------------------------------------------------------------------

describe('extractResponseText', () => {
  it('returns null for null result', () => {
    expect(extractResponseText(null)).toBeNull();
  });

  it('returns null for result without data', () => {
    expect(extractResponseText({})).toBeNull();
    expect(extractResponseText({ data: null })).toBeNull();
  });

  it('extracts from data.text', () => {
    expect(extractResponseText({ data: { text: 'hello' } })).toBe('hello');
  });

  it('extracts from data.content', () => {
    expect(extractResponseText({ data: { content: 'hello' } })).toBe('hello');
  });

  it('extracts structured output', () => {
    const result = {
      data: {
        info: { structured_output: { key: 'value' } },
      },
    };
    expect(extractResponseText(result)).toBe('{"key":"value"}');
  });

  it('extracts from parts array', () => {
    const result = {
      data: {
        parts: [
          { type: 'text', text: 'part1' },
          { type: 'text', text: 'part2' },
        ],
      },
    };
    expect(extractResponseText(result)).toBe('part1\npart2');
  });

  it('extracts from messages array (last assistant)', () => {
    const result = {
      data: {
        messages: [
          { role: 'user', content: 'question' },
          { role: 'assistant', content: 'answer' },
        ],
      },
    };
    expect(extractResponseText(result)).toBe('answer');
  });

  it('extracts from messages with array content', () => {
    const result = {
      data: {
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'structured answer' }],
          },
        ],
      },
    };
    expect(extractResponseText(result)).toBe('structured answer');
  });

  it('extracts from info + parts (SDK v1.2.x format)', () => {
    const result = {
      data: {
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: 'sdk response' }],
      },
    };
    expect(extractResponseText(result)).toBe('sdk response');
  });

  it('falls back to deep candidate collection for non-text parts', () => {
    const result = {
      data: {
        info: { role: 'assistant' },
        parts: [{ type: 'custom', content: 'deep text' }],
      },
    };
    // collectCandidateStrings picks up all string values from object fields,
    // including 'content' (preferred key) and 'type' (general walk).
    expect(extractResponseText(result)).toBe('deep text\ncustom');
  });

  it('excludes tool parts from deep candidate fallback', () => {
    const result = {
      data: {
        info: { role: 'assistant' },
        parts: [
          { type: 'tool', state: { output: 'SECRET_API_KEY=sk-xxx' } },
          { type: 'tool-invocation', content: 'ls -la /etc/passwd' },
          { type: 'custom', content: 'safe text' },
        ],
      },
    };
    const text = extractResponseText(result);
    expect(text).not.toContain('SECRET_API_KEY');
    expect(text).not.toContain('/etc/passwd');
    expect(text).toContain('safe text');
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
