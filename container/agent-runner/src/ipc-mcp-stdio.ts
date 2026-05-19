/**
 * Stdio MCP Server for OmniClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import {
  buildChannelMaps,
  buildSendMessageChannelDescription,
  resolveSendMessageTarget,
} from './send-message-routing.js';

const IPC_DIR = process.env.OMNICLAW_IPC_DIR || '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESPONSES_DIR = path.join(IPC_DIR, 'responses');
const USER_REGISTRY_PATH = path.join(IPC_DIR, 'user_registry.json');
const taskWorkflowsDir =
  process.env.OMNICLAW_TASK_WORKFLOWS_DIR || 'task-workflows';
const taskWorkflowsPath = `/workspace/group/${taskWorkflowsDir.replace(/^\/+/, '').replace(/\/+$/, '')}/`;

// Context from environment variables (set by the agent runner)
const initialChatJid = process.env.OMNICLAW_CHAT_JID!;
const originChatJid = process.env.OMNICLAW_ORIGIN_CHAT_JID || initialChatJid;
const groupFolder = process.env.OMNICLAW_GROUP_FOLDER!;
const isMain = process.env.OMNICLAW_IS_MAIN === '1';
const currentChatFile =
  process.env.OMNICLAW_CURRENT_CHAT_FILE ||
  path.join('/tmp', `current_chat_jid-${process.ppid || process.pid}`);

// Shared protocol types — import type only (erased at runtime, no module needed in container).
import type { ChannelInfo } from '@omniclaw/protocol';
const channelsEnv = process.env.OMNICLAW_CHANNELS;
const channels: ChannelInfo[] = channelsEnv
  ? (() => {
      try {
        return JSON.parse(channelsEnv);
      } catch {
        return [];
      }
    })()
  : [];
const isMultiChannel = channels.length > 1;

const { channelByJid } = buildChannelMaps(channels);

// For backwards compatibility, chatJid is a getter
const chatJid = initialChatJid;

// User registry for mention formatting (Issue #66)
interface UserInfo {
  id: string;
  name: string;
  platform: 'discord' | 'whatsapp' | 'telegram';
  lastSeen: string;
}

type UserRegistry = Record<string, UserInfo>;

function loadUserRegistry(): UserRegistry {
  try {
    if (fs.existsSync(USER_REGISTRY_PATH)) {
      const data = fs.readFileSync(USER_REGISTRY_PATH, 'utf-8');
      return JSON.parse(data) as UserRegistry;
    }
  } catch (error) {
    console.error('Failed to load user registry:', error);
  }
  return {};
}

function writeIpcFile(dir: string, data: object): string {
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;

  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, filename);
  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

function sanitizeRequestId(requestId: string): string {
  return requestId.replace(/[^a-zA-Z0-9_-]/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForResponse(
  requestId: string,
  timeoutMs = 3000,
): Promise<Record<string, unknown> | null> {
  const safeRequestId = sanitizeRequestId(requestId);
  if (!safeRequestId) return null;

  const responsePath = path.join(RESPONSES_DIR, `${safeRequestId}.json`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      try {
        const payload = JSON.parse(
          fs.readFileSync(responsePath, 'utf-8'),
        ) as Record<string, unknown>;
        fs.rmSync(responsePath, { force: true });
        return payload;
      } catch {
        fs.rmSync(responsePath, { force: true });
        return null;
      }
    }
    await sleep(50);
  }

  return null;
}

/** Check task ownership from the snapshot. Returns an error response if the
 *  caller lacks permission, or an ownerWarning string (may be empty) if allowed. */
function checkTaskOwnership(
  taskId: string,
  action: 'update' | 'cancel',
):
  | { allowed: true; ownerWarning: string }
  | {
      allowed: false;
      response: { content: [{ type: 'text'; text: string }]; isError: true };
    } {
  const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
  try {
    if (fs.existsSync(tasksFile)) {
      const raw = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
      if (Array.isArray(raw)) {
        const task = raw.find((t: { id: string }) => t.id === taskId);
        if (task) {
          const taskOwner = task.groupFolder ?? 'unknown';
          if (taskOwner !== groupFolder) {
            if (!isMain) {
              return {
                allowed: false,
                response: {
                  content: [
                    {
                      type: 'text' as const,
                      text: `Cannot ${action} task ${taskId}: it belongs to "${taskOwner}", not "${groupFolder}". Only the owning group or the main agent can ${action} a task.`,
                    },
                  ],
                  isError: true,
                },
              };
            }
            return {
              allowed: true,
              ownerWarning: ` WARNING: This task belongs to "${taskOwner}", not "${groupFolder}".`,
            };
          }
        }
      }
    }
  } catch {
    /* proceed — server will do final auth check */
  }
  return { allowed: true, ownerWarning: '' };
}

const server = new McpServer({
  name: 'omniclaw',
  version: '1.0.0',
});

// Build send_message description with channel info for multi-channel agents
const channelListDesc = isMultiChannel
  ? buildSendMessageChannelDescription(channels)
  : '';

server.tool(
  'send_message',
  `Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. To message another agent, use the "sendTo" field from /workspace/ipc/agent_registry.json — it tells you exactly what target_jid to use and whether to prefix the message with their trigger word. Never use an agent's id or folder name as target_jid.

IMPORTANT: Your final text response is ALSO sent to the user automatically. If send_message already contains your complete response, stay silent afterwards — wrap any remaining acknowledgment (e.g. "Done!", "Sent!") in <internal> tags so it isn't delivered as a duplicate message.

Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.

Recommended: omit target_jid to reply in the channel that started this turn. Only set target_jid when intentionally delegating to another channel or agent.${channelListDesc}`,
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
    target_jid: z
      .string()
      .optional()
      .describe(
        isMultiChannel
          ? 'Target channel or agent. Accepts channel name, channel ID, or full JID. Omit to reply in the channel that started this turn.'
          : 'Send to a different group/agent by JID. Check /workspace/ipc/agent_registry.json for available targets. Omit to reply in the channel that started this turn.',
      ),
  },
  async (args) => {
    const rawTarget = args.target_jid;
    const { targetJid, currentChatJid, targetWasExplicit } =
      resolveSendMessageTarget(rawTarget, {
        channels,
        currentChatFile,
        initialChatJid,
        originChatJid,
      });

    const data: Record<string, string | boolean | undefined> = {
      type: 'message',
      chatJid: targetJid,
      originChatJid,
      currentChatJid,
      targetWasExplicit,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      discord_bot_id: process.env.OMNICLAW_AGENT_BOT_ID || undefined,
      timestamp: new Date().toISOString(),
    };

    console.error(
      `[omniclaw] send_message target=${targetJid} origin=${originChatJid} current=${currentChatJid} explicit=${targetWasExplicit}`,
    );

    writeIpcFile(MESSAGES_DIR, data);

    const channelName = channelByJid.get(targetJid)?.name;
    const targetDesc =
      channelName || (targetJid !== originChatJid ? targetJid : '');
    return {
      content: [
        {
          type: 'text' as const,
          text: `Message sent${targetDesc ? ` to ${targetDesc}` : ''}. If this was your final response, stay silent — wrap any remaining text in <internal> tags to avoid a duplicate.`,
        },
      ],
    };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

DETERMINISTIC PREPROCESSING - For recurring maintenance tasks that can be cheaply triaged in code, write a TypeScript workflow file under ${taskWorkflowsPath} and pass preprocess_script as its relative path. The script receives JSON on stdin: { task, repoRoot, workflowsDir, now }. It runs with Bun on the host using a minimal env, so it should not rely on API tokens. Write one JSON result as the last stdout line or prefixed with OMNICLAW_TASK_PREPROCESSOR_RESULT=: {"action":"skip","reason":"no diff"}, {"action":"run","promptPrefix":"..."}, or {"action":"error","message":"..."}. Use this to avoid spending agent tokens on no-op checks.

IMPORTANT: When MODIFYING an existing task, use update_task — it edits the task in place while preserving its ID and run history. Only use cancel_task to destructively delete a task the user no longer wants. Unlike pausing, the task cannot be restored on deletion.

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    preprocess_script: z
      .string()
      .optional()
      .describe(
        `Optional relative path under ${taskWorkflowsPath} to a JS/TS workflow that runs before the agent and returns JSON to skip or augment the prompt.`,
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid
        ? args.target_group_jid
        : getCurrentChatJid();

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      preprocess_script: args.preprocess_script,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  'List scheduled tasks for the current context. Shows task ownership so you can identify which group/agent each task belongs to.',
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            groupFolder?: string;
            prompt: string;
            preprocess_script?: string | null;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) => {
            const owner = t.groupFolder ?? 'unknown';
            const ownerLabel =
              owner === groupFolder ? `${owner} (yours)` : owner;
            const promptPreview =
              t.prompt.length > 50 ? `${t.prompt.slice(0, 50)}...` : t.prompt;
            const preprocessor = t.preprocess_script
              ? `, preprocess: ${t.preprocess_script}`
              : '';
            return `- [${t.id}] (owner: ${ownerLabel}) ${promptPreview} (${t.schedule_type}: ${t.schedule_value}${preprocessor}) - ${t.status}, next: ${t.next_run || 'N/A'}`;
          },
        )
        .join('\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: `Scheduled tasks (current group: ${groupFolder}):\n${formatted}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'update_task',
  `Update an existing scheduled task. Change its prompt, schedule, and/or status (active/paused). The task keeps the same ID and run history.

Examples:
- update_task({ task_id: "...", prompt: "new instructions" })
- update_task({ task_id: "...", preprocess_script: "sync-connectors.ts" })
- update_task({ task_id: "...", schedule_type: "cron", schedule_value: "0 9 * * *" })
- update_task({ task_id: "...", status: "paused" })
- update_task({ task_id: "...", status: "active" })`,
  {
    task_id: z.string().describe('ID of the task to update'),
    prompt: z.string().optional().describe('New instructions for the task'),
    preprocess_script: z
      .string()
      .nullable()
      .optional()
      .describe(
        `Set or clear the relative ${taskWorkflowsPath} script that runs before the agent. Pass null to clear it.`,
      ),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional(),
    schedule_value: z
      .string()
      .optional()
      .describe('New cron expression, interval ms, or ISO timestamp'),
    status: z
      .enum(['active', 'paused'])
      .optional()
      .describe('Pause or resume the task'),
    context_mode: z
      .enum(['group', 'isolated'])
      .optional()
      .describe(
        'group=runs with chat history and memory, isolated=fresh session',
      ),
  },
  async (args) => {
    if (
      !args.prompt &&
      args.preprocess_script === undefined &&
      !args.schedule_type &&
      !args.schedule_value &&
      !args.status &&
      !args.context_mode
    ) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'At least one of prompt, preprocess_script, schedule_type, schedule_value, status, or context_mode must be provided.',
          },
        ],
        isError: true,
      };
    }

    // Require schedule_value when schedule_type changes to avoid type/format mismatch
    if (args.schedule_type && !args.schedule_value) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `When changing schedule_type to "${args.schedule_type}", you must also provide schedule_value so the format matches.`,
          },
        ],
        isError: true,
      };
    }

    // Validate schedule fields if provided
    if (args.schedule_type === 'cron' && args.schedule_value) {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once' && args.schedule_value) {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    const ownerCheck = checkTaskOwnership(args.task_id, 'update');
    if (!ownerCheck.allowed) return ownerCheck.response;
    const { ownerWarning } = ownerCheck;

    const data = {
      type: 'edit_task',
      taskId: args.task_id,
      prompt: args.prompt,
      preprocess_script: args.preprocess_script,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      status: args.status,
      context_mode: args.context_mode,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const changed: string[] = [];
    if (args.prompt) changed.push('prompt');
    if (args.preprocess_script !== undefined) changed.push('preprocess_script');
    if (args.schedule_type || args.schedule_value) changed.push('schedule');
    if (args.status) changed.push(`status → ${args.status}`);
    if (args.context_mode) changed.push(`context_mode → ${args.context_mode}`);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested (changed: ${changed.join(', ')}).${ownerWarning}`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task. Non-main agents can only cancel their own tasks.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const ownerCheck = checkTaskOwnership(args.task_id, 'cancel');
    if (!ownerCheck.allowed) return ownerCheck.response;
    const { ownerWarning } = ownerCheck;

    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.${ownerWarning}`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat"). For Discord channels, provide the discord_guild_id to enable server-level shared context.

Backend options: "apple-container" (local VM, default), "docker" (Docker container).`,
  {
    jid: z
      .string()
      .describe(
        'The group JID (e.g., "120363336345536173@g.us" for WhatsApp, "dc:123456" for Discord)',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9_-]*$/,
        'Folder must be lowercase alphanumeric with hyphens/underscores',
      )
      .max(64, 'Folder name must be 64 characters or fewer')
      .describe(
        'Folder name for group files (lowercase, hyphens, e.g., "family-chat")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    discord_guild_id: z
      .string()
      .optional()
      .describe(
        'Discord guild/server ID — enables server-level shared context across channels',
      ),
    backend: z
      .enum(['apple-container', 'docker'])
      .optional()
      .describe('Backend to run this agent on (default: apple-container)'),
    description: z
      .string()
      .optional()
      .describe(
        'What this agent does (shown in agent registry, helps other agents route requests)',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data: Record<string, string | undefined> = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      discord_guild_id: args.discord_guild_id,
      backend: args.backend,
      group_description: args.description,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const backendInfo = args.backend ? ` (backend: ${args.backend})` : '';
    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered${backendInfo}. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

server.tool(
  'list_agents',
  `List all registered agents in the OmniClaw system. Use this to discover available agents for communication.

Returns information about each agent including their ID, name, description, backend type, and JID (for messaging).
This is useful when you need to send messages to specific agents or request context from them.`,
  {
    filter_backend: z
      .enum(['apple-container', 'docker'])
      .optional()
      .describe('Optional: filter agents by backend type'),
    include_self: z
      .boolean()
      .default(true)
      .describe('Include the current agent in results (default: true)'),
  },
  async (args) => {
    const registryPath = path.join(IPC_DIR, 'agent_registry.json');

    try {
      if (!fs.existsSync(registryPath)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Agent registry not found. No agents registered yet.',
            },
          ],
        };
      }

      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));

      if (!Array.isArray(registry) || registry.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No agents found in registry.',
            },
          ],
        };
      }

      // Filter agents
      let agents = registry;

      if (args.filter_backend) {
        agents = agents.filter((a: any) => a.backend === args.filter_backend);
      }

      if (!args.include_self) {
        agents = agents.filter((a: any) => a.id !== groupFolder);
      }

      if (agents.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No agents match your filter criteria.',
            },
          ],
        };
      }

      // Format output as a table-like structure
      const lines = ['Available Agents:', ''];

      for (const agent of agents) {
        const isCurrent = agent.id === groupFolder ? ' (current)' : '';
        const mainBadge = agent.isMain ? ' [MAIN]' : '';
        const localBadge = agent.isLocal ? ' [LOCAL]' : ' [CLOUD]';

        lines.push(`*${agent.name}*${isCurrent}${mainBadge}${localBadge}`);
        lines.push(`  • ID: \`${agent.id}\``);
        lines.push(`  • JID: \`${agent.jid}\``);
        if (agent.jids && agent.jids.length > 1) {
          lines.push(
            `  • All JIDs: ${agent.jids.map((j: string) => `\`${j}\``).join(', ')}`,
          );
        }
        lines.push(`  • Backend: ${agent.backend}`);
        lines.push(`  • Trigger: ${agent.trigger}`);

        if (agent.description) {
          lines.push(`  • Description: ${agent.description}`);
        }

        lines.push('');
      }

      const summary = `Found ${agents.length} agent${agents.length !== 1 ? 's' : ''}`;
      const text = `${summary}\n\n${lines.join('\n')}`;

      return {
        content: [
          {
            type: 'text' as const,
            text,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading agent registry: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Reaction tool — Discord and Telegram
if (chatJid.startsWith('dc:') || chatJid.startsWith('tg:')) {
  const isTelegram = chatJid.startsWith('tg:');
  const reactionDesc = isTelegram
    ? 'Add or remove an emoji reaction on a Telegram message. Telegram only supports a fixed set of emoji reactions — using an invalid one will return an API error. The set grows over time; see https://core.telegram.org/bots/api#reactiontypeemoji for the current list.'
    : 'Add or remove an emoji reaction on a Discord message. Use message IDs from the conversation.';
  server.tool(
    'react_to_message',
    reactionDesc,
    {
      message_id: z.string().describe('The message ID to react to'),
      emoji: z
        .string()
        .describe(
          'Emoji to react with (e.g. "\ud83d\udc4d", "\u2764\ufe0f", "\ud83c\udf89", "\u2705")',
        ),
      remove: z
        .boolean()
        .optional()
        .describe('Set to true to remove the reaction instead of adding it'),
    },
    async (args) => {
      const requestId = `reaction-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(MESSAGES_DIR, {
        type: 'react_to_message',
        chatJid: getCurrentChatJid(),
        messageId: args.message_id,
        emoji: args.emoji,
        remove: args.remove || false,
        requestId,
        groupFolder,
        timestamp: new Date().toISOString(),
      });

      const response = await waitForResponse(requestId, 8000);
      if (!response) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Timed out waiting for reaction result.',
            },
          ],
          isError: true,
        };
      }

      if (response.ok === false) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                typeof response.error === 'string'
                  ? response.error
                  : 'Reaction failed.',
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text:
              typeof response.result === 'string'
                ? response.result
                : args.remove
                  ? 'Reaction removed.'
                  : 'Reaction added.',
          },
        ],
      };
    },
  );

  if (!isTelegram)
    server.tool(
      'format_mention',
      'Format a user mention for Discord using their display name. Returns the proper <@USER_ID> format for Discord mentions.',
      {
        user_name: z
          .string()
          .describe(
            'Display name of the user to mention (e.g. "OmarOmni", "PeytonOmni")',
          ),
      },
      async (args) => {
        // Reload on each request so long-lived containers do not use stale registry data.
        const userRegistry = loadUserRegistry();
        // Look up user in registry (case-insensitive)
        const key = args.user_name.toLowerCase().trim();
        const user = userRegistry[key];

        if (user && user.platform === 'discord') {
          // Return properly formatted Discord mention
          return {
            content: [
              {
                type: 'text' as const,
                text: `<@${user.id}>`,
              },
            ],
          };
        }

        // User not found - return plain @mention as fallback
        return {
          content: [
            {
              type: 'text' as const,
              text: `@${args.user_name}`,
            },
          ],
        };
      },
    );
}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
