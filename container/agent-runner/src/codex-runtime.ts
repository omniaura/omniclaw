/**
 * Codex CLI Runtime for OmniClaw Agent Runner (container-side)
 *
 * Alternative to the Claude Agent SDK and OpenCode runtimes. Spawns `codex exec`
 * as a non-interactive subprocess per prompt, using the Codex CLI's built-in
 * session resume for conversational continuity.
 *
 * Follows the same IPC protocol (stdin JSON → stdout markers → IPC polling).
 *
 * Codex CLI manages its own tool execution (bash, file ops, etc.) natively.
 * Auth: Supports host-copied Codex login state (~/.codex/auth.json) and
 * OPENAI_API_KEY / CODEX_API_KEY env vars.
 */

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types (duplicated from host — container can't import host source)
// ---------------------------------------------------------------------------

interface ChannelInfo {
  id: string;
  jid: string;
  name: string;
}

type AgentRuntime = 'claude-agent-sdk' | 'opencode' | 'codex';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  resumeAt?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  discordGuildId?: string;
  serverFolder?: string;
  secrets?: Record<string, string>;
  agentRuntime?: AgentRuntime;
  channels?: ChannelInfo[];
  agentName?: string;
  discordBotId?: string;
  agentTrigger?: string;
  agentContextFolder?: string;
  channelFolder?: string;
  categoryFolder?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  resumeAt?: string;
  error?: string;
  intermediate?: boolean;
  chatJid?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OUTPUT_START_MARKER = '---OMNICLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---OMNICLAW_OUTPUT_END---';
const IPC_POLL_MS = 500;

// Session marker: Codex CLI manages sessions via its internal .codex/ dir.
// We use the special value 'codex-cli-last' to indicate "resume --last".
const CODEX_SESSION_MARKER = 'codex-cli-last';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[codex-runtime] ${message}`);
}

/** Resolve IPC input directory based on whether this is a scheduled task. */
function resolveIpcInputDir(isScheduledTask?: boolean): string {
  return isScheduledTask
    ? '/workspace/ipc/input-task'
    : '/workspace/ipc/input';
}

// ---------------------------------------------------------------------------
// IPC helpers (same protocol as Claude SDK and OpenCode runtimes)
// ---------------------------------------------------------------------------

interface IpcMessage {
  text: string;
  chatJid?: string;
}

let ipcInputDir = '/workspace/ipc/input';
let ipcCloseFile = path.join(ipcInputDir, '_close');
let currentChatJid = '';

function setCurrentChat(chatJid: string): void {
  currentChatJid = chatJid;
  try {
    fs.writeFileSync('/tmp/current_chat_jid', chatJid);
  } catch {
    /* ignore */
  }
}

function shouldClose(): boolean {
  if (fs.existsSync(ipcCloseFile)) {
    try {
      fs.unlinkSync(ipcCloseFile);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

function drainIpcInput(): IpcMessage[] {
  try {
    fs.mkdirSync(ipcInputDir, { recursive: true });
    const files = fs
      .readdirSync(ipcInputDir)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: IpcMessage[] = [];
    for (const file of files) {
      const filePath = path.join(ipcInputDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push({ text: data.text, chatJid: data.chatJid });
          if (data.chatJid) setCurrentChat(data.chatJid);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function formatIpcMessages(messages: IpcMessage[]): string {
  return messages.map((m) => m.text).join('\n');
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(formatIpcMessages(messages));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

// ---------------------------------------------------------------------------
// Response extraction from Codex JSONL output
// ---------------------------------------------------------------------------

interface CodexJsonEvent {
  type: string;
  message?: { content?: string; role?: string };
  content?: string;
  item?: {
    type?: string;
    text?: string;
    content?: unknown;
  };
  [key: string]: unknown;
}

function extractTextFromCodexContent(content: unknown): string | null {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }

  const textParts = content
    .map((part) => {
      if (!part || typeof part !== 'object') return null;
      const typedPart = part as { type?: string; text?: string };
      if (
        (typedPart.type === 'output_text' || typedPart.type === 'text') &&
        typeof typedPart.text === 'string'
      ) {
        return typedPart.text;
      }
      return null;
    })
    .filter((part): part is string => Boolean(part));

  return textParts.length > 0 ? textParts.join('\n') : null;
}

/**
 * Extract the final assistant text from Codex JSONL output.
 * Codex --json emits newline-delimited JSON events. We look for the last
 * assistant message or completed event with text content.
 * @internal exported for testing
 */
export function extractLastJsonEventText(jsonlOutput: string): string | null {
  const lines = jsonlOutput.trim().split('\n');
  let lastText: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event: CodexJsonEvent = JSON.parse(trimmed);
      // Check common event shapes:
      // { type: "message", message: { role: "assistant", content: "..." } }
      // { type: "completed", content: "..." }
      if (event.message?.role === 'assistant' && event.message.content) {
        lastText = event.message.content;
      } else if (event.content && typeof event.content === 'string') {
        lastText = event.content;
      } else if (
        event.item?.type &&
        ['message', 'assistant_message', 'agent_message'].includes(
          event.item.type,
        )
      ) {
        if (typeof event.item.text === 'string' && event.item.text.trim()) {
          lastText = event.item.text;
        } else {
          const itemText = extractTextFromCodexContent(event.item.content);
          if (itemText) lastText = itemText;
        }
      }
    } catch {
      // Not JSON — ignore (could be progress text)
    }
  }
  return lastText;
}

// ---------------------------------------------------------------------------
// Codex subprocess management
// ---------------------------------------------------------------------------

/**
 * Build environment for Codex subprocess.
 * Strips secrets that Codex shouldn't leak to bash subprocesses, but preserves
 * the Codex auth env vars when present.
 */
export function buildCodexEnv(
  containerInput: ContainerInput,
): Record<string, string | undefined> {
  const SECRET_PREFIXES = [
    'ANTHROPIC_',
    'CLAUDE_CODE_',
    'DISCORD_BOT_',
    'TELEGRAM_',
    'SLACK_',
    'WHATSAPP_',
    'GITHUB_TOKEN',
  ];

  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!SECRET_PREFIXES.some((p) => k.startsWith(p))) {
      env[k] = v;
    }
  }

  // Inject auth from container secrets if provided
  const secrets = containerInput.secrets || {};
  if (secrets.CODEX_API_KEY) {
    env.CODEX_API_KEY = secrets.CODEX_API_KEY;
  }
  if (secrets.OPENAI_API_KEY) {
    env.OPENAI_API_KEY = secrets.OPENAI_API_KEY;
  }

  const apiKey = env.OPENAI_API_KEY || env.CODEX_API_KEY;
  if (apiKey) {
    if (!env.OPENAI_API_KEY) env.OPENAI_API_KEY = apiKey;
    if (!env.CODEX_API_KEY) env.CODEX_API_KEY = apiKey;
  }

  return env;
}

export function buildCodexArgs(
  prompt: string,
  opts: {
    resume: boolean;
    model?: string;
    outputPath: string;
  },
): string[] {
  const args: string[] = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '--ask-for-approval',
    'never',
    '--output-last-message',
    opts.outputPath,
    '--json',
  ];

  if (opts.model) {
    args.push('--model', opts.model);
  }

  if (opts.resume) {
    args.push('resume', '--last');
  }

  args.push(prompt);
  return args;
}

function hasCodexStoredAuth(codexHome = '/home/bun/.codex'): boolean {
  return fs.existsSync(path.join(codexHome, 'auth.json'));
}

/**
 * Run a single Codex exec invocation.
 * Returns the response text or null on failure.
 */
async function runCodexExec(
  prompt: string,
  opts: {
    resume: boolean;
    env: Record<string, string | undefined>;
    model?: string;
    cwd: string;
    timeoutMs: number;
    outputPath: string;
  },
): Promise<{ text: string | null; timedOut: boolean }> {
  const args = buildCodexArgs(prompt, opts);

  log(`Spawning: codex ${args.slice(0, 5).join(' ')}... (${prompt.length} chars)`);

  const proc = Bun.spawn(['codex', ...args], {
    cwd: opts.cwd,
    env: opts.env as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    log(`Codex exec timed out after ${opts.timeoutMs}ms, killing`);
    proc.kill();
  }, opts.timeoutMs);

  // Stream stderr for progress logging
  const stderrReader = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr as AsyncIterable<Uint8Array>) {
      const text = decoder.decode(chunk);
      for (const line of text.split('\n')) {
        if (line.trim()) log(`[stderr] ${line.trim()}`);
      }
    }
  })();

  // Collect stdout (JSONL events)
  const stdoutChunks: string[] = [];
  const stdoutReader = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
      stdoutChunks.push(decoder.decode(chunk));
    }
  })();

  const exitCode = await proc.exited;
  clearTimeout(timer);
  await Promise.allSettled([stderrReader, stdoutReader]);

  log(`Codex exec exited with code ${exitCode}`);

  if (timedOut) {
    return { text: null, timedOut: true };
  }

  // Try to read the output file first (most reliable)
  let responseText: string | null = null;
  try {
    if (fs.existsSync(opts.outputPath)) {
      responseText = fs.readFileSync(opts.outputPath, 'utf-8').trim();
      if (responseText) {
        log(`Got response from output file (${responseText.length} chars)`);
      }
    }
  } catch (err) {
    log(
      `Failed to read output file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Fallback: parse JSONL stdout
  if (!responseText) {
    const jsonlOutput = stdoutChunks.join('');
    responseText = extractLastJsonEventText(jsonlOutput);
    if (responseText) {
      log(`Got response from JSONL stdout (${responseText.length} chars)`);
    }
  }

  // Clean up output file
  try {
    fs.unlinkSync(opts.outputPath);
  } catch {
    /* ignore */
  }

  return { text: responseText, timedOut: false };
}

// ---------------------------------------------------------------------------
// System context (same as OpenCode runtime)
// ---------------------------------------------------------------------------

function buildSystemContext(containerInput: ContainerInput): string | null {
  const parts: string[] = [];

  const layers = [
    '/workspace/agent/CLAUDE.md',
    '/workspace/server/CLAUDE.md',
    '/workspace/category/CLAUDE.md',
    '/workspace/group/CLAUDE.md',
  ];
  for (const p of layers) {
    if (fs.existsSync(p)) parts.push(fs.readFileSync(p, 'utf-8'));
  }

  if (!containerInput.isMain) {
    const globalClaudeMd = '/workspace/global/CLAUDE.md';
    if (fs.existsSync(globalClaudeMd)) {
      parts.push(fs.readFileSync(globalClaudeMd, 'utf-8'));
    }
  }

  if (
    containerInput.agentName &&
    !fs.existsSync('/workspace/agent/CLAUDE.md')
  ) {
    const identityParts = [`You are **${containerInput.agentName}**.`];
    if (containerInput.agentTrigger) {
      identityParts.push(
        `Your trigger is \`${containerInput.agentTrigger}\`.`,
      );
    }
    if (containerInput.discordBotId) {
      identityParts.push(
        `Your Discord Bot ID is \`${containerInput.discordBotId}\`.`,
      );
    }
    parts.push(`## Your Identity\n${identityParts.join(' ')}`);
  }

  if (parts.length === 0) return null;
  return parts.join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Main runtime entry point
// ---------------------------------------------------------------------------

/**
 * Main entry point for the Codex CLI runtime.
 * Called from the agent-runner's main() when agentRuntime === 'codex'.
 */
export async function runCodexRuntime(
  containerInput: ContainerInput,
): Promise<void> {
  log(`Starting Codex runtime for group: ${containerInput.groupFolder}`);

  // Configure IPC directories
  if (containerInput.isScheduledTask) {
    ipcInputDir = '/workspace/ipc/input-task';
    ipcCloseFile = path.join(ipcInputDir, '_close');
    log('Using task IPC lane: /workspace/ipc/input-task');
  }
  fs.mkdirSync(ipcInputDir, { recursive: true });

  // Clean up stale _close sentinel
  try {
    fs.unlinkSync(ipcCloseFile);
  } catch {
    /* ignore */
  }

  // Initialize current chat JID
  setCurrentChat(containerInput.chatJid);

  // Build env for Codex subprocess
  const codexEnv = buildCodexEnv(containerInput);

  const hasApiKey = Boolean(codexEnv.CODEX_API_KEY || codexEnv.OPENAI_API_KEY);
  const hasStoredAuth = hasCodexStoredAuth();
  if (!hasApiKey && !hasStoredAuth) {
    log(
      'Warning: No Codex auth found — set OPENAI_API_KEY/CODEX_API_KEY or mount /home/bun/.codex/auth.json',
    );
  } else if (!hasApiKey && hasStoredAuth) {
    log('Using saved Codex CLI login from /home/bun/.codex/auth.json');
  }

  // Model override
  const model = (codexEnv.CODEX_MODEL || '').trim() || undefined;
  if (model) {
    log(`Using model: ${model}`);
  }

  // Determine if we're resuming a session
  const isResume =
    containerInput.sessionId === CODEX_SESSION_MARKER &&
    !containerInput.isScheduledTask;

  const cwd = '/workspace/group';
  const outputPath = `/tmp/codex-output-${Date.now()}.txt`;
  const timeoutMs = 1800000; // 30 min

  // Build initial prompt with system context on first run
  let prompt = containerInput.prompt;
  if (!isResume) {
    const systemContext = buildSystemContext(containerInput);
    if (systemContext) {
      prompt = `${systemContext}\n\n---\n\nUser message:\n${prompt}`;
      log('Injected system context into initial prompt');
    }
  }

  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }

  // Drain any pending IPC messages into the initial prompt
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + formatIpcMessages(pending);
  }

  // Query loop: exec prompt → emit result → wait for IPC → repeat
  let useResume = isResume;
  try {
    while (true) {
      // Check for close before running
      if (shouldClose()) {
        log('Close sentinel detected before prompt, exiting');
        break;
      }

      log(
        `Running Codex exec (resume=${useResume}, ${prompt.length} chars)...`,
      );

      const result = await runCodexExec(prompt, {
        resume: useResume,
        env: codexEnv,
        model,
        cwd,
        timeoutMs,
        outputPath,
      });

      if (result.timedOut) {
        writeOutput({
          status: 'error',
          result: null,
          newSessionId: CODEX_SESSION_MARKER,
          error: 'Codex exec timed out',
        });
        break;
      }

      if (!result.text) {
        // If resume failed (no session), retry without resume
        if (useResume) {
          log('Resume failed (no prior session), retrying without resume');
          useResume = false;
          // Re-inject system context since this is now a fresh session
          const systemContext = buildSystemContext(containerInput);
          if (systemContext) {
            prompt = `${systemContext}\n\n---\n\nUser message:\n${containerInput.prompt}`;
          }
          continue;
        }

        writeOutput({
          status: 'error',
          result: null,
          newSessionId: CODEX_SESSION_MARKER,
          error: 'Codex exec produced no response',
        });
        break;
      }

      // Emit response
      const output: ContainerOutput = {
        status: 'success',
        result: result.text,
        newSessionId: CODEX_SESSION_MARKER,
      };
      if (currentChatJid) output.chatJid = currentChatJid;
      writeOutput(output);

      // After first successful prompt, always resume for follow-ups
      useResume = true;

      log('Prompt completed, waiting for next IPC message...');

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(
        `Got new message (${nextMessage.length} chars), sending follow-up prompt`,
      );
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Runtime error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: CODEX_SESSION_MARKER,
      error: `Codex runtime error: ${errorMessage}`,
    });
  }
}
