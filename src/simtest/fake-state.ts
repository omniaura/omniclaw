/**
 * Fake WebStateProvider — fully in-memory, manipulable via admin API.
 * No secrets, no containers, no database required.
 */

import type {
  Agent,
  ChannelSubscription,
  ScheduledTask,
  TaskRunLog,
} from '../types.js';
import type { GroupQueueDetail } from '../group-queue.js';
import type { IpcEvent, IpcEventKind } from '../web/ipc-events.js';
import type { WebStateProvider, QueueStats } from '../web/types.js';
import { calculateNextRun } from '../schedule-utils.js';

// ---- Seed data generators ----

function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    name: overrides.name ?? overrides.id,
    folder: overrides.folder ?? overrides.id,
    backend: 'apple-container',
    agentRuntime: 'claude-agent-sdk',
    isAdmin: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSub(
  channelJid: string,
  agentId: string,
  overrides?: Partial<ChannelSubscription>,
): ChannelSubscription {
  return {
    channelJid,
    agentId,
    trigger: `@${agentId}`,
    requiresTrigger: true,
    priority: 100,
    isPrimary: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeTask(
  overrides: Partial<ScheduledTask> & { id: string },
): ScheduledTask {
  return {
    group_folder: 'main',
    chat_jid: 'sim:general',
    prompt: 'Simulated task',
    schedule_type: 'interval',
    schedule_value: '300000',
    context_mode: 'isolated',
    next_run: new Date(Date.now() + 300_000).toISOString(),
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: new Date().toISOString(),
    executing_since: null,
    ...overrides,
  };
}

interface SimMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
}

interface SimChat {
  jid: string;
  name: string;
  last_message_time: string;
}

// ---- Default seed data ----

function seedAgents(): Record<string, Agent> {
  return {
    main: makeAgent({ id: 'main', name: 'Main Assistant', isAdmin: true }),
    'research-bot': makeAgent({
      id: 'research-bot',
      name: 'Research Bot',
      agentRuntime: 'claude-agent-sdk',
      serverFolder: 'servers/sim-server',
    }),
    'code-reviewer': makeAgent({
      id: 'code-reviewer',
      name: 'Code Reviewer',
      backend: 'docker',
      agentRuntime: 'opencode',
      agentContextFolder: 'agents/code-reviewer',
    }),
    'task-runner': makeAgent({
      id: 'task-runner',
      name: 'Task Runner',
      description: 'Runs scheduled automation tasks',
    }),
  };
}

function seedSubscriptions(): Record<string, ChannelSubscription[]> {
  return {
    'sim:general': [
      makeSub('sim:general', 'main', { isPrimary: true }),
      makeSub('sim:general', 'research-bot', {
        isPrimary: false,
        priority: 50,
      }),
    ],
    'sim:code-review': [
      makeSub('sim:code-review', 'code-reviewer', { isPrimary: true }),
    ],
    'sim:tasks': [makeSub('sim:tasks', 'task-runner', { isPrimary: true })],
    'sim:multi-agent': [
      makeSub('sim:multi-agent', 'main', { isPrimary: true }),
      makeSub('sim:multi-agent', 'research-bot', {
        isPrimary: false,
        priority: 80,
      }),
      makeSub('sim:multi-agent', 'code-reviewer', {
        isPrimary: false,
        priority: 60,
      }),
    ],
  };
}

function seedTasks(): ScheduledTask[] {
  return [
    makeTask({
      id: 'task-heartbeat',
      group_folder: 'main',
      chat_jid: 'sim:general',
      prompt: 'Run hourly health check and report status',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      status: 'active',
    }),
    makeTask({
      id: 'task-triage',
      group_folder: 'research-bot',
      chat_jid: 'sim:general',
      prompt: 'Triage open GitHub issues',
      schedule_type: 'interval',
      schedule_value: '3600000',
      status: 'active',
    }),
    makeTask({
      id: 'task-paused',
      group_folder: 'code-reviewer',
      chat_jid: 'sim:code-review',
      prompt: 'Review new PRs on main branch',
      schedule_type: 'cron',
      schedule_value: '*/30 * * * *',
      status: 'paused',
    }),
    makeTask({
      id: 'task-completed',
      group_folder: 'main',
      chat_jid: 'sim:general',
      prompt: 'One-time migration cleanup',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 86400_000).toISOString(),
      status: 'completed',
      last_run: new Date(Date.now() - 86400_000).toISOString(),
      last_result: 'Migration cleanup completed successfully',
    }),
  ];
}

function seedMessages(): SimMessage[] {
  const now = Date.now();
  return [
    {
      id: 'msg-1',
      chat_jid: 'sim:general',
      sender: 'user:peyton',
      sender_name: 'Peyton',
      content: 'Hey @main, can you check the latest deploy?',
      timestamp: new Date(now - 600_000).toISOString(),
    },
    {
      id: 'msg-2',
      chat_jid: 'sim:general',
      sender: 'agent:main',
      sender_name: 'Main Assistant',
      content:
        'Checking deploy status now. The latest deployment was successful — all health checks passed.',
      timestamp: new Date(now - 590_000).toISOString(),
    },
    {
      id: 'msg-3',
      chat_jid: 'sim:general',
      sender: 'user:peyton',
      sender_name: 'Peyton',
      content: '@research-bot look into the performance regression in PR #315',
      timestamp: new Date(now - 300_000).toISOString(),
    },
    {
      id: 'msg-4',
      chat_jid: 'sim:general',
      sender: 'agent:research-bot',
      sender_name: 'Research Bot',
      content:
        'Investigating PR #315. Found a potential N+1 query in the agent detail page rendering.',
      timestamp: new Date(now - 280_000).toISOString(),
    },
    {
      id: 'msg-5',
      chat_jid: 'sim:code-review',
      sender: 'user:peyton',
      sender_name: 'Peyton',
      content: '@code-reviewer review the web UI simtest harness PR',
      timestamp: new Date(now - 120_000).toISOString(),
    },
    {
      id: 'msg-6',
      chat_jid: 'sim:code-review',
      sender: 'agent:code-reviewer',
      sender_name: 'Code Reviewer',
      content:
        'Reviewing now. The fake state provider looks clean — good separation of concerns.',
      timestamp: new Date(now - 100_000).toISOString(),
    },
    {
      id: 'msg-7',
      chat_jid: 'sim:tasks',
      sender: 'system',
      sender_name: 'System',
      content: 'Scheduled task "task-heartbeat" executed successfully.',
      timestamp: new Date(now - 60_000).toISOString(),
    },
  ];
}

function seedChats(): SimChat[] {
  const now = Date.now();
  return [
    {
      jid: 'sim:general',
      name: '#general',
      last_message_time: new Date(now - 280_000).toISOString(),
    },
    {
      jid: 'sim:code-review',
      name: '#code-review',
      last_message_time: new Date(now - 100_000).toISOString(),
    },
    {
      jid: 'sim:tasks',
      name: '#tasks',
      last_message_time: new Date(now - 60_000).toISOString(),
    },
    {
      jid: 'sim:multi-agent',
      name: '#multi-agent',
      last_message_time: new Date(now - 3600_000).toISOString(),
    },
  ];
}

function seedIpcEvents(): IpcEvent[] {
  const now = Date.now();
  return [
    {
      id: 1,
      kind: 'message_sent',
      timestamp: new Date(now - 590_000).toISOString(),
      sourceGroup: 'main',
      summary: 'Main Assistant sent message to sim:general',
    },
    {
      id: 2,
      kind: 'message_sent',
      timestamp: new Date(now - 280_000).toISOString(),
      sourceGroup: 'research-bot',
      summary: 'Research Bot sent message to sim:general',
    },
    {
      id: 3,
      kind: 'task_created',
      timestamp: new Date(now - 200_000).toISOString(),
      sourceGroup: 'main',
      summary: 'Created task: task-heartbeat (cron: 0 * * * *)',
    },
    {
      id: 4,
      kind: 'message_sent',
      timestamp: new Date(now - 100_000).toISOString(),
      sourceGroup: 'code-reviewer',
      summary: 'Code Reviewer sent message to sim:code-review',
    },
    {
      id: 5,
      kind: 'ipc_error',
      timestamp: new Date(now - 50_000).toISOString(),
      sourceGroup: 'task-runner',
      summary: 'Failed to parse IPC payload: unexpected EOF',
      details: { file: 'broken.json', error: 'SyntaxError' },
    },
  ];
}

function seedTaskRunLogs(): Record<string, TaskRunLog[]> {
  const now = Date.now();
  return {
    'task-heartbeat': [
      {
        task_id: 'task-heartbeat',
        run_at: new Date(now - 3600_000).toISOString(),
        duration_ms: 4200,
        status: 'success',
        result: 'All systems healthy. 4 agents online.',
        error: null,
      },
      {
        task_id: 'task-heartbeat',
        run_at: new Date(now - 7200_000).toISOString(),
        duration_ms: 3800,
        status: 'success',
        result: 'All systems healthy. 3 agents online.',
        error: null,
      },
      {
        task_id: 'task-heartbeat',
        run_at: new Date(now - 10800_000).toISOString(),
        duration_ms: 15200,
        status: 'error',
        result: null,
        error: 'Container timeout after 15000ms',
      },
    ],
    'task-triage': [
      {
        task_id: 'task-triage',
        run_at: new Date(now - 1800_000).toISOString(),
        duration_ms: 12500,
        status: 'success',
        result: 'Triaged 3 issues: #261 (P2), #254 (P1), #223 (P2)',
        error: null,
      },
    ],
    'task-completed': [
      {
        task_id: 'task-completed',
        run_at: new Date(now - 86400_000).toISOString(),
        duration_ms: 8300,
        status: 'success',
        result: 'Migration cleanup completed successfully',
        error: null,
      },
    ],
  };
}

function seedQueueDetails(): GroupQueueDetail[] {
  return [
    {
      folderKey: 'main',
      messageLane: {
        active: true,
        idle: false,
        pendingCount: 0,
        containerName: 'omniclaw-main-abc123',
      },
      taskLane: {
        active: false,
        pendingCount: 1,
        containerName: null,
        activeTask: null,
      },
      retryCount: 0,
    },
    {
      folderKey: 'research-bot',
      messageLane: {
        active: false,
        idle: true,
        pendingCount: 0,
        containerName: 'omniclaw-research-def456',
      },
      taskLane: {
        active: false,
        pendingCount: 0,
        containerName: null,
        activeTask: null,
      },
      retryCount: 0,
    },
    {
      folderKey: 'code-reviewer',
      messageLane: {
        active: true,
        idle: false,
        pendingCount: 2,
        containerName: 'omniclaw-reviewer-ghi789',
      },
      taskLane: {
        active: true,
        pendingCount: 0,
        containerName: 'omniclaw-reviewer-task-jkl012',
        activeTask: {
          taskId: 'task-paused',
          promptPreview: 'Review new PRs on main branch',
          startedAt: Date.now() - 30_000,
          runningMs: 30_000,
        },
      },
      retryCount: 1,
    },
  ];
}

function seedContextFiles(): Record<string, string> {
  return {
    main: '# Main Agent\n\nThis is the main agent context.',
    'research-bot': '# Research Bot\n\nFocused on issue triage and research.',
    'servers/sim-server':
      '# Sim Server\n\nShared server context for simulation.',
  };
}

// ---- FakeState class ----

export class FakeState implements WebStateProvider {
  agents: Record<string, Agent>;
  subscriptions: Record<string, ChannelSubscription[]>;
  tasks: ScheduledTask[];
  messages: SimMessage[];
  chats: SimChat[];
  ipcEvents: IpcEvent[];
  taskRunLogs: Record<string, TaskRunLog[]>;
  queueStats: QueueStats;
  queueDetails: GroupQueueDetail[];
  contextFiles: Record<string, string>;
  private nextIpcId: number;
  private nextMsgId: number;

  constructor() {
    this.agents = seedAgents();
    this.subscriptions = seedSubscriptions();
    this.tasks = seedTasks();
    this.messages = seedMessages();
    this.chats = seedChats();
    this.ipcEvents = seedIpcEvents();
    this.taskRunLogs = seedTaskRunLogs();
    this.queueStats = {
      activeContainers: 3,
      idleContainers: 1,
      maxActive: 10,
      maxIdle: 5,
    };
    this.queueDetails = seedQueueDetails();
    this.contextFiles = seedContextFiles();
    this.nextIpcId = 6;
    this.nextMsgId = 8;
  }

  // ---- WebStateProvider implementation ----

  getAgents(): Record<string, Agent> {
    return this.agents;
  }

  getChannelSubscriptions(): Record<string, ChannelSubscription[]> {
    return this.subscriptions;
  }

  getTasks(): ScheduledTask[] {
    return this.tasks;
  }

  getTaskById(id: string): ScheduledTask | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  getMessages(chatJid: string, sinceTimestamp: string, limit?: number) {
    const since = new Date(sinceTimestamp).getTime();
    return this.messages
      .filter(
        (m) =>
          m.chat_jid === chatJid && new Date(m.timestamp).getTime() >= since,
      )
      .slice(0, limit ?? 100);
  }

  getChats() {
    return this.chats;
  }

  getQueueStats(): QueueStats {
    return this.queueStats;
  }

  getQueueDetails(): GroupQueueDetail[] {
    return this.queueDetails;
  }

  getIpcEvents(count?: number): IpcEvent[] {
    return this.ipcEvents.slice(-(count ?? 50)).reverse();
  }

  getTaskRunLogs(taskId: string, limit?: number): TaskRunLog[] {
    const logs = this.taskRunLogs[taskId] ?? [];
    return logs.slice(0, limit ?? 20);
  }

  createTask(
    task: Omit<ScheduledTask, 'last_run' | 'last_result' | 'executing_since'>,
  ): void {
    if (this.tasks.some((existingTask) => existingTask.id === task.id)) {
      throw new Error(`Task already exists: ${task.id}`);
    }
    this.tasks.push({
      ...task,
      last_run: null,
      last_result: null,
      executing_since: null,
    });
  }

  updateTask(
    id: string,
    updates: Partial<
      Pick<
        ScheduledTask,
        'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
      >
    >,
  ): void {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`Task not found: ${id}`);
    Object.assign(task, updates);
  }

  deleteTask(id: string): void {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error(`Task not found: ${id}`);
    this.tasks.splice(idx, 1);
  }

  calculateNextRun(
    scheduleType: 'cron' | 'interval' | 'once',
    scheduleValue: string,
  ): string | null {
    return calculateNextRun(scheduleType, scheduleValue);
  }

  readContextFile(layerPath: string): string | null {
    return this.contextFiles[layerPath] ?? null;
  }

  writeContextFile(layerPath: string, content: string): void {
    this.contextFiles[layerPath] = content;
  }

  updateAgentAvatar(
    agentId: string,
    url: string | null,
    source: string | null,
  ): void {
    const agent = this.agents[agentId];
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    agent.avatarUrl = url ?? undefined;
    agent.avatarSource = (source as Agent['avatarSource']) ?? undefined;
  }

  // ---- Admin mutation methods (called by admin API) ----

  addAgent(agent: Partial<Agent> & { id: string }): Agent {
    const full = makeAgent(agent);
    this.agents[full.id] = full;
    return full;
  }

  removeAgent(id: string): boolean {
    if (!this.agents[id]) return false;
    delete this.agents[id];
    // Clean up subscriptions
    for (const [jid, subs] of Object.entries(this.subscriptions)) {
      this.subscriptions[jid] = subs.filter((s) => s.agentId !== id);
      if (this.subscriptions[jid].length === 0) delete this.subscriptions[jid];
    }
    return true;
  }

  addSubscription(
    channelJid: string,
    agentId: string,
    overrides?: Partial<ChannelSubscription>,
  ): void {
    if (!this.subscriptions[channelJid]) this.subscriptions[channelJid] = [];
    this.subscriptions[channelJid].push(
      makeSub(channelJid, agentId, overrides),
    );
  }

  addChat(jid: string, name: string): void {
    const existing = this.chats.find((c) => c.jid === jid);
    if (existing) {
      existing.name = name;
      return;
    }
    this.chats.push({ jid, name, last_message_time: new Date().toISOString() });
  }

  addMessage(
    chatJid: string,
    sender: string,
    senderName: string,
    content: string,
  ): SimMessage {
    const msg: SimMessage = {
      id: `msg-${this.nextMsgId++}`,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp: new Date().toISOString(),
    };
    this.messages.push(msg);
    // Update chat last_message_time
    const chat = this.chats.find((c) => c.jid === chatJid);
    if (chat) chat.last_message_time = msg.timestamp;
    return msg;
  }

  addIpcEvent(
    kind: IpcEventKind,
    sourceGroup: string,
    summary: string,
    details?: Record<string, unknown>,
  ): IpcEvent {
    const event: IpcEvent = {
      id: this.nextIpcId++,
      kind,
      timestamp: new Date().toISOString(),
      sourceGroup,
      summary,
      details,
    };
    this.ipcEvents.push(event);
    if (this.ipcEvents.length > 200) this.ipcEvents.shift();
    return event;
  }

  addTaskRunLog(taskId: string, log: Omit<TaskRunLog, 'task_id'>): void {
    if (!this.taskRunLogs[taskId]) this.taskRunLogs[taskId] = [];
    this.taskRunLogs[taskId].unshift({ ...log, task_id: taskId });
  }

  setQueueStats(stats: Partial<QueueStats>): void {
    Object.assign(this.queueStats, stats);
  }

  setQueueDetails(details: GroupQueueDetail[]): void {
    this.queueDetails = details;
  }

  /** Reset all state to fresh seed data. */
  reset(): void {
    this.agents = seedAgents();
    this.subscriptions = seedSubscriptions();
    this.tasks = seedTasks();
    this.messages = seedMessages();
    this.chats = seedChats();
    this.ipcEvents = seedIpcEvents();
    this.taskRunLogs = seedTaskRunLogs();
    this.queueStats = {
      activeContainers: 3,
      idleContainers: 1,
      maxActive: 10,
      maxIdle: 5,
    };
    this.queueDetails = seedQueueDetails();
    this.contextFiles = seedContextFiles();
    this.nextIpcId = 6;
    this.nextMsgId = 8;
  }
}
