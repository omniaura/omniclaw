/**
 * Effect Logger Layer for OmniClaw.
 *
 * Delegates to the imperative logger from src/logger.ts so all formatting
 * (JSON + TTY pretty-print) lives in one place.
 */

import { List, Logger, LogLevel } from 'effect';
import { logger as rootLogger } from '../logger.js';
import type { Logger as OmniLogger } from '../logger.js';

type LogMethod = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

function effectLevelToMethod(level: LogLevel.LogLevel): LogMethod {
  if (LogLevel.greaterThanEqual(level, LogLevel.Fatal)) return 'fatal';
  if (LogLevel.greaterThanEqual(level, LogLevel.Error)) return 'error';
  if (LogLevel.greaterThanEqual(level, LogLevel.Warning)) return 'warn';
  if (LogLevel.greaterThanEqual(level, LogLevel.Info)) return 'info';
  if (LogLevel.greaterThanEqual(level, LogLevel.Debug)) return 'debug';
  return 'trace';
}

/**
 * Effect logger that delegates to the imperative OmniClaw logger.
 * Flattens annotations and LogSpans into fields, then calls logger[level]().
 */
const omniClawLogger = Logger.make(
  ({ logLevel, message, annotations, date, spans }) => {
    const method = effectLevelToMethod(logLevel);

    // Flatten annotations to fields
    const fields: Record<string, unknown> = {};
    for (const [key, value] of annotations) {
      fields[key] = value;
    }

    // Convert first LogSpan to op + durationMs
    const firstSpan = List.head(spans);
    if (firstSpan._tag === 'Some') {
      fields.op = firstSpan.value.label;
      fields.durationMs = date.getTime() - firstSpan.value.startTime;
    }

    const msg =
      typeof message === 'string'
        ? message
        : Array.isArray(message)
          ? message.map(String).join(' ')
          : String(message);

    // Delegate to the imperative logger — all formatting happens there
    if (Object.keys(fields).length > 0) {
      rootLogger[method](fields, msg);
    } else {
      rootLogger[method](msg);
    }
  },
);

/**
 * Layer that replaces the default Effect logger with OmniClaw's structured logger.
 */
export const OmniClawLoggerLayer = Logger.replace(
  Logger.defaultLogger,
  omniClawLogger,
);
