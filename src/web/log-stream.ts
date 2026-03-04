import { logger, type Logger, type LogRecord } from '../logger.js';
import type { WebServerHandle } from './server.js';
import type { WsEvent } from './types.js';

/**
 * Bridge between the structured logger and WebSocket clients.
 * Subscribes to log events and broadcasts them to connected clients
 * on the 'logs' WebSocket channel.
 *
 * Accepts an optional logger instance for testability. Defaults to
 * the global logger.
 *
 * Returns an unsubscribe function for cleanup on shutdown.
 */
export function startLogStream(
  webServer: WebServerHandle,
  loggerInstance: Logger = logger,
): () => void {
  const unsubscribe = loggerInstance.subscribe((record: LogRecord) => {
    // Skip trace-level logs — too noisy for the UI
    if (record.level === 'trace') return;

    const event: WsEvent = {
      type: 'log',
      data: {
        ts: record.ts,
        level: record.level,
        msg: record.msg,
        // Include useful context fields for the dashboard
        ...(record.op ? { op: record.op } : {}),
        ...(record.container ? { container: record.container } : {}),
        ...(record.group ? { group: record.group } : {}),
        ...(record.err ? { err: record.err } : {}),
        ...(record.durationMs != null ? { durationMs: record.durationMs } : {}),
        ...(record.costUsd != null ? { costUsd: record.costUsd } : {}),
      },
      timestamp: new Date(record.ts as number).toISOString(),
    };

    webServer.broadcast(event);
  });

  return unsubscribe;
}
