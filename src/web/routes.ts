import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { assertPathWithin } from '../path-security.js';
import type { ScheduledTask } from '../types.js';
import type { WebStateProvider } from './types.js';
import { serveCachedRemoteImage } from './image-cache.js';
import { renderConversations } from './conversations.js';
import {
  renderContextViewerWithRemote,
  renderContextViewer,
} from './context-viewer.js';
import { renderDashboardWithRemote, renderDashboard } from './dashboard.js';
import { renderIpcInspector } from './ipc-inspector.js';
import {
  fetchTrustedRemoteAgents,
  handleDiscoveryRequest,
  type DiscoveryRouteContext,
} from '../discovery/routes.js';
import { listLocalContextFiles } from './context-files.js';
import {
  renderNetworkPage,
  renderNetworkContent,
  type NetworkPageState,
} from './network.js';
import { buildHealthData, renderSystem } from './system.js';
import { buildAgentChannelData } from './agent-channels.js';

/** Optional discovery context — set by the orchestrator when discovery is enabled. */
let discoveryContext: DiscoveryRouteContext | null = null;
let networkPageState: (() => NetworkPageState) | null = null;

/** Called by the orchestrator to wire up discovery routes. */
export function setDiscoveryContext(
  ctx: DiscoveryRouteContext,
  getPageState: () => NetworkPageState,
): void {
  discoveryContext = ctx;
  networkPageState = getPageState;
}

/**
 * Handle an authenticated HTTP request and return a Response.
 * Routing is prefix-based: /api/* for JSON, / for the dashboard HTML.
 */
export function handleRequest(
  req: Request,
  state: WebStateProvider,
  sseClientCount?: number,
): Response | Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  // --- Discovery API routes ---
  if (pathname.startsWith('/api/discovery/') && discoveryContext) {
    const result = handleDiscoveryRequest(req, url, discoveryContext);
    if (result) return result;
  }

  // --- Network page ---
  if (pathname === '/network') {
    const pageState = networkPageState?.() ?? {
      instanceId: '',
      instanceName: '',
      discoveryEnabled: false,
      runtime: {
        enabled: false,
        active: false,
        currentNetwork: null,
        trustedNetworks: [],
      },
      peers: [],
      pendingRequests: [],
    };
    return new Response(renderNetworkPage(pageState), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // --- API routes ---
  if (pathname === '/api/health')
    return json(buildHealthData(state, sseClientCount ?? 0));
  if (pathname === '/api/agents') return handleGetAgents(state);

  // Tasks — CRUD
  if (pathname === '/api/tasks') {
    if (method === 'GET') return handleGetTasks(req, state);
    if (method === 'POST') return handleCreateTask(req, state);
    return json({ error: 'Method not allowed' }, 405);
  }
  if (pathname.startsWith('/api/tasks/')) {
    let taskId: string;
    try {
      taskId = decodeURIComponent(pathname.slice('/api/tasks/'.length));
    } catch {
      return json({ error: 'Invalid task ID encoding' }, 400);
    }
    if (!taskId) return json({ error: 'Missing task ID' }, 400);
    if (method === 'GET') return handleGetSingleTask(taskId, state);
    if (method === 'PATCH') return handleUpdateTask(taskId, req, state);
    if (method === 'DELETE') return handleDeleteTask(taskId, state);
    return json({ error: 'Method not allowed' }, 405);
  }

  // Context file operations
  if (pathname === '/api/context/files' && method === 'GET')
    return handleListContextFiles();
  if (pathname === '/api/context/layers')
    return handleGetContextLayers(url, state);
  if (pathname === '/api/context/file') {
    if (method === 'PUT') return handleWriteContextFile(req, state);
    return json({ error: 'Method not allowed' }, 405);
  }

  if (pathname === '/api/chats') return handleGetChats(state);
  if (pathname.startsWith('/api/messages/'))
    return handleGetMessages(url, state);
  if (pathname === '/api/stats') return handleGetStats(state);

  // IPC inspector API
  if (pathname === '/api/ipc/queue') return handleGetQueueDetails(state);
  if (pathname === '/api/ipc/events') return handleGetIpcEvents(url, state);

  // --- Dashboard ---
  if (pathname === '/' || pathname === '/index.html')
    return handleDashboardPage(state);

  // --- Conversations viewer ---
  if (pathname === '/conversations')
    return new Response(renderConversations(state), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });

  // --- Context viewer ---
  if (pathname === '/context') return handleContextPage(state);

  // --- IPC Inspector ---
  if (pathname === '/ipc')
    return new Response(renderIpcInspector(state), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });

  // --- System Health ---
  if (pathname === '/system')
    return new Response(renderSystem(state, sseClientCount ?? 0), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });

  // --- Agent avatar endpoints ---
  if (pathname.startsWith('/api/agents/') && pathname.endsWith('/avatar')) {
    const agentId = decodeURIComponent(
      pathname.slice('/api/agents/'.length, -'/avatar'.length),
    );
    if (!agentId) return json({ error: 'Missing agent ID' }, 400);
    if (method === 'GET') return handleGetAgentAvatar(agentId, state);
    if (method === 'POST') return handleSetAgentAvatar(agentId, req, state);
    return json({ error: 'Method not allowed' }, 405);
  }
  if (
    pathname.startsWith('/api/agents/') &&
    pathname.endsWith('/avatar/image')
  ) {
    const agentId = decodeURIComponent(
      pathname.slice('/api/agents/'.length, -'/avatar/image'.length),
    );
    if (!agentId) return json({ error: 'Missing agent ID' }, 400);
    if (method === 'GET') return handleGetAgentAvatarImage(agentId, state);
    return json({ error: 'Method not allowed' }, 405);
  }
  if (pathname.startsWith('/api/chats/') && pathname.endsWith('/icon')) {
    const chatJid = decodeURIComponent(
      pathname.slice('/api/chats/'.length, -'/icon'.length),
    );
    if (!chatJid) return json({ error: 'Missing chat JID' }, 400);
    if (method === 'GET') return handleGetChatIcon(chatJid, state);
    return json({ error: 'Method not allowed' }, 405);
  }
  if (
    pathname.startsWith('/api/discord/guilds/') &&
    pathname.endsWith('/icon')
  ) {
    const guildId = decodeURIComponent(
      pathname.slice('/api/discord/guilds/'.length, -'/icon'.length),
    );
    if (!guildId) return json({ error: 'Missing guild ID' }, 400);
    if (method === 'GET')
      return handleGetDiscordGuildIcon(
        guildId,
        url.searchParams.get('botId'),
        state,
      );
    return json({ error: 'Method not allowed' }, 405);
  }

  // Serve locally-stored avatar files
  if (pathname.startsWith('/avatars/')) {
    return handleServeAvatar(pathname);
  }

  return json({ error: 'Not found' }, 404);
}

async function handleDashboardPage(state: WebStateProvider): Promise<Response> {
  const remotePeers = discoveryContext
    ? await fetchTrustedRemoteAgents(discoveryContext)
    : [];
  return new Response(renderDashboardWithRemote(state, remotePeers), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

async function handleContextPage(state: WebStateProvider): Promise<Response> {
  const remotePeers = discoveryContext
    ? await fetchTrustedRemoteAgents(discoveryContext)
    : [];
  return new Response(renderContextViewerWithRemote(state, remotePeers), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ---- Handlers ----

function handleGetAgents(state: WebStateProvider): Response {
  return json(buildAgentChannelData(state));
}

function handleGetTasks(req: Request, state: WebStateProvider): Response {
  const url = new URL(req.url);
  const statusFilter = url.searchParams.get('status');
  let tasks = state.getTasks();
  if (statusFilter) {
    tasks = tasks.filter((t) => t.status === statusFilter);
  }
  return json(tasks);
}

function handleGetSingleTask(
  taskId: string,
  state: WebStateProvider,
): Response {
  const task = state.getTaskById(taskId);
  if (!task) return json({ error: 'Task not found' }, 404);
  return json(task);
}

async function handleCreateTask(
  req: Request,
  state: WebStateProvider,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  // Validate required fields
  const {
    group_folder,
    chat_jid,
    prompt,
    schedule_type,
    schedule_value,
    context_mode,
  } = body;

  if (!prompt || typeof prompt !== 'string') {
    return json(
      { error: 'Missing or invalid "prompt" (string required)' },
      400,
    );
  }
  if (
    !schedule_type ||
    !['cron', 'interval', 'once'].includes(schedule_type as string)
  ) {
    return json(
      { error: 'Missing or invalid "schedule_type" (cron | interval | once)' },
      400,
    );
  }
  if (!schedule_value || typeof schedule_value !== 'string') {
    return json(
      { error: 'Missing or invalid "schedule_value" (string required)' },
      400,
    );
  }
  if (!group_folder || typeof group_folder !== 'string') {
    return json(
      { error: 'Missing or invalid "group_folder" (string required)' },
      400,
    );
  }
  if (!chat_jid || typeof chat_jid !== 'string') {
    return json(
      { error: 'Missing or invalid "chat_jid" (string required)' },
      400,
    );
  }

  const validContextMode =
    context_mode === 'group' || context_mode === 'isolated'
      ? context_mode
      : 'isolated';

  // Validate the schedule produces a valid next_run
  const nextRun = state.calculateNextRun(
    schedule_type as 'cron' | 'interval' | 'once',
    schedule_value as string,
  );
  if (nextRun === null) {
    return json(
      { error: 'Invalid schedule: could not calculate next run time' },
      400,
    );
  }

  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const task: Omit<ScheduledTask, 'last_run' | 'last_result'> = {
    id: taskId,
    group_folder: group_folder as string,
    chat_jid: chat_jid as string,
    prompt: prompt as string,
    schedule_type: schedule_type as 'cron' | 'interval' | 'once',
    schedule_value: schedule_value as string,
    context_mode: validContextMode,
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  };

  try {
    state.createTask(task);
  } catch (err) {
    return json(
      {
        error: `Failed to create task: ${err instanceof Error ? err.message : String(err)}`,
      },
      500,
    );
  }

  return json({ ...task, last_run: null, last_result: null }, 201);
}

async function handleUpdateTask(
  taskId: string,
  req: Request,
  state: WebStateProvider,
): Promise<Response> {
  const existing = state.getTaskById(taskId);
  if (!existing) return json({ error: 'Task not found' }, 404);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  > = {};

  if (body.prompt !== undefined) {
    if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
      return json({ error: '"prompt" must be a non-empty string' }, 400);
    }
    updates.prompt = body.prompt;
  }
  if (body.schedule_type !== undefined) {
    if (!['cron', 'interval', 'once'].includes(body.schedule_type as string)) {
      return json(
        { error: '"schedule_type" must be cron | interval | once' },
        400,
      );
    }
    updates.schedule_type = body.schedule_type as 'cron' | 'interval' | 'once';
  }
  if (body.schedule_value !== undefined) {
    if (
      typeof body.schedule_value !== 'string' ||
      body.schedule_value.length === 0
    ) {
      return json(
        { error: '"schedule_value" must be a non-empty string' },
        400,
      );
    }
    updates.schedule_value = body.schedule_value;
  }
  if (body.status !== undefined) {
    if (!['active', 'paused'].includes(body.status as string)) {
      return json({ error: '"status" must be active | paused' }, 400);
    }
    updates.status = body.status as 'active' | 'paused';
  }

  if (Object.keys(updates).length === 0) {
    return json({ error: 'No valid fields to update' }, 400);
  }

  // Recalculate next_run when schedule changes or task is being resumed
  const effectiveStatus = updates.status ?? existing.status;
  const scheduleChanged = !!(updates.schedule_type || updates.schedule_value);
  const beingResumed =
    updates.status === 'active' && existing.status !== 'active';

  const newType = (updates.schedule_type ?? existing.schedule_type) as
    | 'cron'
    | 'interval'
    | 'once';
  const newValue = updates.schedule_value ?? existing.schedule_value;

  if (scheduleChanged) {
    // Always validate when schedule fields change, even if paused
    const validated = state.calculateNextRun(newType, newValue);
    if (validated === null) {
      return json(
        { error: 'Invalid schedule: could not calculate next run time' },
        400,
      );
    }
    if (effectiveStatus === 'active') updates.next_run = validated;
  } else if (
    effectiveStatus === 'active' &&
    beingResumed &&
    newType !== 'once'
  ) {
    const nextRun = state.calculateNextRun(newType, newValue);
    if (nextRun === null) {
      return json(
        { error: 'Invalid schedule: could not calculate next run time' },
        400,
      );
    }
    updates.next_run = nextRun;
  }

  try {
    state.updateTask(taskId, updates);
  } catch (err) {
    return json(
      {
        error: `Failed to update task: ${err instanceof Error ? err.message : String(err)}`,
      },
      500,
    );
  }

  // Return updated task
  const updated = state.getTaskById(taskId);
  if (!updated) {
    return json({ error: 'Task updated but could not be reloaded' }, 500);
  }
  return json(updated);
}

function handleDeleteTask(taskId: string, state: WebStateProvider): Response {
  const existing = state.getTaskById(taskId);
  if (!existing) return json({ error: 'Task not found' }, 404);

  try {
    state.deleteTask(taskId);
  } catch (err) {
    return json(
      {
        error: `Failed to delete task: ${err instanceof Error ? err.message : String(err)}`,
      },
      500,
    );
  }

  return json({ deleted: true, id: taskId });
}

function handleGetChats(state: WebStateProvider): Response {
  return json(state.getChats());
}

function handleGetMessages(url: URL, state: WebStateProvider): Response {
  // /api/messages/{chatJid}?since=...&limit=...
  let chatJid: string;
  try {
    chatJid = decodeURIComponent(url.pathname.slice('/api/messages/'.length));
  } catch {
    return json({ error: 'Invalid chatJid encoding' }, 400);
  }
  if (!chatJid) return json({ error: 'Missing chatJid' }, 400);

  const since = url.searchParams.get('since') || '1970-01-01T00:00:00.000Z';
  const limit = Math.min(
    Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10) || 100),
    500,
  );
  const messages = state.getMessages(chatJid, since, limit);
  return json(messages);
}

function handleGetStats(state: WebStateProvider): Response {
  const stats = state.getQueueStats();
  const agents = state.getAgents();
  const tasks = state.getTasks();
  let activeTasks = 0,
    pausedTasks = 0,
    completedTasks = 0;
  for (const t of tasks) {
    if (t.status === 'active') activeTasks++;
    else if (t.status === 'paused') pausedTasks++;
    else if (t.status === 'completed') completedTasks++;
  }
  return json({
    agents: Object.keys(agents).length,
    activeTasks,
    pausedTasks,
    completedTasks,
    ...stats,
  });
}

// ---- Context handlers ----

function handleListContextFiles(): Response {
  return json(listLocalContextFiles());
}

function handleGetContextLayers(url: URL, state: WebStateProvider): Response {
  const folder = url.searchParams.get('folder') || '';
  const serverFolder = url.searchParams.get('server_folder') || '';
  const agentContextFolder = url.searchParams.get('agent_context_folder') || '';
  const channelFolder = url.searchParams.get('channel_folder') || '';
  const categoryFolder = url.searchParams.get('category_folder') || '';

  // Resolve the 4 layer paths (relative to GROUPS_DIR)
  const channelPath = channelFolder || folder;
  const agentPath = agentContextFolder || null;
  const categoryPath = categoryFolder || null;
  const serverPath = serverFolder || null;

  const layers: Record<
    string,
    { path: string | null; content: string | null; exists: boolean }
  > = {
    channel: {
      path: channelPath || null,
      content: channelPath ? state.readContextFile(channelPath) : null,
      exists: channelPath ? state.readContextFile(channelPath) !== null : false,
    },
    agent: {
      path: agentPath,
      content: agentPath ? state.readContextFile(agentPath) : null,
      exists: agentPath ? state.readContextFile(agentPath) !== null : false,
    },
    category: {
      path: categoryPath,
      content: categoryPath ? state.readContextFile(categoryPath) : null,
      exists: categoryPath
        ? state.readContextFile(categoryPath) !== null
        : false,
    },
    server: {
      path: serverPath,
      content: serverPath ? state.readContextFile(serverPath) : null,
      exists: serverPath ? state.readContextFile(serverPath) !== null : false,
    },
  };

  return json(layers);
}

async function handleWriteContextFile(
  req: Request,
  state: WebStateProvider,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { path: layerPath, content } = body;
  if (!layerPath || typeof layerPath !== 'string') {
    return json({ error: 'Missing or invalid "path" (string required)' }, 400);
  }
  if (typeof content !== 'string') {
    return json(
      { error: 'Missing or invalid "content" (string required)' },
      400,
    );
  }

  // Reject path traversal
  if (layerPath.includes('..') || layerPath.startsWith('/')) {
    return json({ error: 'Invalid path: must be relative, no ".."' }, 400);
  }

  try {
    state.writeContextFile(layerPath, content);
  } catch (err) {
    return json(
      {
        error: `Failed to write: ${err instanceof Error ? err.message : String(err)}`,
      },
      500,
    );
  }

  return json({ ok: true });
}

function handleGetQueueDetails(state: WebStateProvider): Response {
  return json(state.getQueueDetails());
}

function handleGetIpcEvents(url: URL, state: WebStateProvider): Response {
  const countParam = url.searchParams.get('count');
  const count = countParam
    ? Math.min(Math.max(1, parseInt(countParam, 10) || 50), 200)
    : 50;
  return json(state.getIpcEvents(count));
}

// ---- Avatar handlers ----

function handleGetAgentAvatar(
  agentId: string,
  state: WebStateProvider,
): Response {
  const agents = state.getAgents();
  const agent = agents[agentId];
  if (!agent) return json({ error: 'Agent not found' }, 404);
  return json({
    avatarUrl: agent.avatarUrl || null,
    avatarSource: agent.avatarSource || null,
  });
}

async function handleGetAgentAvatarImage(
  agentId: string,
  state: WebStateProvider,
): Promise<Response> {
  const agents = state.getAgents();
  const agent = agents[agentId];
  if (!agent) return json({ error: 'Agent not found' }, 404);
  if (!agent.avatarUrl) return json({ error: 'Avatar not found' }, 404);

  if (agent.avatarUrl.startsWith('/avatars/')) {
    const response = handleServeAvatar(agent.avatarUrl);
    response.headers.set('Cache-Control', 'private, max-age=86400');
    return response;
  }

  const response = await serveCachedRemoteImage(
    `agent:${agentId}:${agent.avatarUrl}`,
    async () => agent.avatarUrl || null,
  );
  return response || json({ error: 'Failed to fetch avatar' }, 502);
}

async function handleGetChatIcon(
  chatJid: string,
  state: WebStateProvider,
): Promise<Response> {
  if (!state.resolveChatImage) return json({ error: 'Not supported' }, 404);
  const response = await serveCachedRemoteImage(`chat:${chatJid}`, async () =>
    state.resolveChatImage!(chatJid),
  );
  return response || json({ error: 'Icon not found' }, 404);
}

async function handleGetDiscordGuildIcon(
  guildId: string,
  botId: string | null,
  state: WebStateProvider,
): Promise<Response> {
  if (!state.resolveDiscordGuildImage) {
    return json({ error: 'Not supported' }, 404);
  }
  const response = await serveCachedRemoteImage(
    `discord-guild:${guildId}:${botId || ''}`,
    async () => state.resolveDiscordGuildImage!(guildId, botId || undefined),
  );
  return response || json({ error: 'Icon not found' }, 404);
}

const VALID_AVATAR_SOURCES = new Set([
  'discord',
  'telegram',
  'slack',
  'custom',
]);

async function handleSetAgentAvatar(
  agentId: string,
  req: Request,
  state: WebStateProvider,
): Promise<Response> {
  const agents = state.getAgents();
  const agent = agents[agentId];
  if (!agent) return json({ error: 'Agent not found' }, 404);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { source, url } = body;
  if (source && !VALID_AVATAR_SOURCES.has(source as string)) {
    return json(
      { error: '"source" must be discord | telegram | slack | custom' },
      400,
    );
  }

  state.updateAgentAvatar(
    agentId,
    (url as string) || null,
    (source as string) || null,
  );

  return json({
    success: true,
    agentId,
    avatarUrl: (url as string) || null,
    avatarSource: (source as string) || null,
  });
}

/** Folder name pattern (same validation as db.ts). */
const VALID_FOLDER_RE = /^[a-z0-9][a-z0-9_-]*$/i;

function handleServeAvatar(pathname: string): Response {
  // Expected format: /avatars/{folder}/avatar.png
  const rest = pathname.slice('/avatars/'.length);
  const parts = rest.split('/');
  if (parts.length !== 2) return json({ error: 'Not found' }, 404);

  const [folder, filename] = parts;
  if (!VALID_FOLDER_RE.test(folder)) {
    return json({ error: 'Invalid folder' }, 400);
  }
  if (filename !== 'avatar.png') return json({ error: 'Not found' }, 404);

  const filePath = path.join(GROUPS_DIR, folder, 'avatar.png');
  assertPathWithin(filePath, GROUPS_DIR, 'avatar file');

  if (!fs.existsSync(filePath)) return json({ error: 'Not found' }, 404);

  return new Response(Bun.file(filePath), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' },
  });
}

// ---- Helpers ----

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    },
  });
}
