/**
 * Codex App Server Runtime for OmniClaw Agent Runner (container-side)
 *
 * Starts `codex app-server` once per container session and drives it over
 * JSON-RPC/stdio. This gives us explicit thread IDs, proper thread resume,
 * and better parity with first-party Codex integrations than `codex exec`.
 *
 * Follows the same IPC protocol (stdin JSON -> stdout markers -> IPC polling).
 *
 * Auth: Supports host-copied Codex login state (~/.codex/auth.json) and
 * OPENAI_API_KEY / CODEX_API_KEY env vars.
 */

import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import fs from 'fs';
import path from 'path';
import readline from 'node:readline';

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
  networkMode?: 'full' | 'none';
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

interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface PendingRequest {
  method: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface TurnState {
  turnId?: string;
  textByItem: Map<string, string>;
  itemOrder: string[];
  resolve: (result: CodexTurnResult) => void;
  reject: (error: Error) => void;
}

interface CodexTurnResult {
  text: string | null;
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  error?: string;
}

interface CodexAppServerSession {
  child: ChildProcessWithoutNullStreams;
  output: readline.Interface;
  pending: Map<string, PendingRequest>;
  nextRequestId: number;
  threadId?: string;
  turnState?: TurnState;
  stopped: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OUTPUT_START_MARKER = '---OMNICLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---OMNICLAW_OUTPUT_END---';
const IPC_POLL_MS = 500;
const APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 1_800_000; // 30 min

const RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS = [
  'not found',
  'missing thread',
  'no such thread',
  'unknown thread',
  'does not exist',
];

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
  return isScheduledTask ? '/workspace/ipc/input-task' : '/workspace/ipc/input';
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readObject(
  value: unknown,
  key?: string,
): Record<string, unknown> | undefined {
  const target =
    key === undefined
      ? value
      : value && typeof value === 'object'
        ? (value as Record<string, unknown>)[key]
        : undefined;
  return asObject(target);
}

function readString(value: unknown, key: string): string | undefined {
  const record = asObject(value);
  if (!record) return undefined;
  const candidate = record[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function readBoolean(value: unknown, key: string): boolean | undefined {
  const record = asObject(value);
  if (!record) return undefined;
  const candidate = record[key];
  return typeof candidate === 'boolean' ? candidate : undefined;
}

function readRouteFields(params: unknown): {
  turnId?: string;
  itemId?: string;
} {
  return {
    turnId:
      readString(params, 'turnId') ??
      readString(readObject(params, 'turn'), 'id'),
    itemId:
      readString(params, 'itemId') ??
      readString(readObject(params, 'item'), 'id'),
  };
}

function isServerRequest(value: unknown): value is JsonRpcRequest {
  const candidate = asObject(value);
  return Boolean(
    candidate &&
    typeof candidate.method === 'string' &&
    (typeof candidate.id === 'string' || typeof candidate.id === 'number'),
  );
}

function isServerNotification(value: unknown): value is JsonRpcNotification {
  const candidate = asObject(value);
  return Boolean(
    candidate && typeof candidate.method === 'string' && !('id' in candidate),
  );
}

function isResponse(value: unknown): value is JsonRpcResponse {
  const candidate = asObject(value);
  return Boolean(
    candidate &&
    (typeof candidate.id === 'string' || typeof candidate.id === 'number') &&
    typeof candidate.method !== 'string',
  );
}

export function extractTextFromCodexContent(content: unknown): string | null {
  if (typeof content === 'string') {
    return content.trim() ? content : null;
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
    .filter((part): part is string => Boolean(part && part.trim()));

  return textParts.length > 0 ? textParts.join('\n') : null;
}

export function extractAssistantTextFromItem(item: unknown): string | null {
  const record = asObject(item);
  if (!record) return null;
  const type = (readString(record, 'type') || '').toLowerCase();
  const role = (readString(record, 'role') || '').toLowerCase();
  const isAssistantLike =
    role === 'assistant' ||
    type === 'assistant_message' ||
    type === 'agent_message' ||
    type === 'agentmessage' ||
    (type === 'message' && role === 'assistant');

  if (!isAssistantLike) {
    return null;
  }

  const directText = readString(record, 'text');
  if (directText?.trim()) {
    return directText;
  }

  return extractTextFromCodexContent(record.content);
}

function upsertTurnItem(
  turnState: TurnState,
  itemId: string,
  text: string,
  append = false,
): void {
  if (!turnState.itemOrder.includes(itemId)) {
    turnState.itemOrder.push(itemId);
  }
  const previous = turnState.textByItem.get(itemId) || '';
  turnState.textByItem.set(itemId, append ? `${previous}${text}` : text);
}

function finalizeTurnText(turnState: TurnState): string | null {
  const parts = turnState.itemOrder
    .map((itemId) => turnState.textByItem.get(itemId)?.trim() || '')
    .filter((text) => text.length > 0);
  return parts.length > 0 ? parts.join('\n') : null;
}

function rejectPendingRequests(
  session: CodexAppServerSession,
  message: string,
): void {
  for (const pending of session.pending.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(message));
  }
  session.pending.clear();
}

function failActiveTurn(session: CodexAppServerSession, message: string): void {
  const turnState = session.turnState;
  if (!turnState) return;
  session.turnState = undefined;
  turnState.reject(new Error(message));
}

function writeJsonRpcMessage(
  session: CodexAppServerSession,
  message: unknown,
): void {
  if (!session.child.stdin.writable) {
    throw new Error('Cannot write to codex app-server stdin.');
  }
  session.child.stdin.write(`${JSON.stringify(message)}\n`);
}

function handleServerRequest(
  session: CodexAppServerSession,
  request: JsonRpcRequest,
): void {
  if (
    request.method === 'item/commandExecution/requestApproval' ||
    request.method === 'item/fileChange/requestApproval' ||
    request.method === 'item/fileRead/requestApproval' ||
    request.method === 'applyPatchApproval' ||
    request.method === 'execCommandApproval'
  ) {
    log(`Auto-declining unsupported approval request: ${request.method}`);
    writeJsonRpcMessage(session, {
      id: request.id,
      result: {
        decision: 'decline',
      },
    });
    return;
  }

  log(`Unsupported app-server request: ${request.method}`);
  writeJsonRpcMessage(session, {
    id: request.id,
    error: {
      code: -32601,
      message: `Unsupported server request: ${request.method}`,
    },
  });
}

function handleResponse(
  session: CodexAppServerSession,
  response: JsonRpcResponse,
): void {
  const pending = session.pending.get(String(response.id));
  if (!pending) return;

  clearTimeout(pending.timeout);
  session.pending.delete(String(response.id));

  if (response.error?.message) {
    pending.reject(
      new Error(`${pending.method} failed: ${String(response.error.message)}`),
    );
    return;
  }

  pending.resolve(response.result);
}

function handleNotification(
  session: CodexAppServerSession,
  notification: JsonRpcNotification,
): void {
  const route = readRouteFields(notification.params);

  if (notification.method === 'thread/started') {
    const threadId =
      readString(readObject(notification.params, 'thread'), 'id') ??
      readString(notification.params, 'threadId');
    if (threadId?.trim()) {
      session.threadId = threadId;
    }
    return;
  }

  if (notification.method === 'turn/started') {
    if (session.turnState) {
      session.turnState.turnId =
        readString(readObject(notification.params, 'turn'), 'id') ??
        route.turnId;
    }
    return;
  }

  if (notification.method === 'item/agentMessage/delta') {
    const delta = readString(notification.params, 'delta');
    if (session.turnState && route.itemId && delta) {
      upsertTurnItem(session.turnState, route.itemId, delta, true);
    }
    return;
  }

  if (notification.method === 'item/completed') {
    if (session.turnState && route.itemId) {
      const text = extractAssistantTextFromItem(
        readObject(notification.params, 'item'),
      );
      if (text) {
        const existing = session.turnState.textByItem.get(route.itemId) || '';
        if (!existing.trim()) {
          upsertTurnItem(session.turnState, route.itemId, text, false);
        }
      }
    }
    return;
  }

  if (notification.method === 'turn/completed') {
    const turnState = session.turnState;
    if (!turnState) return;

    session.turnState = undefined;
    const turn = readObject(notification.params, 'turn');
    const status =
      (readString(turn, 'status') as CodexTurnResult['status'] | undefined) ||
      'completed';
    const errorMessage = readString(readObject(turn, 'error'), 'message');
    turnState.resolve({
      text: finalizeTurnText(turnState),
      status,
      ...(errorMessage ? { error: errorMessage } : {}),
    });
    return;
  }

  if (notification.method === 'error') {
    const errorMessage =
      readString(readObject(notification.params, 'error'), 'message') ||
      'codex app-server reported an error';
    if (!readBoolean(notification.params, 'willRetry')) {
      log(`[app-server error] ${errorMessage}`);
    }
  }
}

function attachProcessListeners(session: CodexAppServerSession): void {
  session.output.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      log(`Invalid JSON from codex app-server: ${trimmed.slice(0, 200)}`);
      return;
    }

    if (isResponse(parsed)) {
      handleResponse(session, parsed);
      return;
    }
    if (isServerRequest(parsed)) {
      handleServerRequest(session, parsed);
      return;
    }
    if (isServerNotification(parsed)) {
      handleNotification(session, parsed);
      return;
    }
  });

  session.child.stderr.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split(/\r?\n/g);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      log(`[stderr] ${line}`);
    }
  });

  session.child.on('error', (error) => {
    const message = error.message || 'codex app-server process errored';
    rejectPendingRequests(session, message);
    failActiveTurn(session, message);
  });

  session.child.on('exit', (code, signal) => {
    if (session.stopped) return;

    const message = `codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
    rejectPendingRequests(session, message);
    failActiveTurn(session, message);
  });
}

async function sendRequest<TResponse>(
  session: CodexAppServerSession,
  method: string,
  params: unknown,
  timeoutMs = APP_SERVER_REQUEST_TIMEOUT_MS,
): Promise<TResponse> {
  const id = session.nextRequestId;
  session.nextRequestId += 1;

  const result = await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      session.pending.delete(String(id));
      reject(new Error(`Timed out waiting for ${method}.`));
    }, timeoutMs);

    session.pending.set(String(id), {
      method,
      timeout,
      resolve,
      reject,
    });

    writeJsonRpcMessage(session, {
      id,
      method,
      params,
    });
  });

  return result as TResponse;
}

function stopCodexAppServer(session: CodexAppServerSession | null): void {
  if (!session || session.stopped) return;
  session.stopped = true;
  rejectPendingRequests(session, 'Session stopped.');
  failActiveTurn(session, 'Session stopped.');
  session.output.close();
  if (!session.child.killed) {
    session.child.kill();
  }
}

function assertCodexCliAvailable(
  cwd: string,
  env: Record<string, string | undefined>,
): void {
  const result = spawnSync('codex', ['--version'], {
    cwd,
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: APP_SERVER_REQUEST_TIMEOUT_MS,
  });

  if (result.error) {
    const lower = result.error.message.toLowerCase();
    if (
      lower.includes('enoent') ||
      lower.includes('command not found') ||
      lower.includes('not found')
    ) {
      throw new Error('Codex CLI is not installed or not executable.');
    }
    throw new Error(
      `Failed to execute Codex CLI version check: ${result.error.message || String(result.error)}`,
    );
  }

  if (result.status !== 0) {
    const detail =
      (result.stderr || '').trim() ||
      (result.stdout || '').trim() ||
      `Command exited with code ${result.status}.`;
    throw new Error(`Codex CLI version check failed. ${detail}`);
  }
}

function buildCodexInitializeParams() {
  return {
    clientInfo: {
      name: 'omniclaw-agent-runner',
      title: 'OmniClaw Agent Runner',
      version: '1.0.0',
    },
    capabilities: {
      experimentalApi: true,
    },
  } as const;
}

export function buildCodexThreadStartParams(input: {
  cwd: string;
  model?: string;
  developerInstructions?: string;
}) {
  return {
    ...(input.model ? { model: input.model } : {}),
    cwd: input.cwd,
    approvalPolicy: 'never' as const,
    sandbox: 'workspace-write' as const,
    experimentalRawEvents: false,
    ...(input.developerInstructions
      ? { developerInstructions: input.developerInstructions }
      : {}),
  };
}

export function buildCodexThreadResumeParams(input: {
  threadId: string;
  cwd: string;
  model?: string;
}) {
  return {
    threadId: input.threadId,
    ...(input.model ? { model: input.model } : {}),
    cwd: input.cwd,
    approvalPolicy: 'never' as const,
    sandbox: 'workspace-write' as const,
  };
}

export function buildCodexTurnStartParams(input: {
  threadId: string;
  prompt: string;
  model?: string;
  networkMode?: 'full' | 'none';
}) {
  return {
    threadId: input.threadId,
    input: [
      {
        type: 'text' as const,
        text: input.prompt,
        text_elements: [],
      },
    ],
    approvalPolicy: 'never' as const,
    sandboxPolicy: {
      type: 'externalSandbox' as const,
      networkAccess: input.networkMode === 'none' ? 'restricted' : 'enabled',
    },
    ...(input.model ? { model: input.model } : {}),
  };
}

function readThreadIdFromResponse(response: unknown, method: string): string {
  const threadId =
    readString(readObject(response, 'thread'), 'id') ??
    readString(response, 'threadId');
  if (!threadId?.trim()) {
    throw new Error(`${method} response did not include a thread id.`);
  }
  return threadId;
}

export function isRecoverableThreadResumeError(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  if (!message.includes('thread/resume')) {
    return false;
  }
  return RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS.some((snippet) =>
    message.includes(snippet),
  );
}

function resolveResumeThreadId(sessionId?: string): string | undefined {
  const normalized = sessionId?.trim();
  if (!normalized) {
    return undefined;
  }
  return normalized;
}

async function startCodexAppServer(
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<CodexAppServerSession> {
  assertCodexCliAvailable(cwd, env);

  const child = spawn('codex', buildCodexAppServerArgs(), {
    cwd,
    env: env as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = readline.createInterface({ input: child.stdout });
  const session: CodexAppServerSession = {
    child,
    output,
    pending: new Map(),
    nextRequestId: 1,
    stopped: false,
  };

  attachProcessListeners(session);
  await sendRequest(session, 'initialize', buildCodexInitializeParams());
  writeJsonRpcMessage(session, { method: 'initialized' });

  try {
    const accountReadResponse = await sendRequest<unknown>(
      session,
      'account/read',
      {},
    );
    const accountType = readString(
      readObject(accountReadResponse, 'account'),
      'type',
    );
    if (accountType) {
      log(`Codex account type: ${accountType}`);
    }
  } catch (err) {
    log(
      `account/read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return session;
}

async function openCodexThread(
  session: CodexAppServerSession,
  opts: {
    resumeThreadId?: string;
    cwd: string;
    model?: string;
    developerInstructions?: string;
  },
): Promise<string> {
  if (opts.resumeThreadId) {
    try {
      const resumed = await sendRequest<unknown>(
        session,
        'thread/resume',
        buildCodexThreadResumeParams({
          threadId: opts.resumeThreadId,
          cwd: opts.cwd,
          model: opts.model,
        }),
      );
      const threadId = readThreadIdFromResponse(resumed, 'thread/resume');
      session.threadId = threadId;
      return threadId;
    } catch (err) {
      if (!isRecoverableThreadResumeError(err)) {
        throw err;
      }
      log(
        `thread/resume failed for ${opts.resumeThreadId}; starting a fresh thread instead`,
      );
    }
  }

  const started = await sendRequest<unknown>(
    session,
    'thread/start',
    buildCodexThreadStartParams({
      cwd: opts.cwd,
      model: opts.model,
      developerInstructions: opts.developerInstructions,
    }),
  );
  const threadId = readThreadIdFromResponse(started, 'thread/start');
  session.threadId = threadId;
  return threadId;
}

async function runCodexTurn(
  session: CodexAppServerSession,
  opts: {
    threadId: string;
    prompt: string;
    model?: string;
    networkMode?: 'full' | 'none';
    timeoutMs: number;
  },
): Promise<CodexTurnResult> {
  if (session.turnState) {
    throw new Error('A Codex turn is already active.');
  }

  const turnPromise = new Promise<CodexTurnResult>((resolve, reject) => {
    session.turnState = {
      textByItem: new Map(),
      itemOrder: [],
      resolve,
      reject,
    };
  });

  const timeout = setTimeout(() => {
    failActiveTurn(session, `Codex turn timed out after ${opts.timeoutMs}ms`);
  }, opts.timeoutMs);

  try {
    const response = await sendRequest<unknown>(
      session,
      'turn/start',
      buildCodexTurnStartParams({
        threadId: opts.threadId,
        prompt: opts.prompt,
        model: opts.model,
        networkMode: opts.networkMode,
      }),
    );
    const responseTurnId = readString(readObject(response, 'turn'), 'id');
    if (responseTurnId && session.turnState) {
      (session.turnState as TurnState).turnId = responseTurnId;
    }
    return await turnPromise;
  } finally {
    clearTimeout(timeout);
  }
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
// System context
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
      identityParts.push(`Your trigger is \`${containerInput.agentTrigger}\`.`);
    }
    if (containerInput.discordBotId) {
      identityParts.push(
        `Your Discord Bot ID is \`${containerInput.discordBotId}\`.`,
      );
    }
    parts.push(`## Your Identity\n${identityParts.join(' ')}`);
  }

  return parts.length > 0 ? parts.join('\n\n---\n\n') : null;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function hasCodexStoredAuth(codexHome = '/home/bun/.codex'): boolean {
  return fs.existsSync(path.join(codexHome, 'auth.json'));
}

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
  ];

  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!SECRET_PREFIXES.some((p) => k.startsWith(p))) {
      env[k] = v;
    }
  }

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

  if (!env.CODEX_HOME) {
    env.CODEX_HOME = '/home/bun/.codex';
  }

  return env;
}

export function buildCodexAppServerArgs(): string[] {
  return ['--dangerously-bypass-approvals-and-sandbox', 'app-server'];
}

// ---------------------------------------------------------------------------
// Main runtime entry point
// ---------------------------------------------------------------------------

export async function runCodexRuntime(
  containerInput: ContainerInput,
): Promise<void> {
  log(`Starting Codex runtime for group: ${containerInput.groupFolder}`);

  ipcInputDir = resolveIpcInputDir(containerInput.isScheduledTask);
  ipcCloseFile = path.join(ipcInputDir, '_close');
  fs.mkdirSync(ipcInputDir, { recursive: true });

  try {
    fs.unlinkSync(ipcCloseFile);
  } catch {
    /* ignore */
  }

  setCurrentChat(containerInput.chatJid);

  const codexEnv = buildCodexEnv(containerInput);
  const hasApiKey = Boolean(codexEnv.CODEX_API_KEY || codexEnv.OPENAI_API_KEY);
  const hasStoredAuth = hasCodexStoredAuth(codexEnv.CODEX_HOME);
  if (!hasApiKey && !hasStoredAuth) {
    log(
      'Warning: No Codex auth found — set OPENAI_API_KEY/CODEX_API_KEY or mount /home/bun/.codex/auth.json',
    );
  } else if (!hasApiKey && hasStoredAuth) {
    log(`Using saved Codex CLI login from ${codexEnv.CODEX_HOME}/auth.json`);
  }

  const model = (codexEnv.CODEX_MODEL || '').trim() || undefined;
  if (model) {
    log(`Using model: ${model}`);
  }

  const cwd = '/workspace/group';
  const systemContext = buildSystemContext(containerInput) || undefined;
  const resumeThreadId = resolveResumeThreadId(containerInput.sessionId);

  let session: CodexAppServerSession | null = null;
  try {
    session = await startCodexAppServer(cwd, codexEnv);
    const threadId = await openCodexThread(session, {
      resumeThreadId,
      cwd,
      model,
      developerInstructions: systemContext,
    });

    let prompt = containerInput.prompt;
    if (containerInput.isScheduledTask) {
      prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
    }

    const pending = drainIpcInput();
    if (pending.length > 0) {
      log(
        `Draining ${pending.length} pending IPC messages into initial prompt`,
      );
      prompt += '\n' + formatIpcMessages(pending);
    }

    while (true) {
      if (shouldClose()) {
        log('Close sentinel detected before prompt, exiting');
        break;
      }

      log(
        `Running Codex turn (${prompt.length} chars) on thread ${threadId}...`,
      );
      const turn = await runCodexTurn(session, {
        threadId,
        prompt,
        model,
        networkMode: containerInput.networkMode,
        timeoutMs: TURN_TIMEOUT_MS,
      });

      if (turn.status !== 'completed' && !turn.text) {
        writeOutput({
          status: 'error',
          result: null,
          newSessionId: threadId,
          error: turn.error || `Codex turn ${turn.status}`,
        });
        break;
      }

      writeOutput({
        status: 'success',
        result: turn.text,
        newSessionId: threadId,
        ...(currentChatJid ? { chatJid: currentChatJid } : {}),
      });

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
      newSessionId: resolveResumeThreadId(containerInput.sessionId),
      error: `Codex runtime error: ${errorMessage}`,
    });
  } finally {
    stopCodexAppServer(session);
  }
}
