/**
 * OmniClaw Agent Runner (container-side)
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

// Intentionally duplicated from src/backends/types.ts — this container process runs in
// an isolated environment and cannot import from the host's source tree at runtime.
interface ChannelInfo {
  id: string;
  jid: string;
  name: string;
}

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
  /** Multi-channel routing: all channels that map to this agent. Only set when agent has >1 route. */
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

// Defaults to the message lane; reassigned to input-task/ after stdin is parsed
// when containerInput.isScheduledTask is true.
let IPC_INPUT_DIR = '/workspace/ipc/input';
let IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');

/**
 * Determine the IPC input directory based on whether this is a scheduled task.
 * Exported for testing.
 */
export function resolveIpcInputDir(isScheduledTask?: boolean): string {
  return isScheduledTask ? '/workspace/ipc/input-task' : '/workspace/ipc/input';
}
const IPC_POLL_MS = 500;

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

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---OMNICLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---OMNICLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  // Inject current chatJid so the host can route responses to the correct channel
  const enriched = currentChatJidValue ? { ...output, chatJid: currentChatJidValue } : output;
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(enriched));
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

const MEDIA_DIR = '/workspace/group/media';

/**
 * Parse [attachment:image file=...] markers in text.
 * Returns the original string if no images found, or ContentBlock[] with
 * interleaved text and base64-encoded image blocks.
 *
 * Security: Validates that resolved file paths stay within the media directory
 * to prevent path traversal attacks that could bypass Read/Bash hook protections.
 * See: https://github.com/omniaura/omniclaw/issues/40
 */
/** @internal exported for testing */
export function buildContent(text: string): string | ContentBlock[] {
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
    const filePath = path.resolve(MEDIA_DIR, filename);

    // Security: Ensure resolved path stays within the media directory.
    // Without this check, a crafted filename like "../../../../workspace/env-dir/env"
    // could read secrets, bypassing createSanitizeReadHook protections.
    if (!filePath.startsWith(MEDIA_DIR + '/')) {
      log(`Path traversal blocked in image attachment: ${filename}`);
      blocks.push({ type: 'text', text: '[Image blocked: invalid path]' });
      lastIndex = match.index! + match[0].length;
      continue;
    }

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

// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands Kit runs.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * createSanitizeBashHook
 *
 * Dual protection for Bash commands:
 * 1. Blocks commands attempting to access sensitive paths that could leak secrets
 * 2. Prepends `unset` for secret env vars (defense-in-depth)
 *
 * The `unset` protects against accidental access, but /proc/self/environ
 * is an immutable kernel snapshot that `unset` cannot clear. We must
 * explicitly block access attempts.
 *
 * Related: Issue #79, upstream PR #216
 */
export function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    // Block commands accessing /proc/*/environ (any path component, not just numbered PIDs)
    // Broad match prevents traversal bypasses like /proc/self/../self/environ
    if (/\/proc\/[^ \t\n]*\/environ/.test(command)) {
      throw new Error(
        'Access to /proc/*/environ is not allowed for security reasons. ' +
        'This file contains process environment variables which may include sensitive credentials. ' +
        'See: https://github.com/omniaura/omniclaw/issues/79'
      );
    }

    // Block other sensitive paths
    const blockedPaths = [
      /\/tmp\/input\.json/,              // Stdin buffer
      /\/workspace\/env-dir(?:\/|$)/,   // Mounted env directory (with or without trailing slash)
      /\/workspace\/project\/\.env(?:\s|$|[;|&><)\n]|\$\()/,  // Project root .env (masked by /dev/null mount, defense-in-depth)
      /\/proc\/.*\/mountinfo/,       // Mount enumeration
      /\/proc\/.*\/mounts/,          // Mount list
      /\/etc\/mtab/,                 // Mount table
      /\/etc\/fstab/,                // Filesystem table
    ];

    for (const pattern of blockedPaths) {
      if (pattern.test(command)) {
        throw new Error(
          'This command attempts to access a restricted file that could expose credentials. ' +
          'See: https://github.com/omniaura/omniclaw/issues/79'
        );
      }
    }

    // Prepend unset for defense-in-depth
    // (Even though secrets shouldn't be in process.env, unset provides extra safety)
    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

const MAX_READ_BYTES = 50 * 1024; // 50 KB
const DEFAULT_READ_LIMIT_LINES = 500;

/**
 * createFileSizeHook
 *
 * Prevents large files from flooding the context window.
 * If a file exceeds MAX_READ_BYTES and the agent hasn't already specified
 * a `limit`, injects `limit: DEFAULT_READ_LIMIT_LINES` so the agent sees
 * a truncated preview rather than the full file.
 *
 * The agent can still read specific sections using offset+limit.
 */
export function createFileSizeHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const { file_path, limit } = preInput.tool_input as { file_path?: string; limit?: number };
    if (!file_path) return {};
    // Respect an explicit limit the agent already set
    if (limit != null) return {};

    let size: number;
    try {
      size = fs.statSync(file_path).size;
    } catch {
      return {}; // File doesn't exist — let Read handle it
    }

    if (size > MAX_READ_BYTES) {
      log(`Large file: ${file_path} (${Math.round(size / 1024)}KB), injecting limit=${DEFAULT_READ_LIMIT_LINES}`);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: {
            ...(preInput.tool_input as Record<string, unknown>),
            limit: DEFAULT_READ_LIMIT_LINES,
          },
        },
      };
    }

    return {};
  };
}

/**
 * createSanitizeReadHook
 *
 * Blocks Read tool access to files that could leak secrets:
 * - /proc/[pid]/environ (kernel env snapshot)
 * - /tmp/input.json (stdin buffer with secrets)
 * - /workspace/env-dir/ (mounted env files)
 * - /workspace/project/.env (project root secrets, masked by /dev/null mount)
 * - Mount enumeration files (mountinfo, mtab, fstab)
 *
 * Related: Issue #79, upstream PR #216
 */
export function createSanitizeReadHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const filePath = (preInput.tool_input as { file_path?: string })?.file_path;
    if (!filePath) return {};

    // Normalize path: resolve '..' components and follow symlinks
    // path.resolve only handles '..', so use realpathSync to also follow symlinks
    let normalized = path.resolve(filePath);
    try {
      normalized = fs.realpathSync(normalized);
    } catch {
      // File may not exist yet; fall back to path.resolve result
    }

    // Block reads of sensitive files
    const blockedPatterns = [
      /^\/proc\/(?:\d+|self)(?:\/[^/]+)*\/environ$/, // Process/task environ (any depth: /proc/<pid>/task/<tid>/environ)
      /^\/tmp\/input\.json$/,         // Stdin buffer
      /^\/workspace\/env-dir\//,      // Mounted env directory
      /^\/workspace\/project\/\.env$/, // Project root .env (masked by /dev/null mount, defense-in-depth)
      /^\/proc\/(\d+|self)\/mountinfo$/,  // Mount enumeration for any PID (Issue #79)
      /^\/proc\/(\d+|self)\/mounts$/,    // Mount list for any PID
      /^\/etc\/mtab$/,                // Mount table
      /^\/etc\/fstab$/,               // Filesystem table
    ];

    for (const pattern of blockedPatterns) {
      if (pattern.test(normalized)) {
        throw new Error(
          `Reading ${filePath} is not allowed for security reasons. ` +
          `This path could expose sensitive credentials. ` +
          `See: https://github.com/omniaura/omniclaw/issues/79`
        );
      }
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
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

interface IpcMessage {
  text: string;
  chatJid?: string;
}

// Track the current chat JID for multi-channel agents.
// Written to /tmp/current_chat_jid so the MCP server can read it.
const CURRENT_CHAT_FILE = '/tmp/current_chat_jid';
let currentChatJidValue = '';

function setCurrentChat(chatJid: string): void {
  currentChatJidValue = chatJid;
  try { fs.writeFileSync(CURRENT_CHAT_FILE, chatJid); } catch { /* ignore */ }
}

/**
 * Drain all pending IPC input messages.
 * Returns structured messages with optional chatJid for multi-channel routing.
 */
function drainIpcInput(): IpcMessage[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: IpcMessage[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push({ text: data.text, chatJid: data.chatJid });
          // Update current chat if this message has a chatJid
          if (data.chatJid) {
            setCurrentChat(data.chatJid);
          }
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

/**
 * Build a channel name lookup from OMNICLAW_CHANNELS env var.
 */
function getChannelNameLookup(): Map<string, string> {
  const lookup = new Map<string, string>();
  const channelsEnv = process.env.OMNICLAW_CHANNELS;
  if (channelsEnv) {
    try {
      const channels: ChannelInfo[] = JSON.parse(channelsEnv);
      for (const ch of channels) {
        lookup.set(ch.jid, ch.name);
      }
    } catch (err) {
      console.error(`[omniclaw] Failed to parse OMNICLAW_CHANNELS: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return lookup;
}

const channelNames = getChannelNameLookup();
const isMultiChannel = channelNames.size > 1;

/**
 * Format IPC messages into a prompt string.
 * For multi-channel agents, prefix messages with chat context.
 */
function formatIpcMessages(messages: IpcMessage[]): string {
  if (!isMultiChannel) {
    return messages.map(m => m.text).join('\n');
  }

  return messages.map(m => {
    if (m.chatJid) {
      const channelName = channelNames.get(m.chatJid) || m.chatJid;
      return `[From: ${channelName}]\n${m.text}`;
    }
    return m.text;
  }).join('\n');
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
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

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    if (messages.length > 0) {
      const formatted = formatIpcMessages(messages);
      log(`Piping IPC message into active query (${formatted.length} chars)`);
      stream.push(formatted);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let lastAssistantText: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      model: sdkEnv.CLAUDE_MODEL || 'claude-opus-4-6',
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
        : undefined,
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'EnterPlanMode', 'ExitPlanMode',
        'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList',
        'mcp__omniclaw__*'
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        omniclaw: {
          command: 'bun',
          args: [mcpServerPath],
          env: {
            OMNICLAW_CHAT_JID: containerInput.chatJid,
            OMNICLAW_GROUP_FOLDER: containerInput.groupFolder,
            OMNICLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
            ...(containerInput.discordGuildId ? { OMNICLAW_DISCORD_GUILD_ID: containerInput.discordGuildId } : {}),
            ...(containerInput.serverFolder ? { OMNICLAW_SERVER_FOLDER: containerInput.serverFolder } : {}),
            ...(containerInput.channels ? { OMNICLAW_CHANNELS: JSON.stringify(containerInput.channels) } : {}),
          },
        },
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook()] }],
        PreToolUse: [
          { matcher: 'Bash', hooks: [createSanitizeBashHook()] },
          { matcher: 'Read', hooks: [createSanitizeReadHook(), createFileSizeHook()] },
        ],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    // Log tool calls from assistant messages for observability
    if (message.type === 'assistant' && 'message' in message) {
      const content = (message as any).message?.content;
      if (Array.isArray(content)) {
        const tools = content.filter((c: any) => c.type === 'tool_use');
        const texts = content.filter((c: any) => c.type === 'text');
        const thinkingBlocks = content.filter((c: any) => c.type === 'thinking');
        if (tools.length > 0) {
          for (const tool of tools) {
            const input = tool.input || {};
            const summary = tool.name === 'Bash' ? (input.command || '').slice(0, 120)
              : tool.name === 'Read' ? input.file_path
              : tool.name === 'Write' ? input.file_path
              : tool.name === 'Edit' ? input.file_path
              : tool.name === 'Grep' ? `${input.pattern} ${input.path || ''}`
              : tool.name === 'Glob' ? input.pattern
              : tool.name === 'Task' ? input.description
              : tool.name === 'WebFetch' ? input.url
              : tool.name === 'WebSearch' ? input.query
              : JSON.stringify(input).slice(0, 80);
            log(`[msg #${messageCount}] tool=${tool.name} ${summary}`);
          }
        }
        if (texts.length > 0) {
          const textPreview = texts.map((t: any) => t.text).join('').slice(0, 120);
          if (textPreview.trim()) {
            log(`[msg #${messageCount}] text="${textPreview}"`);
          }
        }

        // Emit intermediate output for assistant messages (thinking, text, tool calls)
        const parts: string[] = [];
        for (const block of thinkingBlocks) {
          if (block.thinking) {
            const truncated = block.thinking.length > 1500
              ? block.thinking.slice(0, 1500) + '...'
              : block.thinking;
            parts.push(`> *thinking*: ${truncated}`);
          }
        }
        for (const block of texts) {
          if (block.text?.trim()) {
            parts.push(block.text);
          }
        }
        for (const tool of tools) {
          const input = tool.input || {};
          const summary = tool.name === 'Bash' ? `\`${(input.command || '').slice(0, 120)}\``
            : tool.name === 'Read' ? input.file_path
            : tool.name === 'Write' ? input.file_path
            : tool.name === 'Edit' ? input.file_path
            : tool.name === 'Grep' ? `\`${input.pattern} ${input.path || ''}\``
            : tool.name === 'Glob' ? `\`${input.pattern}\``
            : tool.name === 'Task' ? input.description
            : tool.name === 'WebFetch' ? input.url
            : tool.name === 'WebSearch' ? input.query
            : JSON.stringify(input).slice(0, 80);
          parts.push(`> **${tool.name}**: ${summary}`);
        }
        if (parts.length > 0) {
          writeOutput({ status: 'success', result: parts.join('\n'), newSessionId, intermediate: true });
        }
      }
    } else if (message.type === 'user' && 'message' in message) {
      log(`[msg #${messageCount}] type=${msgType}`);
      // Emit intermediate output for tool results
      const userContent = (message as any).message?.content;
      if (Array.isArray(userContent)) {
        const toolResults = userContent.filter((c: any) => c.type === 'tool_result');
        for (const result of toolResults) {
          const resultText = typeof result.content === 'string'
            ? result.content
            : Array.isArray(result.content)
              ? result.content.map((c: any) => c.text || '').join('')
              : '';
          if (resultText.trim()) {
            const truncated = resultText.length > 500
              ? resultText.slice(0, 500) + '...'
              : resultText;
            writeOutput({
              status: 'success',
              result: '```\n' + truncated + '\n```',
              newSessionId,
              intermediate: true,
            });
          }
        }
      }
    } else {
      log(`[msg #${messageCount}] type=${msgType}`);
    }

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
      // Track the last assistant text so we can use it as fallback when the
      // result event has no text (e.g. agent wrote text then did a final tool call)
      const content = (message as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(content)) {
        const textBlocks = content
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: { text: string }) => b.text)
          .join('');
        if (textBlocks) lastAssistantText = textBlocks;
      } else if (typeof content === 'string' && content) {
        lastAssistantText = content;
      }
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
      // When the agent writes text then does a final tool call (e.g. closing the
      // browser), the result event has no text. Fall back to the last assistant
      // text so the user still gets the response.
      const effectiveResult = textResult || lastAssistantText || null;
      const rm = message as any;
      log(`Result #${resultCount}: subtype=${message.subtype} turns=${rm.num_turns || '?'} duration=${rm.duration_ms || '?'}ms cost=$${rm.total_cost_usd?.toFixed(4) || '?'}${effectiveResult ? ` text=${effectiveResult.slice(0, 200)}` : ''}`);
      writeOutput({
        status: 'success',
        result: effectiveResult,
        newSessionId
      });
      lastAssistantText = undefined;
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Scheduled tasks use a separate IPC input directory so reactions and
  // follow-up messages don't leak into the task lane.
  if (containerInput.isScheduledTask) {
    IPC_INPUT_DIR = '/workspace/ipc/input-task';
    IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
    log('Using task IPC lane: /workspace/ipc/input-task');
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  log(`Model: ${sdkEnv.CLAUDE_MODEL || '(default)'}`);

  const mcpServerPath = path.join(import.meta.dir, 'ipc-mcp-stdio.ts');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Check for auto-update notification
  let updateNotification = '';
  const updateInfoPath = process.env.UPDATE_INFO_PATH || '/workspace/data/.omniclaw-update-info.json';
  const productName = process.env.PRODUCT_NAME || 'OmniClaw';
  try {
    if (fs.existsSync(updateInfoPath)) {
      const updateInfo = JSON.parse(fs.readFileSync(updateInfoPath, 'utf-8'));
      if (updateInfo.updated) {
        log('Auto-update detected, preparing notification');

        // Build commit log
        const commits = (updateInfo.commitLog || [])
          .map((c: { short: string; subject: string }) => `- ${c.short}: ${c.subject}`)
          .join('\n');

        updateNotification = `
🔄 ${productName} Auto-Update Complete

You've been updated to commit ${updateInfo.newCommit.substring(0, 8)} (from ${updateInfo.oldCommit.substring(0, 8)}).

Recent commits:
${commits || '(No commit details available)'}

Please review these changes to understand your new capabilities and fixes.

---

`.trim() + '\n\n';

        // Delete the update info file so we don't show this notification again
        try {
          fs.unlinkSync(updateInfoPath);
          log('Consumed update notification file');
        } catch (err) {
          log(`Failed to delete update info file: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err) {
    log(`Failed to read update info: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Initialize current chat JID from container input
  setCurrentChat(containerInput.chatJid);

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + formatIpcMessages(pending);
  }

  // Prepend update notification if present
  if (updateNotification) {
    prompt = updateNotification + prompt;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  // Initialize resumeAt from containerInput so subsequent container spawns
  // skip full session replay and resume from the last known position.
  let resumeAt: string | undefined = containerInput.resumeAt;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it (include resumeAt so host persists it)
      writeOutput({ status: 'success', result: null, newSessionId: sessionId, resumeAt });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
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
      resumeAt,
      error: errorMessage
    });
    process.exit(1);
  }
}

// Only run main() when this file is the entry point, not when imported as a module
if (import.meta.main) {
  main();
}
