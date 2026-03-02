import type { WebStateProvider } from './types.js';
import { renderDashboard } from './dashboard.js';

/**
 * Handle an authenticated HTTP request and return a Response.
 * Routing is prefix-based: /api/* for JSON, / for the dashboard HTML.
 */
export function handleRequest(
  req: Request,
  state: WebStateProvider,
): Response {
  const url = new URL(req.url);
  const { pathname } = url;

  // --- API routes ---
  if (pathname === '/api/agents') return handleGetAgents(state);
  if (pathname === '/api/tasks') return handleGetTasks(req, state);
  if (pathname === '/api/chats') return handleGetChats(state);
  if (pathname.startsWith('/api/messages/'))
    return handleGetMessages(url, state);
  if (pathname === '/api/stats') return handleGetStats(state);

  // --- Dashboard ---
  if (pathname === '/' || pathname === '/index.html')
    return new Response(renderDashboard(state), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });

  return json({ error: 'Not found' }, 404);
}

// ---- Handlers ----

function handleGetAgents(state: WebStateProvider): Response {
  const agents = state.getAgents();
  const subscriptions = state.getChannelSubscriptions();

  // Enrich each agent with its channel list
  const agentList = Object.values(agents).map((agent) => {
    const channels: string[] = [];
    for (const [jid, subs] of Object.entries(subscriptions)) {
      if (subs.some((s) => s.agentId === agent.id)) {
        channels.push(jid);
      }
    }
    return { ...agent, channels };
  });

  return json(agentList);
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

function handleGetChats(state: WebStateProvider): Response {
  return json(state.getChats());
}

function handleGetMessages(url: URL, state: WebStateProvider): Response {
  // /api/messages/{chatJid}?since=...&limit=...
  const chatJid = decodeURIComponent(url.pathname.slice('/api/messages/'.length));
  if (!chatJid) return json({ error: 'Missing chatJid' }, 400);

  const since = url.searchParams.get('since') || '1970-01-01T00:00:00.000Z';
  const limit = Math.min(
    parseInt(url.searchParams.get('limit') || '100', 10) || 100,
    500,
  );
  const messages = state.getMessages(chatJid, since, limit);
  return json(messages);
}

function handleGetStats(state: WebStateProvider): Response {
  const stats = state.getQueueStats();
  const agents = state.getAgents();
  const tasks = state.getTasks();
  return json({
    agents: Object.keys(agents).length,
    activeTasks: tasks.filter((t) => t.status === 'active').length,
    pausedTasks: tasks.filter((t) => t.status === 'paused').length,
    completedTasks: tasks.filter((t) => t.status === 'completed').length,
    ...stats,
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
