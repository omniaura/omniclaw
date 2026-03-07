import { afterEach, describe, expect, it } from 'bun:test';

import {
  buildCodexArgs,
  buildCodexEnv,
  extractLastJsonEventText,
} from '../codex-runtime.js';

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
}

afterEach(() => {
  resetEnv();
});

describe('buildCodexArgs', () => {
  it('builds fresh exec argv with exec options before prompt', () => {
    expect(
      buildCodexArgs('solve this', {
        resume: false,
        model: 'gpt-5-codex',
        outputPath: '/tmp/out.txt',
      }),
    ).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'never',
      '--output-last-message',
      '/tmp/out.txt',
      '--json',
      '--model',
      'gpt-5-codex',
      'solve this',
    ]);
  });

  it('builds resume argv with exec options before nested resume subcommand', () => {
    expect(
      buildCodexArgs('follow up', {
        resume: true,
        outputPath: '/tmp/out.txt',
      }),
    ).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'never',
      '--output-last-message',
      '/tmp/out.txt',
      '--json',
      'resume',
      '--last',
      'follow up',
    ]);
  });
});

describe('buildCodexEnv', () => {
  it('mirrors either API key env var so both auth names work', () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.CODEX_MODEL = 'gpt-5.4';
    delete process.env.CODEX_API_KEY;

    const env = buildCodexEnv({} as any);

    expect(env.OPENAI_API_KEY).toBe('openai-key');
    expect(env.CODEX_API_KEY).toBe('openai-key');
    expect(env.CODEX_MODEL).toBe('gpt-5.4');
  });

  it('strips unrelated secrets but preserves Codex auth', () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-secret';
    process.env.CODEX_API_KEY = 'codex-key';
    delete process.env.OPENAI_API_KEY;

    const env = buildCodexEnv({} as any);

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBe('codex-key');
    expect(env.OPENAI_API_KEY).toBe('codex-key');
  });
});

describe('extractLastJsonEventText', () => {
  it('extracts assistant text from legacy message events', () => {
    const jsonl = [
      '{"type":"thread.started"}',
      '{"type":"message","message":{"role":"assistant","content":"hello"}}',
    ].join('\n');

    expect(extractLastJsonEventText(jsonl)).toBe('hello');
  });

  it('extracts text from item.completed agent_message events', () => {
    const jsonl = [
      '{"type":"thread.started"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"final answer"}}',
    ].join('\n');

    expect(extractLastJsonEventText(jsonl)).toBe('final answer');
  });

  it('extracts text content arrays from agent_message events', () => {
    const jsonl = [
      '{"type":"item.completed","item":{"type":"agent_message","content":[{"type":"output_text","text":"line 1"},{"type":"output_text","text":"line 2"}]}}',
    ].join('\n');

    expect(extractLastJsonEventText(jsonl)).toBe('line 1\nline 2');
  });

  it('ignores error items so transport failures do not become user output', () => {
    const jsonl = [
      '{"type":"item.completed","item":{"type":"error","message":"network failed"}}',
    ].join('\n');

    expect(extractLastJsonEventText(jsonl)).toBeNull();
  });
});
