import { describe, it, expect } from 'bun:test';
import { LogRingBuffer } from './log-buffer.js';

describe('LogRingBuffer', () => {
  it('stores records oldest-first', () => {
    const buf = new LogRingBuffer(10);
    buf.push({ level: 'info', msg: 'a' });
    buf.push({ level: 'info', msg: 'b' });
    expect(buf.recent().map((r) => r.msg)).toEqual(['a', 'b']);
    expect(buf.size).toBe(2);
  });

  it('drops the oldest records past capacity', () => {
    const buf = new LogRingBuffer(3);
    for (const msg of ['a', 'b', 'c', 'd', 'e']) {
      buf.push({ level: 'info', msg });
    }
    expect(buf.size).toBe(3);
    expect(buf.recent().map((r) => r.msg)).toEqual(['c', 'd', 'e']);
  });

  it('filters by level', () => {
    const buf = new LogRingBuffer(10);
    buf.push({ level: 'info', msg: 'i1' });
    buf.push({ level: 'error', msg: 'e1' });
    buf.push({ level: 'info', msg: 'i2' });
    expect(buf.recent({ level: 'error' }).map((r) => r.msg)).toEqual(['e1']);
    expect(buf.recent({ level: 'info' }).map((r) => r.msg)).toEqual([
      'i1',
      'i2',
    ]);
  });

  it('honors the limit (returns the most recent N)', () => {
    const buf = new LogRingBuffer(10);
    for (const msg of ['a', 'b', 'c', 'd']) {
      buf.push({ level: 'info', msg });
    }
    expect(buf.recent({ limit: 2 }).map((r) => r.msg)).toEqual(['c', 'd']);
  });

  it('applies level filter before limit', () => {
    const buf = new LogRingBuffer(10);
    buf.push({ level: 'warn', msg: 'w1' });
    buf.push({ level: 'info', msg: 'i1' });
    buf.push({ level: 'warn', msg: 'w2' });
    buf.push({ level: 'warn', msg: 'w3' });
    expect(buf.recent({ level: 'warn', limit: 2 }).map((r) => r.msg)).toEqual([
      'w2',
      'w3',
    ]);
  });

  it('ignores non-positive or non-finite limits', () => {
    const buf = new LogRingBuffer(10);
    buf.push({ level: 'info', msg: 'a' });
    buf.push({ level: 'info', msg: 'b' });
    expect(buf.recent({ limit: 0 }).length).toBe(2);
    expect(buf.recent({ limit: -3 }).length).toBe(2);
    expect(buf.recent({ limit: Number.NaN }).length).toBe(2);
  });

  it('returns a copy — mutating the result does not affect the buffer', () => {
    const buf = new LogRingBuffer(10);
    buf.push({ level: 'info', msg: 'a' });
    const out = buf.recent();
    out.push({ level: 'info', msg: 'injected' });
    expect(buf.size).toBe(1);
  });

  it('clamps invalid capacities to at least one slot', () => {
    const buf = new LogRingBuffer(0);
    buf.push({ level: 'info', msg: 'a' });
    buf.push({ level: 'info', msg: 'b' });
    expect(buf.size).toBe(1);
    expect(buf.recent()[0]?.msg).toBe('b');
  });

  it('clear() empties the buffer', () => {
    const buf = new LogRingBuffer(10);
    buf.push({ level: 'info', msg: 'a' });
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.recent()).toEqual([]);
  });
});
