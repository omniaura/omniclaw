/**
 * Cursor Agents SDK runtime (container-side).
 *
 * Runs @cursor/sdk inside the OmniClaw agent container with the same workspace
 * mounts and IPC protocol as Claude/OpenCode/Codex — isolation matches other backends.
 */

import fs from 'fs';
import path from 'path';

import {
  Agent,
  CursorAgentError,
  type McpServerConfig,
  type Run,
  type RunResult,
  type SDKAgent,
  type SDKMessage,
} from '@cursor/sdk';

import type {
  ChannelInfo,
  ContainerInput,
  ContainerOutput,
  IpcDrainResult,
  IpcMessage,
} from '@omniclaw/protocol';

const OUTPUT_START_MARKER = '---OMNICLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---OMNICLAW_OUTPUT_END---';
const IPC_POLL_MS = 500;
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;

function workspaceGroup(): string {
  return process.env.AGENT_WORKSPACE || '/workspace/group';
}

function log(message: string): void {
  console.error(`[cursor-sdk-runtime] ${message}`);
}

function writeOutput(output: ContainerOutput, chatJid: string): void {
  const enriched = chatJid ? { ...output, chatJid } : output;
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(enriched));
  console.log(OUTPUT_END_MARKER);
}

function resolveIpcInputDir(isScheduledTask?: boolean): string {
  const ipcDir = process.env.AGENT_IPC_DIR || '/workspace/ipc';
  return isScheduledTask ? `${ipcDir}/input-task` : `${ipcDir}/input`;
}

function resolveCurrentChatFile(): string {
  return (
    process.env.OMNICLAW_CURRENT_CHAT_FILE ||
    path.join('/tmp', `current_chat_jid-${process.pid}`)
  );
}

let ipcInputDir = resolveIpcInputDir(false);
let currentChatJid = '';
const currentChatFile = resolveCurrentChatFile();

function setCurrentChat(chatJid: string): void {
  currentChatJid = chatJid;
  try {
    fs.writeFileSync(currentChatFile, chatJid);
  } catch {
    /* ignore */
  }
}

function drainIpcInput(): IpcDrainResult {
  try {
    fs.mkdirSync(ipcInputDir, { recursive: true });
    const files = fs
      .readdirSync(ipcInputDir)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: IpcMessage[] = [];
    let shutdown = false;
    for (const file of files) {
      const filePath = path.join(ipcInputDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'shutdown') {
          log('Shutdown IPC message received');
          shutdown = true;
          continue;
        }
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
    const legacyClose = path.join(ipcInputDir, '_close');
    if (fs.existsSync(legacyClose)) {
      try {
        fs.unlinkSync(legacyClose);
      } catch {
        /* ignore */
      }
      log('Legacy _close sentinel detected, treating as shutdown');
      shutdown = true;
    }
    return { messages, shutdown };
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return { messages: [], shutdown: false };
  }
}

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
      log(
        `Failed to parse OMNICLAW_CHANNELS: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return lookup;
}

const channelNames = getChannelNameLookup();
const isMultiChannel = channelNames.size > 1;

function formatIpcMessages(messages: IpcMessage[]): string {
  if (!isMultiChannel) {
    return messages.map((m) => m.text).join('\n');
  }
  return messages
    .map((m) => {
      if (m.chatJid) {
        const channelName = channelNames.get(m.chatJid) || m.chatJid;
        return `[From: ${channelName}]\n${m.text}`;
      }
      return m.text;
    })
    .join('\n');
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      const { messages, shutdown } = drainIpcInput();
      if (shutdown) {
        resolve(null);
        return;
      }
      if (messages.length > 0) {
        resolve(formatIpcMessages(messages));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function coerceMcpServer(
  name: string,
  raw: Record<string, unknown>,
): McpServerConfig | null {
  if (typeof raw.url === 'string') {
    const t = raw.type;
    const type =
      t === 'http' || t === 'sse'
        ? t
        : typeof raw.transport === 'string' && raw.transport === 'sse'
          ? 'sse'
          : 'http';
    return {
      type,
      url: raw.url,
      headers: raw.headers as Record<string, string> | undefined,
    };
  }
  if (typeof raw.command === 'string') {
    return {
      type: 'stdio',
      command: raw.command,
      args: raw.args as string[] | undefined,
      env: raw.env as Record<string, string> | undefined,
      cwd: raw.cwd as string | undefined,
    };
  }
  log(`Skipping MCP server '${name}': expected url or command`);
  return null;
}

function mergeUserMcpServers(
  input?: Record<string, Record<string, unknown>>,
): Record<string, McpServerConfig> | undefined {
  if (!input || Object.keys(input).length === 0) return undefined;
  const out: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(input)) {
    if (name === 'omniclaw') continue;
    const cfg = coerceMcpServer(name, raw);
    if (cfg) out[name] = cfg;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseCloudRepos():
  | Array<{ url: string; startingRef?: string; prUrl?: string }>
  | undefined {
  const raw = process.env.CURSOR_AGENT_CLOUD_REPOS?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    return parsed as Array<{
      url: string;
      startingRef?: string;
      prUrl?: string;
    }>;
  } catch {
    log('CURSOR_AGENT_CLOUD_REPOS is not valid JSON; ignoring cloud mode');
    return undefined;
  }
}

function extractAssistantSnippet(msg: SDKMessage): string | null {
  if (msg.type === 'assistant') {
    const parts = msg.message.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text);
    const text = parts.join('').trim();
    return text.length > 0 ? text : null;
  }
  if (msg.type === 'thinking' && msg.text?.trim()) {
    return `[thinking] ${msg.text.trim().slice(0, 500)}`;
  }
  if (msg.type === 'tool_call') {
    return `[tool] ${msg.name} (${msg.status})`;
  }
  return null;
}

async function waitRunWithTimeout(
  run: Run,
  timeoutMs: number,
): Promise<RunResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<RunResult>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Cursor agent timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([run.wait(), timeoutPromise]);
    if (timer) clearTimeout(timer);
    return result;
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (run.supports('cancel')) await run.cancel().catch(() => {});
    throw err;
  }
}

function makeContainerProcess(run: Run): { kill(): void } {
  return {
    kill() {
      if (run.supports('cancel')) void run.cancel();
    },
  };
}

function buildAgentOptions(
  apiKey: string,
  mcpServers: Record<string, McpServerConfig>,
  agentName: string,
): Parameters<typeof Agent.create>[0] {
  const modelId = process.env.CURSOR_AGENT_MODEL?.trim() || 'composer-2';
  const cloudRepos = parseCloudRepos();

  if (cloudRepos?.length) {
    return {
      apiKey,
      model: { id: modelId },
      cloud: {
        repos: cloudRepos,
        skipReviewerRequest:
          process.env.CURSOR_CLOUD_SKIP_REVIEWER_REQUEST !== 'false',
      },
      mcpServers,
      name: agentName,
    };
  }

  return {
    apiKey,
    model: { id: modelId },
    local: {
      cwd: workspaceGroup(),
      settingSources: [],
    },
    mcpServers,
    name: agentName,
  };
}

export async function runCursorSdkRuntime(
  containerInput: ContainerInput,
): Promise<void> {
  log(`Starting Cursor SDK runtime for group: ${containerInput.groupFolder}`);

  if (containerInput.isScheduledTask) {
    ipcInputDir = resolveIpcInputDir(true);
    log(`Using task IPC lane: ${ipcInputDir}`);
  }
  fs.mkdirSync(ipcInputDir, { recursive: true });

  setCurrentChat(containerInput.chatJid);

  const apiKey =
    containerInput.secrets?.CURSOR_API_KEY?.trim() ||
    process.env.CURSOR_API_KEY?.trim();
  if (!apiKey) {
    writeOutput(
      {
        status: 'error',
        result: null,
        error:
          'CURSOR_API_KEY is not set (add to host .env or container secrets).',
      },
      currentChatJid,
    );
    process.exit(1);
  }

  const groupFolder = workspaceGroup();
  const mcpServerPath = path.join(import.meta.dir, 'ipc-mcp-stdio.ts');
  const ipcRoot = process.env.AGENT_IPC_DIR || '/workspace/ipc';

  const omniclawMcp: McpServerConfig = {
    type: 'stdio',
    command: 'bun',
    args: [mcpServerPath],
    env: {
      OMNICLAW_CHAT_JID: containerInput.chatJid,
      OMNICLAW_GROUP_FOLDER: containerInput.groupFolder,
      OMNICLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
      OMNICLAW_IPC_DIR: ipcRoot,
      OMNICLAW_CURRENT_CHAT_FILE: currentChatFile,
      ...(containerInput.discordGuildId
        ? { OMNICLAW_DISCORD_GUILD_ID: containerInput.discordGuildId }
        : {}),
      ...(containerInput.serverFolder
        ? { OMNICLAW_SERVER_FOLDER: containerInput.serverFolder }
        : {}),
      ...(containerInput.channels
        ? { OMNICLAW_CHANNELS: JSON.stringify(containerInput.channels) }
        : {}),
      ...(containerInput.agentName
        ? { OMNICLAW_AGENT_NAME: containerInput.agentName }
        : {}),
      ...(containerInput.discordBotId
        ? { OMNICLAW_AGENT_BOT_ID: containerInput.discordBotId }
        : {}),
      ...(containerInput.agentTrigger
        ? { OMNICLAW_AGENT_TRIGGER: containerInput.agentTrigger }
        : {}),
    },
  };

  const userMcp = mergeUserMcpServers(containerInput.mcpServers);
  const mcpServers: Record<string, McpServerConfig> = {
    omniclaw: omniclawMcp,
    ...(userMcp || {}),
  };

  const agentName =
    containerInput.agentName || containerInput.groupFolder || 'OmniClaw';
  const baseOptions = buildAgentOptions(apiKey, mcpServers, agentName);

  const timeoutMs = DEFAULT_RUN_TIMEOUT_MS;

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const startHeartbeat = () => {
    heartbeatTimer = setInterval(() => {
      writeOutput(
        {
          status: 'success',
          result: null,
          intermediate: true,
        },
        currentChatJid,
      );
      log('heartbeat');
    }, HEARTBEAT_INTERVAL_MS);
  };
  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  let sdkAgent: SDKAgent | undefined;
  try {
    if (containerInput.sessionId) {
      try {
        sdkAgent = await Agent.resume(containerInput.sessionId, baseOptions);
      } catch (err) {
        if (err instanceof CursorAgentError) {
          log(
            `Agent.resume failed (${err.message}); creating new Cursor agent`,
          );
          sdkAgent = await Agent.create(baseOptions);
        } else {
          throw err;
        }
      }
    } else {
      sdkAgent = await Agent.create(baseOptions);
    }

    let prompt = containerInput.prompt;
    if (containerInput.isScheduledTask) {
      prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
    }
    const pending = drainIpcInput();
    if (pending.messages.length > 0) {
      log(
        `Draining ${pending.messages.length} pending IPC messages into initial prompt`,
      );
      prompt += '\n' + formatIpcMessages(pending.messages);
    }

    let sessionId: string | undefined = containerInput.sessionId;

    startHeartbeat();

    while (true) {
      log(
        `Cursor send (session id: ${sessionId || 'new'}, cwd: ${groupFolder})`,
      );

      const run = await sdkAgent.send(prompt);
      const proc = makeContainerProcess(run);
      let ipcPolling = true;
      const pollIpc = () => {
        if (!ipcPolling) return;
        const { messages, shutdown } = drainIpcInput();
        if (shutdown) {
          log('Shutdown during Cursor run');
          ipcPolling = false;
          proc.kill();
          return;
        }
        if (messages.length > 0) {
          log('IPC arrived during Cursor run — will process on next turn');
        }
        setTimeout(pollIpc, IPC_POLL_MS);
      };
      setTimeout(pollIpc, IPC_POLL_MS);

      let streamedText = '';
      try {
        for await (const msg of run.stream()) {
          const snippet = extractAssistantSnippet(msg);
          if (snippet) {
            if (msg.type === 'assistant') streamedText = snippet;
            else
              streamedText = streamedText
                ? `${streamedText}\n${snippet}`
                : snippet;
            writeOutput(
              {
                status: 'success',
                result: snippet,
                intermediate: true,
                newSessionId: sdkAgent.agentId,
              },
              currentChatJid,
            );
          }
        }
      } catch (streamErr) {
        log(
          `Stream ended: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`,
        );
      }

      ipcPolling = false;

      let result: RunResult;
      try {
        result = await waitRunWithTimeout(run, timeoutMs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`Cursor run failed: ${message}`);
        writeOutput(
          {
            status: 'error',
            result: null,
            error: message,
            newSessionId: sdkAgent.agentId,
          },
          currentChatJid,
        );
        stopHeartbeat();
        process.exit(1);
      }

      sessionId = sdkAgent.agentId;

      if (result.status === 'finished') {
        const text =
          (result.result && result.result.trim()) ||
          streamedText.trim() ||
          null;
        writeOutput(
          {
            status: 'success',
            result: text,
            intermediate: false,
            newSessionId: sdkAgent.agentId,
          },
          currentChatJid,
        );
      } else {
        const errDetail =
          result.result?.trim() || `run status: ${result.status}`;
        writeOutput(
          {
            status: 'error',
            result: null,
            error: errDetail,
            newSessionId: sdkAgent.agentId,
          },
          currentChatJid,
        );
        stopHeartbeat();
        process.exit(1);
      }

      writeOutput(
        {
          status: 'success',
          result: null,
          newSessionId: sessionId,
        },
        currentChatJid,
      );

      log('Waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Shutdown received, exiting');
        break;
      }
      prompt = nextMessage;
    }

    stopHeartbeat();
  } catch (err) {
    stopHeartbeat();
    if (err instanceof CursorAgentError) {
      writeOutput(
        {
          status: 'error',
          result: null,
          error: `Cursor SDK: ${err.message}`,
        },
        currentChatJid,
      );
    } else {
      const message = err instanceof Error ? err.message : String(err);
      writeOutput(
        { status: 'error', result: null, error: message },
        currentChatJid,
      );
    }
    process.exit(1);
  } finally {
    stopHeartbeat();
    if (sdkAgent) {
      await sdkAgent[Symbol.asyncDispose]().catch((e) => {
        log(`Dispose: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  }
}
