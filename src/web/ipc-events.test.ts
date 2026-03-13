import { afterEach, describe, expect, it } from 'bun:test';

import { IpcEventBuffer } from './ipc-events.js';

const RealDate = Date;

function installFixedDate(iso: string) {
  const fixed = new RealDate(iso);

  class FixedDate extends RealDate {
    constructor(value?: string | number | Date) {
      super(value ?? fixed.getTime());
    }

    static override now(): number {
      return fixed.getTime();
    }
  }

  globalThis.Date = FixedDate as unknown as DateConstructor;
}

afterEach(() => {
  globalThis.Date = RealDate;
});

describe('IpcEventBuffer', () => {
  it('assigns incrementing ids and a deterministic timestamp', () => {
    installFixedDate('2026-03-10T12:34:56.000Z');
    const buffer = new IpcEventBuffer();

    const event = buffer.push('task_created', 'main', 'Created task', {
      taskId: 'task-1',
    });

    expect(event).toEqual({
      id: 1,
      kind: 'task_created',
      timestamp: '2026-03-10T12:34:56.000Z',
      sourceGroup: 'main',
      summary: 'Created task',
      details: { taskId: 'task-1' },
    });
  });

  it('evicts the oldest events when the ring buffer reaches capacity', () => {
    const buffer = new IpcEventBuffer(2);

    buffer.push('message_sent', 'a', 'first');
    buffer.push('message_sent', 'b', 'second');
    buffer.push('task_cancelled', 'c', 'third');

    expect(buffer.size).toBe(2);
    expect(buffer.since(0).map((event) => event.summary)).toEqual([
      'second',
      'third',
    ]);
  });

  it('returns recent events newest-first and respects the count', () => {
    const buffer = new IpcEventBuffer();

    buffer.push('message_sent', 'a', 'first');
    buffer.push('message_blocked', 'b', 'second');
    buffer.push('ipc_error', 'c', 'third');

    expect(buffer.recent(2).map((event) => event.summary)).toEqual([
      'third',
      'second',
    ]);
  });

  it('returns only events newer than the provided id', () => {
    const buffer = new IpcEventBuffer();

    buffer.push('message_sent', 'a', 'first');
    buffer.push('task_edited', 'b', 'second');
    buffer.push('task_error', 'c', 'third');

    expect(buffer.since(1).map((event) => event.id)).toEqual([2, 3]);
    expect(buffer.since(3)).toEqual([]);
  });
});
