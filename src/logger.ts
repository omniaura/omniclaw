/**
 * Structured logger for OmniClaw.
 *
 * Pino-compatible API: logger.info({fields}, 'msg') or logger.info('msg').
 * Flat JSON to stderr (production) or colorized text (TTY).
 *
 * Replaces pino + pino-pretty with zero dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_VALUES: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

interface LogFn {
  (msg: string): void;
  (fields: Record<string, unknown>, msg: string): void;
}

export interface Logger {
  level: string;
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  child(fields: Record<string, unknown>): Logger;
}

// ---------------------------------------------------------------------------
// TTY pretty-print colors
// ---------------------------------------------------------------------------

const isTTY = process.stderr.isTTY;

const RST = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';

function levelColor(level: LogLevel): string {
  switch (level) {
    case 'fatal': return RED;
    case 'error': return RED;
    case 'warn': return YELLOW;
    case 'info': return GREEN;
    case 'debug': return DIM;
    case 'trace': return DIM;
  }
}

function opColor(op: string | undefined): string {
  if (!op) return DIM;
  switch (op) {
    case 'containerSpawn':
    case 'channelConnect':
    case 'startup':
      return GREEN;
    case 'containerExit':
      return RED;
    case 'ipcProcess':
      return BLUE;
    case 'messageReceived':
    case 'channelSend':
      return YELLOW;
    case 'taskRun':
      return MAGENTA;
    case 'agentRun':
      return CYAN;
    default:
      return DIM;
  }
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// ---------------------------------------------------------------------------
// Error flattening
// ---------------------------------------------------------------------------

function flattenError(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const err = fields.err;
  if (err == null) return fields;

  const out = { ...fields };
  if (err instanceof Error) {
    out.err = err.message;
    if ((err as any).code) out.errCode = (err as any).code;
    if (process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace') {
      out.errStack = err.stack;
    }
  } else if (typeof err === 'object') {
    // Effect errors, plain objects, etc.
    const e = err as any;
    out.err = e.message || e.reason || String(err);
    if (e.code) out.errCode = e.code;
  } else {
    out.err = String(err);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Core write functions
// ---------------------------------------------------------------------------

function writeJSON(record: Record<string, unknown>): void {
  process.stderr.write(JSON.stringify(record) + '\n');
}

function writePretty(
  level: LogLevel,
  record: Record<string, unknown>,
): void {
  const ts = formatTimestamp(record.ts as number);
  const tag = (record.container || record.group || '-') as string;
  const op = record.op as string | undefined;
  const msg = record.msg as string;

  // Pick color: errors/fatals override, then op-based, then level-based
  let color: string;
  if (level === 'error' || level === 'fatal') {
    color = RED;
  } else {
    color = op ? opColor(op) : levelColor(level);
  }

  // Build inline metrics suffix
  let suffix = '';
  if (record.durationMs != null) suffix += ` (${record.durationMs}ms)`;
  if (record.messageCount != null) suffix += ` [${record.messageCount} msgs]`;
  if (record.turns != null) suffix += ` turns=${record.turns}`;
  if (record.costUsd != null) suffix += ` $${record.costUsd}`;
  if (record.exitCode != null) suffix += ` exit=${record.exitCode}`;
  if (record.err && typeof record.err === 'string') suffix += ` ERR: ${record.err}`;

  const levelTag = level === 'error' || level === 'fatal' || level === 'warn'
    ? ` ${level.toUpperCase()}`
    : '';

  process.stderr.write(
    `${DIM}${ts}${RST} ${BOLD}${(tag as string).slice(0, 16).padEnd(16)}${RST} ${color}${levelTag}${levelTag ? ' ' : ''}${msg}${suffix}${RST}\n`,
  );
}

// ---------------------------------------------------------------------------
// Logger factory
// ---------------------------------------------------------------------------

function createLogger(defaults: Record<string, unknown> = {}, levelOverride?: string): Logger {
  const effectiveLevel = levelOverride || process.env.LOG_LEVEL || 'info';
  const minLevel = LEVEL_VALUES[effectiveLevel as LogLevel] ?? LEVEL_VALUES.info;

  function write(
    level: LogLevel,
    fieldsOrMsg: Record<string, unknown> | string,
    msg?: string,
  ): void {
    const numLevel = LEVEL_VALUES[level];
    // Never drop error/fatal regardless of LOG_LEVEL
    if (numLevel < minLevel && numLevel < LEVEL_VALUES.error) return;

    const now = Date.now();
    let userFields: Record<string, unknown>;
    let message: string;

    if (typeof fieldsOrMsg === 'string') {
      userFields = {};
      message = fieldsOrMsg;
    } else {
      userFields = fieldsOrMsg;
      message = msg ?? '';
    }

    const merged = flattenError({ ...defaults, ...userFields });
    const record: Record<string, unknown> = {
      ts: now,
      level,
      msg: message,
      service: 'omniclaw',
      ...merged,
    };

    if (isTTY) {
      writePretty(level, record);
    } else {
      writeJSON(record);
    }
  }

  function makeLogFn(level: LogLevel): LogFn {
    return ((
      fieldsOrMsg: Record<string, unknown> | string,
      msg?: string,
    ): void => {
      write(level, fieldsOrMsg, msg);
    }) as LogFn;
  }

  const self: Logger = {
    level: effectiveLevel,
    trace: makeLogFn('trace'),
    debug: makeLogFn('debug'),
    info: makeLogFn('info'),
    warn: makeLogFn('warn'),
    error: makeLogFn('error'),
    fatal: makeLogFn('fatal'),
    child(fields: Record<string, unknown>): Logger {
      return createLogger({ ...defaults, ...fields }, effectiveLevel);
    },
  };

  return self;
}

// ---------------------------------------------------------------------------
// Default export — drop-in replacement for `import { logger } from './logger.js'`
// ---------------------------------------------------------------------------

export const logger = createLogger();

// Route uncaught errors through structured logger
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});

export { createLogger };
