import { afterEach, describe, expect, it } from 'bun:test';

import {
  buildCodexAppServerArgs,
  buildCodexEnv,
  buildCodexThreadResumeParams,
  buildCodexThreadStartParams,
  buildCodexTurnStartParams,
  extractAssistantTextFromItem,
  extractTextFromCodexContent,
  isRecoverableThreadResumeError,
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

describe('buildCodexEnv', () => {
  it('mirrors either API key env var so both auth names work', () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.CODEX_MODEL = 'gpt-5.4';
    delete process.env.CODEX_API_KEY;

    const env = buildCodexEnv({} as any);

    expect(env.OPENAI_API_KEY).toBe('openai-key');
    expect(env.CODEX_API_KEY).toBe('openai-key');
    expect(env.CODEX_MODEL).toBe('gpt-5.4');
    expect(env.CODEX_HOME).toBe('/home/bun/.codex');
  });

  it('preserves github auth for Codex shell commands', () => {
    process.env.GITHUB_TOKEN = 'gh-token';

    const env = buildCodexEnv({} as any);

    expect(env.GITHUB_TOKEN).toBe('gh-token');
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

describe('buildCodexAppServerArgs', () => {
  it('bypasses Codex native sandboxing when already inside a container sandbox', () => {
    expect(buildCodexAppServerArgs()).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      'app-server',
    ]);
  });
});

describe('buildCodexThreadStartParams', () => {
  it('uses workspace-write with never approval and developer instructions', () => {
    expect(
      buildCodexThreadStartParams({
        cwd: '/workspace/group',
        model: 'gpt-5.4',
        developerInstructions: 'system rules',
      }),
    ).toEqual({
      model: 'gpt-5.4',
      cwd: '/workspace/group',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      experimentalRawEvents: false,
      developerInstructions: 'system rules',
    });
  });
});

describe('buildCodexThreadResumeParams', () => {
  it('builds explicit thread resume params', () => {
    expect(
      buildCodexThreadResumeParams({
        threadId: 'thread_123',
        cwd: '/workspace/group',
        model: 'gpt-5.4',
      }),
    ).toEqual({
      threadId: 'thread_123',
      model: 'gpt-5.4',
      cwd: '/workspace/group',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
    });
  });
});

describe('buildCodexTurnStartParams', () => {
  it('wraps prompt text in app-server turn input format and marks the container as the external sandbox', () => {
    expect(
      buildCodexTurnStartParams({
        threadId: 'thread_123',
        prompt: 'hello',
        model: 'gpt-5.4',
        networkMode: 'full',
      }),
    ).toEqual({
      threadId: 'thread_123',
      model: 'gpt-5.4',
      input: [
        {
          type: 'text',
          text: 'hello',
          text_elements: [],
        },
      ],
      approvalPolicy: 'never',
      sandboxPolicy: {
        type: 'externalSandbox',
        networkAccess: 'enabled',
      },
    });
  });

  it('marks no-network containers as restricted external sandboxes', () => {
    expect(
      buildCodexTurnStartParams({
        threadId: 'thread_123',
        prompt: 'hello',
        networkMode: 'none',
      }),
    ).toEqual({
      threadId: 'thread_123',
      input: [
        {
          type: 'text',
          text: 'hello',
          text_elements: [],
        },
      ],
      approvalPolicy: 'never',
      sandboxPolicy: {
        type: 'externalSandbox',
        networkAccess: 'restricted',
      },
    });
  });
});

describe('extractTextFromCodexContent', () => {
  it('extracts output_text arrays', () => {
    expect(
      extractTextFromCodexContent([
        { type: 'output_text', text: 'line 1' },
        { type: 'output_text', text: 'line 2' },
      ]),
    ).toBe('line 1\nline 2');
  });

  it('returns null for unsupported content values', () => {
    expect(extractTextFromCodexContent({})).toBeNull();
  });
});

describe('extractAssistantTextFromItem', () => {
  it('extracts assistant text from completed assistant items', () => {
    expect(
      extractAssistantTextFromItem({
        type: 'assistant_message',
        text: 'final answer',
      }),
    ).toBe('final answer');
  });

  it('extracts content arrays from agent_message items', () => {
    expect(
      extractAssistantTextFromItem({
        type: 'agent_message',
        content: [{ type: 'output_text', text: 'from content' }],
      }),
    ).toBe('from content');
  });

  it('ignores non-assistant items', () => {
    expect(
      extractAssistantTextFromItem({
        type: 'command_execution',
        text: 'ls -la',
      }),
    ).toBeNull();
  });
});

describe('isRecoverableThreadResumeError', () => {
  it('accepts missing-thread resume failures', () => {
    expect(
      isRecoverableThreadResumeError(
        new Error('thread/resume failed: unknown thread'),
      ),
    ).toBe(true);
  });

  it('rejects unrelated failures', () => {
    expect(
      isRecoverableThreadResumeError(
        new Error('turn/start failed: unauthorized'),
      ),
    ).toBe(false);
  });
});
