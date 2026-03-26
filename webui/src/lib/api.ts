// Typed API client for all OmniClaw endpoints.

export interface HealthData {
  status: 'healthy';
  version: string;
  uptime_seconds: number;
  memory: { rss_mb: number; heap_used_mb: number; heap_total_mb: number };
  runtime: { bun: string; platform: string; arch: string };
  agents: {
    total: number;
    by_backend: Record<string, number>;
    by_runtime: Record<string, number>;
  };
  containers: {
    active: number;
    idle: number;
    max_active: number;
    max_idle: number;
  };
  tasks: { active: number; paused: number; completed: number; total: number };
  sse_clients: number;
  started_at: string;
}

export interface StatsData {
  agents: number;
  activeTasks: number;
  pausedTasks: number;
  completedTasks: number;
  activeContainers: number;
  idleContainers: number;
  maxActive: number;
  maxIdle: number;
}

export interface AgentChannelData {
  id: string;
  name: string;
  folder: string;
  backend: string;
  agentRuntime: string;
  isAdmin: boolean;
  serverFolder?: string;
  agentContextFolder?: string;
  avatarUrl?: string;
  serverIconUrl?: string;
  remoteInstanceId?: string;
  remoteInstanceName?: string;
  remoteHost?: string;
  remotePort?: number;
  channels: Array<{
    jid: string;
    displayName: string;
    channelFolder?: string;
    categoryFolder?: string;
    iconUrl?: string;
    discordGuildId?: string;
    discordBotId?: string;
  }>;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
  executing_since: string | null;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
}

export interface MessageInfo {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
}

export interface ContextFileEntry {
  path: string;
  hash: string;
  size: number;
  mtime: string;
}

export interface ContextLayer {
  path: string | null;
  content: string | null;
  exists: boolean;
}

export interface ContextLayers {
  channel: ContextLayer;
  agent: ContextLayer;
  category: ContextLayer;
  server: ContextLayer;
}

export interface AgentDetailData {
  id: string;
  name: string;
  folder: string;
  backend: string;
  agentRuntime: string;
  isAdmin: boolean;
  description?: string;
  createdAt: string;
  remoteInstanceId?: string;
  remoteInstanceName?: string;
  remoteHost?: string;
  remotePort?: number;
  serverFolder?: string;
  agentContextFolder?: string;
  avatarUrl?: string;
  channels: Array<{
    jid: string;
    displayName: string;
    channelFolder?: string;
    categoryFolder?: string;
  }>;
  tasks: Array<{
    id: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
    last_run: string | null;
  }>;
  recentChats: Array<{
    jid: string;
    name: string;
    last_message_time: string;
  }>;
}

export interface SettingsData {
  general: {
    timezone: string;
    anthropicModel: string | null;
    localRuntime: string;
  };
  webUi: {
    port: number | null;
    hostname: string;
    authEnabled: boolean;
    corsOrigin: string | null;
  };
  containers: {
    image: string;
    memory: string;
    timeoutMs: number;
    startupTimeoutMs: number;
    idleTimeoutMs: number;
    maxOutputSize: number;
    maxActive: number;
    maxIdle: number;
    maxTask: number;
  };
  channels: {
    discordBots: number;
    discordBotIds: string[];
    discordDefaultBot: string | null;
    telegramBots: number;
    slackBots: number;
    slackDefaultBot: string | null;
  };
  scheduling: {
    sessionMaxAgeMs: number;
    persistentTaskState: boolean;
    pollIntervalMs: number;
  };
  roster: {
    scope: string;
    roleFilters: string[];
    cacheTtlMs: number;
    refreshIntervalMs: number;
  };
  discovery: { enabled: boolean; instanceName: string; trustLanAdmin: boolean };
  github: {
    webhookPort: number;
    webhookPath: string;
    secretConfigured: boolean;
  };
  paths: { store: string; groups: string; data: string };
}

export interface IpcEvent {
  id: number;
  kind: string;
  timestamp: string;
  sourceGroup: string;
  summary: string;
  details?: Record<string, unknown>;
}

export interface QueueDetail {
  folderKey: string;
  messageLane: {
    active: boolean;
    idle: boolean;
    pendingCount: number;
    containerName: string | null;
  };
  taskLane: {
    active: boolean;
    pendingCount: number;
    containerName: string | null;
    activeTask: {
      taskId: string;
      promptPreview: string;
      startedAt: number;
      runningMs: number;
    } | null;
  };
  retryCount: number;
}

// --- Fetch helpers ---

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`POST ${url} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function patch<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${url} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function del<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) throw new Error(`DELETE ${url} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function put<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PUT ${url} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

// --- API functions ---

export const api = {
  getHealth: () => get<HealthData>('/api/health'),
  getSettings: () => get<SettingsData>('/api/settings'),
  getAgents: () => get<AgentChannelData[]>('/api/agents'),
  getStats: () => get<StatsData>('/api/stats'),

  // Tasks
  getTasks: (status?: string) =>
    get<ScheduledTask[]>(`/api/tasks${status ? `?status=${status}` : ''}`),
  getTask: (id: string) =>
    get<ScheduledTask>(`/api/tasks/${encodeURIComponent(id)}`),
  createTask: (
    task: Omit<
      ScheduledTask,
      'id' | 'last_run' | 'last_result' | 'executing_since' | 'created_at'
    >,
  ) => post<ScheduledTask>('/api/tasks', task),
  updateTask: (
    id: string,
    updates: Partial<
      Pick<
        ScheduledTask,
        'prompt' | 'schedule_type' | 'schedule_value' | 'status'
      >
    >,
  ) => patch<ScheduledTask>(`/api/tasks/${encodeURIComponent(id)}`, updates),
  deleteTask: (id: string) =>
    del<{ deleted: boolean; id: string }>(
      `/api/tasks/${encodeURIComponent(id)}`,
    ),
  getTaskRuns: (id: string, limit?: number) =>
    get<TaskRunLog[]>(
      `/api/tasks/${encodeURIComponent(id)}/runs${limit ? `?limit=${limit}` : ''}`,
    ),

  // Chats & messages
  getChats: () => get<ChatInfo[]>('/api/chats'),
  getMessages: (chatJid: string, since?: string, limit?: number) => {
    const params = new URLSearchParams();
    if (since) params.set('since', since);
    if (limit) params.set('limit', String(limit));
    const qs = params.toString();
    return get<MessageInfo[]>(
      `/api/messages/${encodeURIComponent(chatJid)}${qs ? `?${qs}` : ''}`,
    );
  },
  searchMessages: (query: string, chatJid?: string, limit?: number) => {
    const params = new URLSearchParams({ q: query });
    if (chatJid) params.set('chatJid', chatJid);
    if (limit) params.set('limit', String(limit));
    return get<MessageInfo[]>(`/api/messages/search?${params.toString()}`);
  },

  // Context
  getContextFiles: () => get<ContextFileEntry[]>('/api/context/files'),
  getContextLayers: (params: {
    folder?: string;
    server_folder?: string;
    agent_context_folder?: string;
    channel_folder?: string;
    category_folder?: string;
  }) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return get<ContextLayers>(`/api/context/layers?${qs}`);
  },
  writeContextFile: (path: string, content: string) =>
    put<{ ok: boolean }>('/api/context/file', { path, content }),

  // IPC
  getQueueDetails: () => get<QueueDetail[]>('/api/ipc/queue'),
  getIpcEvents: (count?: number) =>
    get<IpcEvent[]>(`/api/ipc/events${count ? `?count=${count}` : ''}`),

  // Agent detail
  getAgentDetail: (id: string) =>
    get<AgentDetailData>(`/api/agents/${encodeURIComponent(id)}/detail`),
  getAgentAvatar: (id: string) =>
    get<{ avatarUrl: string | null; avatarSource: string | null }>(
      `/api/agents/${encodeURIComponent(id)}/avatar`,
    ),
  setAgentAvatar: (id: string, url: string | null, source: string | null) =>
    post<{ success: boolean }>(`/api/agents/${encodeURIComponent(id)}/avatar`, {
      url,
      source,
    }),
  getAgentAvatarImageUrl: (id: string) =>
    `/api/agents/${encodeURIComponent(id)}/avatar/image`,

  // Icons
  getChatIconUrl: (chatJid: string) =>
    `/api/chats/${encodeURIComponent(chatJid)}/icon`,
  getDiscordGuildIconUrl: (guildId: string, botId?: string) => {
    const qs = botId ? `?botId=${encodeURIComponent(botId)}` : '';
    return `/api/discord/guilds/${encodeURIComponent(guildId)}/icon${qs}`;
  },
};
