/**
 * OpenCode Runtime for OmniClaw Agent Runner (container-side)
 *
 * Alternative to the Claude Agent SDK runtime. Starts an OpenCode server
 * inside the container, creates sessions, and sends prompts via the SDK.
 * Follows the same IPC protocol (stdin JSON → stdout markers → IPC polling).
 *
 * The OpenCode server manages its own tool execution (bash, file ops, web search, etc.)
 * natively, so we don't need to configure tools ourselves.
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

type AgentRuntime = 'claude-agent-sdk' | 'opencode';

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

const OPENCODE_PORT = 14096;
const OPENCODE_HOST = '127.0.0.1';
const SERVER_STARTUP_TIMEOUT = 60_000; // 60s to start server
const HEALTH_POLL_MS = 500;
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---OMNICLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---OMNICLAW_OUTPUT_END---';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[opencode-runtime] ${message}`);
}

/** Resolve IPC input directory based on whether this is a scheduled task. */
function resolveIpcInputDir(isScheduledTask?: boolean): string {
  return isScheduledTask ? '/workspace/ipc/input-task' : '/workspace/ipc/input';
}

// ---------------------------------------------------------------------------
// IPC helpers (same protocol as Claude SDK runtime)
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
  try { fs.writeFileSync('/tmp/current_chat_jid', chatJid); } catch { /* ignore */ }
}

function shouldClose(): boolean {
  if (fs.existsSync(ipcCloseFile)) {
    try { fs.unlinkSync(ipcCloseFile); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): IpcMessage[] {
  try {
    fs.mkdirSync(ipcInputDir, { recursive: true });
    const files = fs.readdirSync(ipcInputDir)
      .filter(f => f.endsWith('.json'))
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
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function formatIpcMessages(messages: IpcMessage[]): string {
  return messages.map(m => m.text).join('\n');
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
// OpenCode server management
// ---------------------------------------------------------------------------

let openCodeServer: { close(): void } | null = null;

/**
 * Start OpenCode server via SDK helper (spawns opencode CLI under the hood).
 */
async function startOpenCodeServer(
  env: Record<string, string | undefined>,
  model?: string,
  mcpEnv?: Record<string, string>,
): Promise<OpenCodeClient> {
  // createOpencodeServer reads process.env only. Apply merged env first.
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }

  const mcpServerPath = path.join(import.meta.dir, 'ipc-mcp-stdio.ts');
  const config: Record<string, unknown> = {};
  if (model) config.model = model;
  if (mcpEnv) {
    config.mcp = {
      omniclaw: {
        type: 'local',
        command: ['bun', mcpServerPath],
        environment: mcpEnv,
        enabled: true,
        timeout: 30000,
      },
    };
  }

  const { createOpencode } = await import('@opencode-ai/sdk');
  const opencode = await createOpencode({
    hostname: OPENCODE_HOST,
    port: OPENCODE_PORT,
    timeout: SERVER_STARTUP_TIMEOUT,
    config: Object.keys(config).length > 0 ? config : undefined,
  });
  openCodeServer = opencode.server;
  log(`OpenCode server is healthy at ${opencode.server.url}`);
  return opencode.client as unknown as OpenCodeClient;
}

function stopOpenCodeServer(): void {
  if (!openCodeServer) return;
  log('Stopping opencode server...');
  try {
    openCodeServer.close();
  } catch {
    // ignore cleanup errors
  }
  openCodeServer = null;
}

// ---------------------------------------------------------------------------
// OpenCode SDK client
// ---------------------------------------------------------------------------

interface OpenCodeClient {
  session: {
    create(opts: { body: Record<string, unknown> }): Promise<{ data?: { id: string } }>;
    get(opts: { path: { id: string } }): Promise<{ data?: { id: string } }>;
    prompt(opts: {
      path: { id: string };
      body: {
        parts: Array<{ type: string; text: string }>;
        noReply?: boolean;
        model?: { providerID: string; modelID: string };
      };
    }): Promise<{ data?: any }>;
    abort(opts: { path: { id: string } }): Promise<void>;
    messages(opts: { path: { id: string } }): Promise<{ data?: any }>;
    status(): Promise<{ data?: any }>;
  };
}

// ---------------------------------------------------------------------------
// Response extraction
// ---------------------------------------------------------------------------

/**
 * Extract text from an OpenCode SDK prompt result.
 * The response shape can vary — try common patterns.
 */
function extractResponseText(result: any): string | null {
  if (!result?.data) return null;
  const data = result.data;

  // Direct text field
  if (typeof data.text === 'string') return data.text;
  if (typeof data.content === 'string') return data.content;

  // Structured output
  if (data.info?.structured_output) {
    return JSON.stringify(data.info.structured_output);
  }

  // Message parts array
  if (Array.isArray(data.parts)) {
    const textParts = data.parts
      .filter((p: any) => p?.type === 'text' || p?.type === 'reasoning')
      .map((p: any) => p.text);
    if (textParts.length > 0) return textParts.join('\n');
  }

  // SDK v1.2.x typically returns { info, parts }
  // where info is assistant metadata and parts carries message content.
  if (data.info && Array.isArray(data.parts)) {
    const text = extractTextFromParts(data.parts);
    if (text) return text;
    const deepCandidates = collectCandidateStrings(data.parts).slice(0, 6);
    if (deepCandidates.length > 0) return deepCandidates.join('\n');
    const partTypes = data.parts.map((p: any) => p?.type || 'unknown').join(', ');
    log(`OpenCode prompt returned non-text parts only: [${partTypes}]`);
    try {
      log(`OpenCode info snapshot: ${JSON.stringify(data.info).slice(0, 800)}`);
    } catch {
      // ignore snapshot stringify errors
    }
  }

  // Messages array — take last assistant message
  if (Array.isArray(data.messages)) {
    for (let i = data.messages.length - 1; i >= 0; i--) {
      const msg = data.messages[i];
      if (msg?.role === 'assistant' && msg.content) {
        if (typeof msg.content === 'string') return msg.content;
        if (Array.isArray(msg.content)) {
          const text = msg.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n');
          if (text) return text;
        }
      }
    }
  }

  log(`Unknown OpenCode result shape, keys: ${Object.keys(data).join(', ')}`);
  return null;
}

function extractTextFromParts(parts: any[]): string | null {
  const extracted: string[] = [];
  for (const p of parts) {
    if ((p?.type === 'text' || p?.type === 'reasoning') && typeof p.text === 'string') {
      extracted.push(p.text);
      continue;
    }
    if (p?.type === 'tool' && typeof p.state?.output === 'string' && p.state.output.trim()) {
      extracted.push(p.state.output);
      continue;
    }
  }
  return extracted.length > 0 ? extracted.join('\n') : null;
}

function collectCandidateStrings(value: any, out: string[] = [], depth: number = 0): string[] {
  if (value == null || depth > 5) return out;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCandidateStrings(item, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    const preferredKeys = ['text', 'output', 'content', 'message', 'reason'];
    for (const key of preferredKeys) {
      if (key in value) collectCandidateStrings((value as any)[key], out, depth + 1);
    }
    for (const [k, v] of Object.entries(value)) {
      if (preferredKeys.includes(k)) continue;
      collectCandidateStrings(v, out, depth + 1);
    }
  }
  return out;
}

function extractTextFromMessage(msg: any): string | null {
  if (!msg) return null;
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) return extractTextFromParts(msg.content);
  if (Array.isArray(msg.parts)) return extractTextFromParts(msg.parts);
  return null;
}

function extractLatestAssistantFromMessages(messages: any[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    // OpenCode messages endpoint commonly returns [{ info, parts }]
    if (msg?.info?.role === 'assistant') {
      const text = extractTextFromParts(Array.isArray(msg.parts) ? msg.parts : []);
      if (text) return text;
    }
    if (msg?.role === 'assistant' || msg?.type === 'assistant') {
      const text = extractTextFromMessage(msg);
      if (text) return text;
    }
  }
  return null;
}

async function waitForAssistantText(
  client: OpenCodeClient,
  sessionId: string,
  timeoutMs: number = 60000,
): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const messagesResponse = await client.session.messages({
        path: { id: sessionId },
      });
      const payload = messagesResponse.data;
      const messages = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.messages)
          ? payload.messages
          : [];
      const text = extractLatestAssistantFromMessages(messages);
      if (text) return text;
    } catch (err) {
      log(
        `Failed to fetch session messages during response wait: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main runtime entry point
// ---------------------------------------------------------------------------

/**
 * Run a single prompt against an OpenCode session.
 * Returns the session ID and whether _close was detected during the prompt.
 */
async function runOpenCodePrompt(
  client: OpenCodeClient,
  sessionId: string,
  prompt: string,
  timeoutMs: number,
  forcedModel?: { providerID: string; modelID: string },
): Promise<{ sessionId: string; closedDuringPrompt: boolean; promptSucceeded: boolean }> {
  let closedDuringPrompt = false;

  // Poll IPC for follow-up messages during the prompt
  // (OpenCode prompts are blocking, so we poll in the background and abort if _close)
  let ipcPolling = true;
  const pollIpc = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during prompt, aborting');
      closedDuringPrompt = true;
      ipcPolling = false;
      // Try to abort the running prompt
      client.session.abort({ path: { id: sessionId } }).catch(() => {});
      return;
    }
    // Drain messages but queue them for next prompt (can't inject mid-prompt)
    setTimeout(pollIpc, IPC_POLL_MS);
  };
  setTimeout(pollIpc, IPC_POLL_MS);

  try {
    const result = await Promise.race([
      client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: 'text', text: prompt }],
          ...(forcedModel ? { model: forcedModel } : {}),
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`OpenCode prompt timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);

    ipcPolling = false;

    let responseText = extractResponseText(result);
    if (!responseText) {
      responseText = await waitForAssistantText(client, sessionId);
    }
    if (!responseText) {
      responseText = 'I processed your message but did not generate a text response.';
    }
    log(`Prompt completed, response: ${responseText.slice(0, 200)}...`);

    // Emit intermediate tool results if available
    // (OpenCode doesn't expose granular tool-call streaming via SDK prompt,
    //  so we just emit the final result)

    const output: ContainerOutput = {
      status: 'success',
      result: responseText,
      newSessionId: sessionId,
    };
    if (currentChatJid) output.chatJid = currentChatJid;
    writeOutput(output);

    return { sessionId, closedDuringPrompt, promptSucceeded: true };
  } catch (err) {
    ipcPolling = false;

    if (closedDuringPrompt) {
      return { sessionId, closedDuringPrompt: true, promptSucceeded: false };
    }

    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Prompt error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: `OpenCode prompt error: ${errorMessage}`,
    });

    return { sessionId, closedDuringPrompt: false, promptSucceeded: false };
  }
}

/**
 * Build system context to inject into the session.
 * This includes CLAUDE.md content and other group-specific instructions.
 */
function buildSystemContext(containerInput: ContainerInput): string | null {
  const parts: string[] = [];

  // Group CLAUDE.md
  const groupClaudeMd = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupClaudeMd)) {
    parts.push(fs.readFileSync(groupClaudeMd, 'utf-8'));
  }

  // Global CLAUDE.md (non-main agents only)
  if (!containerInput.isMain) {
    const globalClaudeMd = '/workspace/global/CLAUDE.md';
    if (fs.existsSync(globalClaudeMd)) {
      parts.push(fs.readFileSync(globalClaudeMd, 'utf-8'));
    }
  }

  if (parts.length === 0) return null;
  return parts.join('\n\n---\n\n');
}

/**
 * Main entry point for the OpenCode runtime.
 * Called from the agent-runner's main() when agentRuntime === 'opencode'.
 */
export async function runOpenCodeRuntime(containerInput: ContainerInput): Promise<void> {
  log(`Starting OpenCode runtime for group: ${containerInput.groupFolder}`);

  // Configure IPC directories
  if (containerInput.isScheduledTask) {
    ipcInputDir = '/workspace/ipc/input-task';
    ipcCloseFile = path.join(ipcInputDir, '_close');
    log('Using task IPC lane: /workspace/ipc/input-task');
  }
  fs.mkdirSync(ipcInputDir, { recursive: true });

  // Clean up stale _close sentinel
  try { fs.unlinkSync(ipcCloseFile); } catch { /* ignore */ }

  // Initialize current chat JID
  setCurrentChat(containerInput.chatJid);

  // Build env with secrets for the opencode server
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  const openCodeModelEnv = (sdkEnv.OPENCODE_MODEL || '').trim();
  const openCodeProviderEnv = (sdkEnv.OPENCODE_PROVIDER || '').trim();
  const openCodeModelIdEnv = (sdkEnv.OPENCODE_MODEL_ID || '').trim();
  let forcedModel: { providerID: string; modelID: string } | undefined;
  if (openCodeModelEnv.includes('/')) {
    const [providerID, ...rest] = openCodeModelEnv.split('/');
    const modelID = rest.join('/').trim();
    if (providerID.trim() && modelID) {
      forcedModel = { providerID: providerID.trim(), modelID };
    }
  } else if (openCodeProviderEnv && (openCodeModelIdEnv || openCodeModelEnv)) {
    forcedModel = {
      providerID: openCodeProviderEnv,
      modelID: openCodeModelIdEnv || openCodeModelEnv,
    };
  }
  if (forcedModel) {
    log(`Forcing OpenCode model: ${forcedModel.providerID}/${forcedModel.modelID}`);
  } else {
    log('OpenCode model not forced (using provider default)');
  }
  const forcedModelArg = forcedModel
    ? `${forcedModel.providerID}/${forcedModel.modelID}`
    : undefined;

  // Build MCP env so the omniclaw channel tools (send_message, react_to_message,
  // format_mention, schedule_task, etc.) are available inside OpenCode sessions.
  const mcpEnv: Record<string, string> = {
    OMNICLAW_CHAT_JID: containerInput.chatJid,
    OMNICLAW_GROUP_FOLDER: containerInput.groupFolder,
    OMNICLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
  };
  if (containerInput.discordGuildId) mcpEnv.OMNICLAW_DISCORD_GUILD_ID = containerInput.discordGuildId;
  if (containerInput.serverFolder) mcpEnv.OMNICLAW_SERVER_FOLDER = containerInput.serverFolder;
  if (containerInput.channels) mcpEnv.OMNICLAW_CHANNELS = JSON.stringify(containerInput.channels);

  let client: OpenCodeClient;
  try {
    client = await startOpenCodeServer(sdkEnv, forcedModelArg, mcpEnv);
    await client.session.status();
    log('Connected to OpenCode server');
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Failed to start/connect OpenCode server: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to start/connect OpenCode server: ${errorMessage}`,
    });
    stopOpenCodeServer();
    process.exit(1);
  }

  // Ensure cleanup on exit
  process.on('exit', stopOpenCodeServer);
  process.on('SIGTERM', () => { stopOpenCodeServer(); process.exit(0); });
  process.on('SIGINT', () => { stopOpenCodeServer(); process.exit(0); });

  // Create or resume session
  let sessionId: string;
  let isResumedSession = false;
  try {
    if (containerInput.sessionId) {
      try {
        const existing = await client.session.get({ path: { id: containerInput.sessionId } });
        const resolvedId = existing.data?.id || containerInput.sessionId;
        if (!resolvedId) {
          throw new Error('Session exists but returned empty ID');
        }
        sessionId = resolvedId;
        isResumedSession = true;
        log(`Resumed session: ${sessionId}`);
      } catch {
        const newSession = await client.session.create({ body: {} });
        if (!newSession.data?.id) {
          throw new Error('Session created but returned no ID');
        }
        sessionId = newSession.data.id;
        log(`Previous session not found, created new: ${sessionId}`);
      }
    } else {
      const newSession = await client.session.create({ body: {} });
      if (!newSession.data?.id) {
        throw new Error('Session created but returned no ID');
      }
      sessionId = newSession.data.id;
      log(`Created new session: ${sessionId}`);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Failed to create session: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to create OpenCode session: ${errorMessage}`,
    });
    stopOpenCodeServer();
    process.exit(1);
  }

  // Inject system context (CLAUDE.md etc.) as a no-reply setup prompt.
  // Only inject on NEW sessions — resumed sessions already have context
  // from the original setup prompt. Re-injecting would duplicate CLAUDE.md.
  if (!isResumedSession) {
    const systemContext = buildSystemContext(containerInput);
    if (systemContext) {
      try {
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            noReply: true,
            parts: [{ type: 'text', text: systemContext }],
            ...(forcedModel ? { model: forcedModel } : {}),
          },
        });
        log('Injected system context');
      } catch (err) {
        log(`Failed to inject system context (continuing): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    log('Skipping system context injection (resumed session)');
  }

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + formatIpcMessages(pending);
  }

  // Default timeout from container config
  const timeoutMs = 1800000; // 30 minutes — matches host CONTAINER_TIMEOUT default

  // Query loop: send prompt → wait for IPC → repeat
  try {
    while (true) {
      log(`Sending prompt (session: ${sessionId}, ${prompt.length} chars)...`);

      const result = await runOpenCodePrompt(client, sessionId, prompt, timeoutMs, forcedModel);
      sessionId = result.sessionId;

      if (result.closedDuringPrompt) {
        log('Close sentinel consumed during prompt, exiting');
        break;
      }
      if (!result.promptSucceeded) {
        log('Prompt failed, exiting runtime loop');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Prompt ended, waiting for next IPC message...');

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), sending follow-up prompt`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Runtime error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: `OpenCode runtime error: ${errorMessage}`,
    });
  } finally {
    stopOpenCodeServer();
  }
}
