/**
 * Effect Logger Layer for OmniClaw.
 *
 * Outputs the same flat JSON schema as src/logger.ts so all log output
 * (imperative and Effect) is consistent and parseable by log-fmt.sh.
 */

import { Effect, Layer, List, Logger, LogLevel } from 'effect';

const isTTY = process.stderr.isTTY;

function effectLevelToString(level: LogLevel.LogLevel): string {
  if (LogLevel.greaterThanEqual(level, LogLevel.Fatal)) return 'fatal';
  if (LogLevel.greaterThanEqual(level, LogLevel.Error)) return 'error';
  if (LogLevel.greaterThanEqual(level, LogLevel.Warning)) return 'warn';
  if (LogLevel.greaterThanEqual(level, LogLevel.Info)) return 'info';
  if (LogLevel.greaterThanEqual(level, LogLevel.Debug)) return 'debug';
  return 'trace';
}

/**
 * Build the OmniClaw structured logger for Effect.
 * Outputs identical JSON format as the imperative logger.
 */
const omniClawLogger = Logger.make(({ logLevel, message, annotations, date, spans }) => {
  const level = effectLevelToString(logLevel);

  // Flatten annotations to top-level fields
  const fields: Record<string, unknown> = {};
  for (const [key, value] of annotations) {
    fields[key] = value;
  }

  // Convert the first LogSpan to op + durationMs
  const firstSpan = List.head(spans);
  if (firstSpan._tag === 'Some') {
    fields.op = firstSpan.value.label;
    fields.durationMs = date.getTime() - firstSpan.value.startTime;
  }

  // Extract message text
  const msg = typeof message === 'string'
    ? message
    : Array.isArray(message)
      ? message.map(String).join(' ')
      : String(message);

  const record: Record<string, unknown> = {
    ts: date.getTime(),
    level,
    msg,
    service: 'omniclaw',
    ...fields,
  };

  if (isTTY) {
    // Delegate to the same pretty-print format
    const ts = formatTimestamp(date.getTime());
    const tag = (record.container || record.group || '-') as string;
    const RST = '\x1b[0m';
    const DIM = '\x1b[2m';
    const BOLD = '\x1b[1m';
    const color = level === 'error' || level === 'fatal' ? '\x1b[31m' : '\x1b[2m';
    const levelTag = level === 'error' || level === 'fatal' || level === 'warn'
      ? ` ${level.toUpperCase()} `
      : '';
    process.stderr.write(
      `${DIM}${ts}${RST} ${BOLD}${String(tag).slice(0, 16).padEnd(16)}${RST} ${color}${levelTag}${msg}${RST}\n`,
    );
  } else {
    process.stderr.write(JSON.stringify(record) + '\n');
  }
});

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * Layer that replaces the default Effect logger with OmniClaw's structured logger.
 * Use with Effect.provide(OmniClawLoggerLayer).
 */
export const OmniClawLoggerLayer = Logger.replace(Logger.defaultLogger, omniClawLogger);
