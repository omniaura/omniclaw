import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

import {
  buildCodexAppServerArgs,
  buildCodexEnv,
  buildCodexThreadResumeParams,
  buildCodexThreadStartParams,
  buildCodexTurnStartParams,
  expandSlashCommandPrompt,
  extractAssistantTextFromItem,
  extractTextFromCodexContent,
  isRecoverableThreadResumeError,
} from '../codex-runtime.js';

const ORIGINAL_ENV = { ...process.env };
const TEST_COMMANDS_DIR = path.join(process.cwd(), '.tmp-codex-slash-commands');
const TEST_COMMAND_FILE = path.join(TEST_COMMANDS_DIR, 'codexslashtest.md');

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
  try {
    fs.rmSync(TEST_COMMANDS_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
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
    delete process.env.GH_TOKEN;

    const env = buildCodexEnv({} as any);

    expect(env.GITHUB_TOKEN).toBe('gh-token');
    expect(env.GH_TOKEN).toBe('gh-token');
  });

  it('normalizes GH_TOKEN into both GitHub auth env names', () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = 'gh-alias-token';

    const env = buildCodexEnv({} as any);

    expect(env.GH_TOKEN).toBe('gh-alias-token');
    expect(env.GITHUB_TOKEN).toBe('gh-alias-token');
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

describe('expandSlashCommandPrompt', () => {
  it('expands Claude-style slash command files before sending to Codex', () => {
    process.env.OMNICLAW_SLASH_COMMAND_ROOTS = TEST_COMMANDS_DIR;
    fs.mkdirSync(TEST_COMMANDS_DIR, { recursive: true });
    fs.writeFileSync(
      TEST_COMMAND_FILE,
      'Run the shared workflow with: $ARGUMENTS\n',
    );

    expect(expandSlashCommandPrompt('/codexslashtest repo cleanup')).toBe(
      'Run the shared workflow with: repo cleanup',
    );
  });

  it('leaves unknown slash commands unchanged for native Codex handling', () => {
    expect(expandSlashCommandPrompt('/__test_codex_missing arg')).toBe(
      '/__test_codex_missing arg',
    );
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
