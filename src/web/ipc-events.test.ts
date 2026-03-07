import { describe, expect, it } from 'bun:test';
import { IpcEventBuffer } from './ipc-events.js';

describe('IpcEventBuffer', () => {
  it('pushes events and returns them via recent()', () => {
    const buf = new IpcEventBuffer();
    buf.push('message_sent', 'group-a', 'Sent to dc:123');
    buf.push('task_created', 'group-b', 'Task created');

    const events = buf.recent(10);
    expect(events).toHaveLength(2);
    // recent() returns newest first
    expect(events[0].kind).toBe('task_created');
    expect(events[1].kind).toBe('message_sent');
  });

  it('assigns incrementing IDs', () => {
    const buf = new IpcEventBuffer();
    const e1 = buf.push('message_sent', 'a', 'msg 1');
    const e2 = buf.push('message_sent', 'a', 'msg 2');
    expect(e2.id).toBe(e1.id + 1);
  });

  it('caps at maxEvents', () => {
    const buf = new IpcEventBuffer(3);
    buf.push('message_sent', 'a', '1');
    buf.push('message_sent', 'a', '2');
    buf.push('message_sent', 'a', '3');
    buf.push('message_sent', 'a', '4');
    expect(buf.size).toBe(3);
    // Oldest event (id=1) should have been evicted
    const events = buf.recent(10);
    expect(events[2].summary).toBe('2');
    expect(events[0].summary).toBe('4');
  });

  it('since() returns events after given ID', () => {
    const buf = new IpcEventBuffer();
    const e1 = buf.push('message_sent', 'a', '1');
    buf.push('task_created', 'b', '2');
    buf.push('task_edited', 'c', '3');

    const after = buf.since(e1.id);
    expect(after).toHaveLength(2);
    expect(after[0].summary).toBe('2');
    expect(after[1].summary).toBe('3');
  });

  it('stores details when provided', () => {
    const buf = new IpcEventBuffer();
    const ev = buf.push('task_created', 'a', 'Task created', {
      taskId: 'task-123',
      targetFolder: 'group-b',
    });
    expect(ev.details).toEqual({
      taskId: 'task-123',
      targetFolder: 'group-b',
    });
  });

  it('sets timestamp on events', () => {
    const buf = new IpcEventBuffer();
    const ev = buf.push('message_sent', 'a', 'test');
    expect(ev.timestamp).toBeTruthy();
    // Should be a valid ISO string
    expect(new Date(ev.timestamp).toISOString()).toBe(ev.timestamp);
  });

  it('returns empty arrays when no events', () => {
    const buf = new IpcEventBuffer();
    expect(buf.recent()).toEqual([]);
    expect(buf.since(0)).toEqual([]);
    expect(buf.size).toBe(0);
  });
});
