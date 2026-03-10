import { describe, it, expect } from 'bun:test';

import { createLogger, type Logger, type LogRecord } from '../logger.js';
import { startLogStream } from './log-stream.js';
import type { WebServerHandle } from './server.js';
import type { WsEvent } from './types.js';

// ---- Test helpers ----

/** Create a fresh logger for test isolation (avoids cross-file subscriber issues). */
function makeTestLogger(): Logger {
  return createLogger({}, 'debug');
}

function makeMockServer(): WebServerHandle & { events: WsEvent[] } {
  const events: WsEvent[] = [];
  return {
    port: 0,
    events,
    broadcast(event: WsEvent) {
      events.push(event);
    },
    async stop() {},
    get clientCount() {
      return 0;
    },
    setNetworkPageState() {},
  };
}

function findLogEvent(events: WsEvent[], msg: string): WsEvent | undefined {
  return events.find(
    (e) => e.type === 'log' && (e.data as { msg: string }).msg === msg,
  );
}

describe('Logger.subscribe', () => {
  it('calls subscriber with log records', () => {
    const log = makeTestLogger();
    const records: LogRecord[] = [];
    const unsub = log.subscribe((r) => records.push(r));

    log.info('sub-test');

    const found = records.find((r) => r.msg === 'sub-test');
    expect(found).toBeDefined();
    expect(found!.level).toBe('info');

    unsub();
  });

  it('unsubscribe stops notifications', () => {
    const log = makeTestLogger();
    const records: LogRecord[] = [];
    const unsub = log.subscribe((r) => records.push(r));
    unsub();

    log.info('after-unsub');

    const found = records.find((r) => r.msg === 'after-unsub');
    expect(found).toBeUndefined();
  });

  it('handles multiple subscribers', () => {
    const log = makeTestLogger();
    const records1: LogRecord[] = [];
    const records2: LogRecord[] = [];
    const unsub1 = log.subscribe((r) => records1.push(r));
    const unsub2 = log.subscribe((r) => records2.push(r));

    log.info('multi-sub');

    expect(records1.find((r) => r.msg === 'multi-sub')).toBeDefined();
    expect(records2.find((r) => r.msg === 'multi-sub')).toBeDefined();

    unsub1();
    unsub2();
  });

  it('subscriber errors do not crash the logger', () => {
    const log = makeTestLogger();
    const unsub = log.subscribe(() => {
      throw new Error('boom');
    });

    expect(() => log.info('crash-test')).not.toThrow();

    unsub();
  });

  it('child loggers share subscribers with parent', () => {
    const log = makeTestLogger();
    const records: LogRecord[] = [];
    const unsub = log.subscribe((r) => records.push(r));

    const child = log.child({ group: 'child-group' });
    child.info('child-msg');

    const found = records.find((r) => r.msg === 'child-msg');
    expect(found).toBeDefined();
    expect(found!.group).toBe('child-group');

    unsub();
  });
});

describe('startLogStream', () => {
  it('returns an unsubscribe function', () => {
    const log = makeTestLogger();
    const server = makeMockServer();
    const unsub = startLogStream(server, log);
    expect(typeof unsub).toBe('function');
    unsub();
  });

  it('broadcasts log events from the logger', () => {
    const log = makeTestLogger();
    const server = makeMockServer();
    const unsub = startLogStream(server, log);

    log.info({ op: 'test', container: 'test-container' }, 'Test message');

    const logEvent = findLogEvent(server.events, 'Test message');
    expect(logEvent).toBeDefined();
    expect(logEvent!.type).toBe('log');

    const data = logEvent!.data as Record<string, unknown>;
    expect(data.level).toBe('info');
    expect(data.msg).toBe('Test message');
    expect(data.op).toBe('test');
    expect(data.container).toBe('test-container');
    expect(data.ts).toBeGreaterThan(0);
    expect(logEvent!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    unsub();
  });

  it('skips trace-level logs', () => {
    const log = createLogger({}, 'trace');
    const server = makeMockServer();
    const unsub = startLogStream(server, log);

    log.trace('Should be skipped');

    const traceEvent = server.events.find(
      (e) =>
        e.type === 'log' && (e.data as { level: string }).level === 'trace',
    );
    expect(traceEvent).toBeUndefined();

    unsub();
  });

  it('includes error details in broadcast', () => {
    const log = makeTestLogger();
    const server = makeMockServer();
    const unsub = startLogStream(server, log);

    log.error({ err: new Error('test error') }, 'Something failed');

    const errEvent = findLogEvent(server.events, 'Something failed');
    expect(errEvent).toBeDefined();
    const data = errEvent!.data as Record<string, unknown>;
    expect(data.level).toBe('error');
    expect(data.err).toBe('test error');

    unsub();
  });

  it('includes group context in broadcast', () => {
    const log = makeTestLogger();
    const server = makeMockServer();
    const unsub = startLogStream(server, log);

    const childLog = log.child({ group: 'my-group' });
    childLog.info('Group log');

    const groupEvent = findLogEvent(server.events, 'Group log');
    expect(groupEvent).toBeDefined();
    const data = groupEvent!.data as Record<string, unknown>;
    expect(data.group).toBe('my-group');

    unsub();
  });

  it('includes durationMs and costUsd when present', () => {
    const log = makeTestLogger();
    const server = makeMockServer();
    const unsub = startLogStream(server, log);

    log.info({ durationMs: 1234, costUsd: 0.05 }, 'Agent completed');

    const event = findLogEvent(server.events, 'Agent completed');
    expect(event).toBeDefined();
    const data = event!.data as Record<string, unknown>;
    expect(data.durationMs).toBe(1234);
    expect(data.costUsd).toBe(0.05);

    unsub();
  });

  it('stops broadcasting after unsubscribe', () => {
    const log = makeTestLogger();
    const server = makeMockServer();
    const unsub = startLogStream(server, log);

    log.info('Before unsub');
    expect(findLogEvent(server.events, 'Before unsub')).toBeDefined();

    unsub();

    log.info('After unsub');
    expect(findLogEvent(server.events, 'After unsub')).toBeUndefined();
  });

  it('omits undefined context fields', () => {
    const log = makeTestLogger();
    const server = makeMockServer();
    const unsub = startLogStream(server, log);

    log.info('No context');

    const event = findLogEvent(server.events, 'No context');
    expect(event).toBeDefined();
    const data = event!.data as Record<string, unknown>;
    // These fields should not exist when not provided
    expect('op' in data).toBe(false);
    expect('container' in data).toBe(false);
    expect('group' in data).toBe(false);
    expect('err' in data).toBe(false);

    unsub();
  });

  it('broadcasts warn-level logs', () => {
    const log = makeTestLogger();
    const server = makeMockServer();
    const unsub = startLogStream(server, log);

    log.warn({ op: 'reconnect' }, 'Connection lost');

    const event = findLogEvent(server.events, 'Connection lost');
    expect(event).toBeDefined();
    const data = event!.data as Record<string, unknown>;
    expect(data.level).toBe('warn');
    expect(data.op).toBe('reconnect');

    unsub();
  });
});
