import type { APIEvent } from '@solidjs/start/server';
import { getState } from '~/lib/server-state';

const MAX_EXPORT_LIMIT = 5000;

export function GET({ params, request }: APIEvent) {
  const state = getState();
  const chatJid = params.chatJid;
  if (!chatJid)
    return Response.json({ error: 'Missing chatJid' }, { status: 400 });

  const url = new URL(request.url);
  const format = url.searchParams.get('format') || 'json';
  if (format !== 'json' && format !== 'text')
    return Response.json(
      { error: 'Invalid format. Use "json" or "text".' },
      { status: 400 },
    );

  const limit = Math.min(
    Math.max(1, parseInt(url.searchParams.get('limit') || '5000', 10) || 5000),
    MAX_EXPORT_LIMIT,
  );
  const messages = state.getMessages(
    chatJid,
    '1970-01-01T00:00:00.000Z',
    limit,
  );

  const chats = state.getChats() as Array<{
    jid: string;
    name: string;
    last_message_time: string;
  }>;
  const chatName =
    chats.find((c: { jid: string }) => c.jid === chatJid)?.name || chatJid;

  if (format === 'text') {
    const lines: string[] = [];
    lines.push(`# Conversation: ${chatName}`);
    lines.push(`# JID: ${chatJid}`);
    lines.push(`# Exported: ${new Date().toISOString()}`);
    lines.push(`# Messages: ${messages.length}`);
    lines.push('');

    for (const msg of messages) {
      const time = new Date(msg.timestamp).toLocaleString();
      const sender = msg.sender_name || msg.sender || 'Unknown';
      lines.push(`[${time}] ${sender}:`);
      lines.push(msg.content || '');
      lines.push('');
    }

    const safeName = chatName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return new Response(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeName}-export.txt"`,
      },
    });
  }

  // JSON format
  const payload = {
    chat_jid: chatJid,
    chat_name: chatName,
    exported_at: new Date().toISOString(),
    message_count: messages.length,
    messages,
  };
  const safeName = chatName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safeName}-export.json"`,
    },
  });
}
