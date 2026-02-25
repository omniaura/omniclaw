/**
 * OpenCode Backend for OmniClaw
 * Runs agents using the OpenCode SDK (https://opencode.ai).
 *
 * Instead of running the Claude Agent SDK inside a container, this backend
 * starts an OpenCode server per group and uses its SDK to manage sessions
 * and send prompts. OpenCode handles its own tool execution (bash, file ops,
 * etc.) natively.
 *
 * This enables heterogeneous agent architectures — Claude Code and OpenCode
 * agents running side by side, communicating via OmniClaw's IPC.
 */

import fs from 'fs';
import path from 'path';

import {
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
} from '../config.js';
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

// OpenCode backend configuration (env vars)
const OPENCODE_PORT_BASE = parseInt(process.env.OPENCODE_PORT_BASE || '14096', 10);
const OPENCODE_MODEL = process.env.OPENCODE_MODEL || '';

/** Track port assignments per group to avoid conflicts. */
let nextPort = OPENCODE_PORT_BASE;

interface OpenCodeInstance {
  client: any;
  port: number;
  cleanup?: () => void;
  sessionId?: string;
  groupFolder: string;
}

/**
 * Wraps an OpenCode instance as a ContainerProcess.
 * Since OpenCode runs as a local server, we track its lifecycle here.
 */
class OpenCodeProcessWrapper implements ContainerProcess {
  private _killed = false;
  private instance: OpenCodeInstance;

  constructor(instance: OpenCodeInstance) {
    this.instance = instance;
  }

  get killed(): boolean {
    return this._killed;
  }

  kill(): void {
    if (this._killed) return;
    this._killed = true;
    try {
      this.instance.cleanup?.();
    } catch (err) {
      logger.warn({ err, group: this.instance.groupFolder }, 'Failed to stop OpenCode instance');
    }
  }

  get pid(): number {
    return 0; // OpenCode SDK manages its own process
  }
}

export class OpenCodeBackend implements AgentBackend {
  readonly name = 'opencode';
  private instances = new Map<string, OpenCodeInstance>();

  /**
   * Get or create an OpenCode client for a group.
   * Each group gets its own OpenCode server running in its workspace directory.
   */
  private async getInstance(groupFolder: string): Promise<OpenCodeInstance> {
    const cached = this.instances.get(groupFolder);
    if (cached) {
      // Verify server is still alive
      try {
        await cached.client.global.health();
        return cached;
      } catch {
        logger.info({ group: groupFolder }, 'OpenCode server no longer responsive, restarting');
        this.instances.delete(groupFolder);
        try { cached.cleanup?.(); } catch { /* ignore */ }
      }
    }

    const port = nextPort++;
    const groupDir = path.join(GROUPS_DIR, groupFolder);
    fs.mkdirSync(groupDir, { recursive: true });

    logger.info(
      { group: groupFolder, port, cwd: groupDir },
      'Starting OpenCode server',
    );

    // Lazy-load the SDK to avoid hard dependency when backend isn't used
    const { createOpencode } = await import(/* webpackIgnore: true */ '@opencode-ai/sdk' as string);

    const config: Record<string, unknown> = {};
    if (OPENCODE_MODEL) {
      config.model = OPENCODE_MODEL;
    }

    const opencode = await createOpencode({
      port,
      hostname: '127.0.0.1',
      timeout: 30_000,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    });

    const instance: OpenCodeInstance = {
      client: opencode.client,
      port,
      cleanup: (opencode as any).cleanup || (opencode as any).close || undefined,
      groupFolder,
    };

    this.instances.set(groupFolder, instance);
    return instance;
  }

  async runAgent(
    group: AgentOrGroup,
    input: ContainerInput,
    onProcess: (proc: ContainerProcess, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<ContainerOutput> {
    const startTime = Date.now();
    const folder = getFolder(group);
    const groupName = getName(group);
    const containerCfg = getContainerConfig(group);
    const configTimeout = containerCfg?.timeout || CONTAINER_TIMEOUT;

    logger.info(
      { group: groupName, backend: 'opencode', isMain: input.isMain },
      'Running agent on OpenCode',
    );

    let instance: OpenCodeInstance;
    try {
      instance = await this.getInstance(folder);
    } catch (err) {
      logger.error({ group: groupName, error: err }, 'Failed to start OpenCode server');
      return {
        status: 'error',
        result: null,
        error: `Failed to start OpenCode server: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Create process wrapper and notify orchestrator
    const processWrapper = new OpenCodeProcessWrapper(instance);
    const containerName = `opencode-${folder}-${Date.now()}`;
    onProcess(processWrapper, containerName);

    // Set up IPC directories for this group
    const groupIpcDir = path.join(DATA_DIR, 'ipc', folder);
    for (const sub of ['messages', 'tasks', 'input', 'input-task']) {
      fs.mkdirSync(path.join(groupIpcDir, sub), { recursive: true });
    }

    try {
      // Create or reuse session
      let sessionId: string;
      if (input.sessionId) {
        try {
          const existing = await instance.client.session.get({ path: { id: input.sessionId } });
          sessionId = existing.data?.id || input.sessionId;
        } catch {
          // Session not found — create new
          const newSession = await instance.client.session.create({ body: {} });
          sessionId = newSession.data?.id;
        }
      } else {
        const newSession = await instance.client.session.create({ body: {} });
        sessionId = newSession.data?.id;
      }

      instance.sessionId = sessionId;

      // Inject system context (CLAUDE.md, etc.) as a no-reply prompt
      const systemContext = this.buildSystemContext(group, input);
      if (systemContext) {
        await instance.client.session.prompt({
          path: { id: sessionId },
          body: {
            noReply: true,
            parts: [{ type: 'text', text: systemContext }],
          },
        });
      }

      // Send the actual prompt with a timeout
      const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);
      const result = await Promise.race([
        instance.client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [{ type: 'text', text: input.prompt }],
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`OpenCode agent timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);

      const duration = Date.now() - startTime;

      // Extract response text from the result
      const responseText = this.extractResponseText(result);

      logger.info(
        { group: groupName, duration, sessionId, hasResult: !!responseText },
        'OpenCode agent completed',
      );

      const output: ContainerOutput = {
        status: 'success',
        result: responseText,
        newSessionId: sessionId,
      };

      if (onOutput) {
        await onOutput(output);
        return { status: 'success', result: null, newSessionId: sessionId };
      }

      return output;
    } catch (err) {
      const duration = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);

      logger.error(
        { group: groupName, duration, error: errorMessage },
        'OpenCode agent error',
      );

      return {
        status: 'error',
        result: null,
        error: `OpenCode agent error: ${errorMessage}`,
      };
    }
  }

  /**
   * Build system context from CLAUDE.md and other group-specific config.
   */
  private buildSystemContext(group: AgentOrGroup, input: ContainerInput): string | null {
    const parts: string[] = [];

    // Group CLAUDE.md
    const groupClaudeMd = path.join(GROUPS_DIR, group.folder, 'CLAUDE.md');
    if (fs.existsSync(groupClaudeMd)) {
      parts.push(fs.readFileSync(groupClaudeMd, 'utf-8'));
    }

    // Global CLAUDE.md (non-main only)
    if (!input.isMain) {
      const globalClaudeMd = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
      if (fs.existsSync(globalClaudeMd)) {
        parts.push(fs.readFileSync(globalClaudeMd, 'utf-8'));
      }
    }

    if (parts.length === 0) return null;
    return parts.join('\n\n---\n\n');
  }

  /**
   * Extract the response text from an OpenCode SDK prompt result.
   * The SDK response shape may vary — try common patterns.
   */
  private extractResponseText(result: any): string | null {
    if (!result) return null;

    // Direct text field
    if (result.data?.text) return result.data.text;
    if (result.data?.content) {
      if (typeof result.data.content === 'string') return result.data.content;
    }

    // Structured output
    if (result.data?.info?.structured_output) {
      return JSON.stringify(result.data.info.structured_output);
    }

    // Message parts array
    if (result.data?.parts) {
      const textParts = result.data.parts
        .filter((p: any) => p.type === 'text')
        .map((p: any) => p.text);
      if (textParts.length > 0) return textParts.join('\n');
    }

    // Messages array (last assistant message)
    if (result.data?.messages) {
      const msgs = result.data.messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
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

    logger.debug(
      { resultKeys: Object.keys(result.data || {}) },
      'Unknown OpenCode result shape',
    );
    return null;
  }

  sendMessage(groupFolder: string, text: string, opts?: { chatJid?: string }): boolean {
    const instance = this.instances.get(groupFolder);
    if (instance?.sessionId) {
      // Send directly via the OpenCode SDK
      instance.client.session.prompt({
        path: { id: instance.sessionId },
        body: {
          parts: [{ type: 'text', text }],
        },
      }).catch((err: Error) => {
        logger.warn({ groupFolder, error: err.message }, 'Failed to send message via OpenCode SDK, falling back to IPC file');
        this.sendMessageViaFile(groupFolder, text, opts);
      });
      return true;
    }

    // Fall back to IPC file method
    return this.sendMessageViaFile(groupFolder, text, opts);
  }

  private sendMessageViaFile(groupFolder: string, text: string, opts?: { chatJid?: string }): boolean {
    const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({
        type: 'message',
        text,
        ...(opts?.chatJid ? { chatJid: opts.chatJid } : {}),
      }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  closeStdin(groupFolder: string, inputSubdir: string = 'input'): void {
    const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, inputSubdir);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  writeIpcData(groupFolder: string, filename: string, data: string): void {
    const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
    fs.mkdirSync(groupIpcDir, { recursive: true });
    fs.writeFileSync(path.join(groupIpcDir, filename), data);
  }

  async readFile(groupFolder: string, relativePath: string): Promise<Buffer | null> {
    const groupDir = path.join(GROUPS_DIR, groupFolder);
    const fullPath = path.join(groupDir, relativePath);
    assertPathWithin(fullPath, groupDir, 'readFile');
    try {
      return fs.readFileSync(fullPath);
    } catch {
      return null;
    }
  }

  async writeFile(groupFolder: string, relativePath: string, content: Buffer | string): Promise<void> {
    const groupDir = path.join(GROUPS_DIR, groupFolder);
    const fullPath = path.join(groupDir, relativePath);
    assertPathWithin(fullPath, groupDir, 'writeFile');
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  async initialize(): Promise<void> {
    // Verify opencode SDK is available
    try {
      await import(/* webpackIgnore: true */ '@opencode-ai/sdk' as string);
      logger.info('OpenCode backend initialized (SDK available)');
    } catch {
      logger.warn(
        'OpenCode SDK (@opencode-ai/sdk) not installed. ' +
        'Run `bun add @opencode-ai/sdk` to enable this backend.',
      );
    }
  }

  async shutdown(): Promise<void> {
    // Stop all running OpenCode servers
    for (const [folder, instance] of this.instances) {
      try {
        instance.cleanup?.();
        logger.debug({ group: folder }, 'Stopped OpenCode server');
      } catch (err) {
        logger.warn({ group: folder, error: err }, 'Error stopping OpenCode server');
      }
    }
    this.instances.clear();
    logger.info('OpenCode backend shutdown');
  }
}
