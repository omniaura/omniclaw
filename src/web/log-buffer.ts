/**
 * Bounded ring buffer of recent structured log records.
 *
 * The HTML dashboard SSE stream (`/api/events`) already backfills newly
 * connected clients with recent *rendered* log lines. The raw structured
 * stream (`/api/logs/stream`), however, only delivers records that arrive
 * after a client connects — there is no way to fetch history as JSON.
 *
 * This buffer captures serialized (JSON-safe) records so the
 * `/api/logs/recent` endpoint can return log history to JSON consumers
 * (the raw log viewer, the SolidStart frontend, external tooling) without
 * having to keep an SSE connection open the whole time.
 *
 * Records are stored oldest-first. When the buffer exceeds its capacity the
 * oldest records are dropped.
 */

export type SerializedLogRecord = Record<string, unknown>;

export class LogRingBuffer {
  private readonly records: SerializedLogRecord[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number) {
    // Guard against non-positive/NaN sizes — always keep at least one slot.
    this.maxSize = Number.isFinite(maxSize) && maxSize > 0 ? maxSize : 1;
  }

  /** Append a record, dropping the oldest entries past capacity. */
  push(record: SerializedLogRecord): void {
    this.records.push(record);
    if (this.records.length > this.maxSize) {
      this.records.splice(0, this.records.length - this.maxSize);
    }
  }

  /**
   * Return recent records (oldest-first).
   *
   * @param opts.level - if set, only records whose `level` matches are returned.
   * @param opts.limit - if set (and > 0), return at most the last N matching records.
   */
  recent(opts: { level?: string; limit?: number } = {}): SerializedLogRecord[] {
    const { level, limit } = opts;
    let out =
      level != null
        ? this.records.filter((r) => r.level === level)
        : this.records.slice();
    if (level == null) {
      // slice() above already copied; avoid a second copy for the common path.
    }
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      out = out.slice(Math.max(0, out.length - Math.floor(limit)));
    }
    return out;
  }

  /** Number of records currently buffered. */
  get size(): number {
    return this.records.length;
  }

  /** Drop all buffered records. */
  clear(): void {
    this.records.length = 0;
  }
}
