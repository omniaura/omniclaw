/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol (newline-delimited JSON over stdin):
 *   Line 1: Full ContainerInput JSON
 *   Line 2+: Follow-up messages as JSON: {type:"message", text:"..."} or {type:"close"}
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  discordGuildId?: string;
  serverFolder?: string;
  dittoMcpToken?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | ContentBlock[] };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_POLL_MS = 500;

/** Parsed stdin follow-up: message or close signal */
type StdinFollowUp = { type: 'message'; text: string } | { type: 'close' };

/**
 * Reads newline-delimited JSON from stdin. Line 1 = ContainerInput.
 * Subsequent lines = follow-up messages. Runs for the lifetime of the process.
 */
class StdinLineReader {
  private lines: string[] = [];
  private waiting: (() => void) | null = null;
  private closed = false;

  constructor() {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
      this.lines.push(line.trim());
      this.waiting?.();
    });
    rl.on('close', () => {
      this.closed = true;
      this.waiting?.();
    });
  }

  private async waitForLine(): Promise<void> {
    while (this.lines.length === 0 && !this.closed) {
      await new Promise<void>((r) => { this.waiting = r; });
      this.waiting = null;
    }
  }

  /** Read first line (ContainerInput). Must be called first. */
  async readInitialInput(): Promise<string> {
    await this.waitForLine();
    return this.lines.shift() ?? '';
  }

  /** Check if close was received (for poll during query) */
  hasClose(): boolean {
    for (let i = 0; i < this.lines.length; i++) {
      try {
        const p = JSON.parse(this.lines[i]) as { type: string };
        if (p.type === 'close') return true;
      } catch { /* skip */ }
    }
    return false;
  }

  /** Get next follow-up or null if EOF. Blocks until one is available. */
  async readNext(): Promise<StdinFollowUp | null> {
    while (true) {
      await this.waitForLine();
      while (this.lines.length > 0) {
        const line = this.lines.shift() ?? '';
        if (!line) continue;
        try {
          const p = JSON.parse(line) as { type: string; text?: string };
          if (p.type === 'close') return { type: 'close' };
          if (p.type === 'message' && typeof p.text === 'string') return { type: 'message', text: p.text };
        } catch { /* skip malformed */ }
      }
      if (this.closed) return null;
    }
  }
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: buildContent(text) },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}


const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

const IMAGE_MARKER_RE = /\[attachment:image file=([^\]]+)\]/g;

const EXT_TO_MEDIA_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Parse [attachment:image file=...] markers in text.
 * Returns the original string if no images found, or ContentBlock[] with
 * interleaved text and base64-encoded image blocks.
 */
function buildContent(text: string): string | ContentBlock[] {
  const matches = [...text.matchAll(IMAGE_MARKER_RE)];
  if (matches.length === 0) return text;

  const blocks: ContentBlock[] = [];
  let lastIndex = 0;

  for (const match of matches) {
    // Add preceding text
    const before = text.slice(lastIndex, match.index);
    if (before.trim()) {
      blocks.push({ type: 'text', text: before });
    }

    const filename = match[1];
    const filePath = path.join('/workspace/group/media', filename);

    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(filename).toLowerCase();
        const mediaType = EXT_TO_MEDIA_TYPE[ext] || 'image/png';
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: data.toString('base64') },
        });
      } else {
        log(`Image file not found: ${filePath}`);
        blocks.push({ type: 'text', text: '[Image unavailable]' });
      }
    } catch (err) {
      log(`Failed to read image ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      blocks.push({ type: 'text', text: '[Image unavailable]' });
    }

    lastIndex = match.index! + match[0].length;
  }

  // Add trailing text
  const after = text.slice(lastIndex);
  if (after.trim()) {
    blocks.push({ type: 'text', text: after });
  }

  return blocks.length > 0 ? blocks : text;
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Andy';
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Wait for next stdin follow-up. Returns message text or null if close/EOF.
 */
async function waitForStdinMessage(reader: StdinLineReader): Promise<string | null> {
  const msg = await reader.readNext();
  if (!msg) return null;
  if (msg.type === 'close') return null;
  return msg.text;
}

/** Detect orphaned tool_result / tool_use_id API error (common after compaction) */
function isOrphanedToolResultError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('tool_use_id') ||
    msg.includes('tool_result') ||
    msg.includes('invalid_request_error')
  );
}

/** Check if result text is an API error (e.g. orphaned tool_result) - should retry without session */
function isApiErrorResult(text: string | null): boolean {
  if (!text) return false;
  return (
    text.includes('API Error') &&
    (text.includes('tool_use_id') || text.includes('tool_result') || text.includes('invalid_request_error'))
  );
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 * On orphaned tool_result API error (compaction bug), retries once without session resume.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  resumeAt?: string,
  isRetry = false,
  stdinReader?: StdinLineReader,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll stdin for close during the query. waitForStdinMessage handles follow-ups after each query ends.
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollStdinDuringQuery = () => {
    if (!ipcPolling || !stdinReader) return;
    if (stdinReader.hasClose()) {
      log('Close detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    setTimeout(pollStdinDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollStdinDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  const allowedTools = [
    'Bash',
    'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'WebSearch', 'WebFetch',
    'Task', 'TaskOutput', 'TaskStop',
    'TeamCreate', 'TeamDelete', 'SendMessage',
    'TodoWrite', 'ToolSearch', 'Skill',
    'NotebookEdit',
    'mcp__nanoclaw__*',
    ...(containerInput.dittoMcpToken ? ['mcp__ditto__*' as const] : []),
  ];

  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> } | { type: 'http'; url: string; headers: Record<string, string> }> = {
    nanoclaw: {
      command: 'node',
      args: [mcpServerPath],
      env: {
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        ...(containerInput.discordGuildId ? { NANOCLAW_DISCORD_GUILD_ID: containerInput.discordGuildId } : {}),
        ...(containerInput.serverFolder ? { NANOCLAW_SERVER_FOLDER: containerInput.serverFolder } : {}),
      },
    },
  };
  if (containerInput.dittoMcpToken) {
    mcpServers.ditto = {
      type: 'http',
      url: 'https://api.heyditto.ai/mcp/sse',
      headers: { Authorization: `Bearer ${containerInput.dittoMcpToken}` },
    };
  }

  try {
    for await (const message of query({
      prompt: stream,
      options: {
        cwd: '/workspace/group',
        resume: sessionId,
        resumeSessionAt: resumeAt,
        systemPrompt: globalClaudeMd
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
          : undefined,
        allowedTools,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers,
        hooks: {
          PreCompact: [{ hooks: [createPreCompactHook()] }]
        },
      }
    })) {
      messageCount++;
      const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
      log(`[msg #${messageCount}] type=${msgType}`);

      if (message.type === 'assistant' && 'uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
      }

      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        log(`Session initialized: ${newSessionId}`);
      }

      if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
        const tn = message as { task_id: string; status: string; summary: string };
        log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
      }

      if (message.type === 'result') {
        resultCount++;
        const textResult = 'result' in message ? (message as { result?: string }).result : null;
        log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);

        // API errors (e.g. orphaned tool_result) come back as results - retry without session
        if (isApiErrorResult(textResult ?? null) && sessionId && !isRetry) {
          log(`Orphaned tool_result API error in result, retrying without session`);
          throw new Error(textResult || 'Orphaned tool_result error');
        }

        writeOutput({
          status: 'success',
          result: textResult || null,
          newSessionId
        });
        stream.end();
        // Force exit — SDK iterator may not end on some setups; break so we reach waitForIpcMessage
        log('Breaking out of query loop to process follow-ups');
        break;
      }
    }
  } catch (err) {
    const canRetry =
      !isRetry &&
      sessionId &&
      isOrphanedToolResultError(err);
    if (canRetry) {
      log(`Orphaned tool_result error on session resume, retrying without session: ${err instanceof Error ? err.message : String(err)}`);
      return runQuery(prompt, undefined, mcpServerPath, containerInput, undefined, true, stdinReader);
    }
    throw err;
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

async function main(): Promise<void> {
  const stdinReader = new StdinLineReader();
  let containerInput: ContainerInput;

  try {
    const firstLine = await stdinReader.readInitialInput();
    containerInput = JSON.parse(firstLine);
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }

  // Query loop: run query → wait for stdin message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, resumeAt, false, stdinReader);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If close was consumed during the query, exit immediately.
      if (queryResult.closedDuringQuery) {
        log('Close received during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next stdin message...');

      const nextMessage = await waitForStdinMessage(stdinReader);
      if (nextMessage === null) {
        log('Close received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
