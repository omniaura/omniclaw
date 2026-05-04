/**
 * Cursor Agents SDK backend — runs agents via @cursor/sdk (local or cloud)
 * instead of the container agent-runner.
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

import { CONTAINER_TIMEOUT, DATA_DIR, GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { assertPathWithin } from '../path-security.js';
import { ContainerProcess } from '../types.js';
import {
  AgentBackend,
  AgentOrGroup,
  ContainerInput,
  ContainerOutput,
  getContainerConfig,
  getFolder,
  getName,
} from './types.js';

function resolveWorkspaceDir(group: AgentOrGroup, input: ContainerInput): string {
  const folder = getFolder(group);
  const workspaceFolder = input.channelFolder || folder;
  return path.resolve(GROUPS_DIR, workspaceFolder);
}

function parseCloudReposEnv():
  | Array<{ url: string; startingRef?: string; prUrl?: string }>
  | undefined {
  const raw = process.env.CURSOR_AGENT_CLOUD_REPOS?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    return parsed as Array<{ url: string; startingRef?: string; prUrl?: string }>;
  } catch {
    logger.warn('CURSOR_AGENT_CLOUD_REPOS is not valid JSON; ignoring cloud mode');
    return undefined;
  }
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
  logger.warn({ name }, 'Skipping MCP server entry: expected url or command');
  return null;
}

function mergeMcpServers(
  input?: Record<string, Record<string, unknown>>,
): Record<string, McpServerConfig> | undefined {
  if (!input || Object.keys(input).length === 0) return undefined;
  const out: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(input)) {
    const cfg = coerceMcpServer(name, raw);
    if (cfg) out[name] = cfg;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function extractAssistantSnippet(msg: SDKMessage): string | null {
  if (msg.type === 'assistant') {
    const parts = msg.message.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text);
    const text = parts.join('').trim();
    return text.length > 0 ? text : null;
  }
  if (msg.type === 'thinking' && msg.text?.trim())
    return `[thinking] ${msg.text.trim().slice(0, 500)}`;
  if (msg.type === 'tool_call')
    return `[tool] ${msg.name} (${msg.status})`;
  return null;
}

async function waitRunWithTimeout(run: Run, timeoutMs: number): Promise<RunResult> {
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

function makeContainerProcess(run: Run): ContainerProcess {
  let killed = false;
  return {
    get killed() {
      return killed;
    },
    pid: process.pid,
    kill(_signal?: number | string) {
      killed = true;
      if (run.supports('cancel')) void run.cancel();
    },
  };
}

export class CursorSdkBackend implements AgentBackend {
  readonly name = 'cursor-sdk' as const;

  private readonly activeCancel = new Map<string, () => Promise<void>>();

  async initialize(): Promise<void> {
    logger.info('Cursor SDK backend initialized (no container probe)');
  }

  async shutdown(): Promise<void> {
    this.activeCancel.clear();
  }

  async runAgent(
    group: AgentOrGroup,
    input: ContainerInput,
    onProcess: (proc: ContainerProcess, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<ContainerOutput> {
    const folder = getFolder(group);
    const runtimeFolder = input.runtimeFolder || folder;
    const groupName = getName(group);
    const log = logger.child({
      op: 'cursorSdkRun',
      group: groupName,
      runtimeFolder,
      backend: this.name,
    });

    const apiKey =
      input.secrets?.CURSOR_API_KEY || process.env.CURSOR_API_KEY?.trim();
    if (!apiKey) {
      return {
        status: 'error',
        result: null,
        error:
          'CURSOR_API_KEY is not set (or passed in input.secrets). Required for backend: cursor-sdk.',
      };
    }

    const modelId =
      process.env.CURSOR_AGENT_MODEL?.trim() || 'composer-2';
    const containerCfg = getContainerConfig(group);
    const timeoutMs = containerCfg?.timeout || CONTAINER_TIMEOUT;
    const cloudRepos = parseCloudReposEnv();

    const mcpServers = mergeMcpServers(input.mcpServers);

    const baseOptions = cloudRepos?.length
      ? {
          apiKey,
          model: { id: modelId },
          cloud: {
            repos: cloudRepos,
            skipReviewerRequest:
              process.env.CURSOR_CLOUD_SKIP_REVIEWER_REQUEST !== 'false',
          },
          mcpServers,
          name: input.agentName || groupName,
        }
      : {
          apiKey,
          model: { id: modelId },
          local: {
            cwd: resolveWorkspaceDir(group, input),
            settingSources: [],
          },
          mcpServers,
          name: input.agentName || groupName,
        };

    let sdkAgent: SDKAgent | undefined;
    try {
      if (input.sessionId) {
        try {
          sdkAgent = await Agent.resume(input.sessionId, baseOptions);
        } catch (err) {
          if (err instanceof CursorAgentError) {
            log.warn(
              { err: err.message, sessionId: input.sessionId },
              'Agent.resume failed; starting a new Cursor agent',
            );
            sdkAgent = await Agent.create(baseOptions);
          } else {
            throw err;
          }
        }
      } else {
        sdkAgent = await Agent.create(baseOptions);
      }

      const run = await sdkAgent.send(input.prompt);

      this.activeCancel.set(runtimeFolder, () =>
        run.supports('cancel') ? run.cancel() : Promise.resolve(),
      );

      onProcess(makeContainerProcess(run), `cursor-sdk:${runtimeFolder}`);

      let streamedText = '';

      try {
        for await (const msg of run.stream()) {
          const snippet = extractAssistantSnippet(msg);
          if (snippet && onOutput) {
            streamedText =
              msg.type === 'assistant' ? snippet : streamedText + '\n' + snippet;
            await onOutput({
              status: 'success',
              result: snippet,
              intermediate: true,
              chatJid: input.chatJid,
            });
          }
        }
      } catch (streamErr) {
        log.warn({ err: streamErr }, 'Cursor run stream ended with error');
      }

      let result: RunResult;
      try {
        result = await waitRunWithTimeout(run, timeoutMs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err: message }, 'Cursor run failed or timed out');
        return {
          status: 'error',
          result: null,
          error: message,
        };
      } finally {
        this.activeCancel.delete(runtimeFolder);
      }

      if (result.status === 'finished') {
        const text =
          (result.result && result.result.trim()) ||
          streamedText.trim() ||
          null;
        if (onOutput) {
          await onOutput({
            status: 'success',
            result: text,
            intermediate: false,
            newSessionId: sdkAgent.agentId,
            chatJid: input.chatJid,
          });
        }
        return {
          status: 'success',
          result: text,
          newSessionId: sdkAgent.agentId,
        };
      }

      const errDetail = result.result?.trim() || `run status: ${result.status}`;
      if (onOutput) {
        await onOutput({
          status: 'error',
          result: null,
          error: errDetail,
          chatJid: input.chatJid,
        });
      }
      return {
        status: 'error',
        result: null,
        error: errDetail,
      };
    } catch (err) {
      if (err instanceof CursorAgentError) {
        log.error(
          { err: err.message, retryable: err.isRetryable },
          'Cursor SDK startup error',
        );
        return {
          status: 'error',
          result: null,
          error: `Cursor SDK: ${err.message}`,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, 'Cursor SDK unexpected error');
      return {
        status: 'error',
        result: null,
        error: message,
      };
    } finally {
      this.activeCancel.delete(runtimeFolder);
      if (sdkAgent) {
        await sdkAgent[Symbol.asyncDispose]().catch((e) => {
          log.warn({ err: e }, 'Cursor agent dispose failed');
        });
      }
    }
  }

  /**
   * Cursor runs are single-shot per runAgent; there is no long-lived runner
   * polling IPC. New user messages are batched into the next run (session is
   * resumed via stored Cursor agent id).
   */
  sendMessage(): boolean {
    return false;
  }

  closeStdin(groupFolder: string, inputSubdir?: string): void {
    void inputSubdir;
    const cancel = this.activeCancel.get(groupFolder);
    if (cancel) void cancel();
  }

  writeIpcData(groupFolder: string, filename: string, data: string): void {
    const ipcBase = path.join(DATA_DIR, 'ipc');
    const groupIpcDir = path.join(ipcBase, groupFolder);
    assertPathWithin(groupIpcDir, ipcBase, 'writeIpcData');
    const filePath = path.join(groupIpcDir, filename);
    assertPathWithin(filePath, groupIpcDir, 'writeIpcData filename');
    fs.mkdirSync(groupIpcDir, { recursive: true });
    fs.writeFileSync(filePath, data);
  }

  async readFile(
    groupFolder: string,
    relativePath: string,
  ): Promise<Buffer | null> {
    const groupDir = path.join(GROUPS_DIR, groupFolder);
    const fullPath = path.join(groupDir, relativePath);
    assertPathWithin(fullPath, groupDir, 'readFile');
    try {
      return fs.readFileSync(fullPath);
    } catch {
      return null;
    }
  }

  async writeFile(
    groupFolder: string,
    relativePath: string,
    content: Buffer | string,
  ): Promise<void> {
    const groupDir = path.join(GROUPS_DIR, groupFolder);
    const fullPath = path.join(groupDir, relativePath);
    assertPathWithin(fullPath, groupDir, 'writeFile');
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}
