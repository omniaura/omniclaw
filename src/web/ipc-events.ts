/**
 * In-memory ring buffer for recent IPC events.
 * Captures message, task, and error events for the IPC inspector.
 */

export type IpcEventKind =
  | 'message_sent'
  | 'message_blocked'
  | 'message_suppressed'
  | 'task_created'
  | 'task_edited'
  | 'task_cancelled'
  | 'task_error'
  | 'group_registered'
  | 'ipc_error';

export interface IpcEvent {
  id: number;
  kind: IpcEventKind;
  timestamp: string;
  sourceGroup: string;
  summary: string;
  details?: Record<string, unknown>;
}

const DEFAULT_MAX_EVENTS = 200;

export class IpcEventBuffer {
  private events: IpcEvent[] = [];
  private nextId = 1;
  private maxEvents: number;

  constructor(maxEvents = DEFAULT_MAX_EVENTS) {
    this.maxEvents = maxEvents;
  }

  push(
    kind: IpcEventKind,
    sourceGroup: string,
    summary: string,
    details?: Record<string, unknown>,
  ): IpcEvent {
    const event: IpcEvent = {
      id: this.nextId++,
      kind,
      timestamp: new Date().toISOString(),
      sourceGroup,
      summary,
      details,
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
    return event;
  }

  /** Return the most recent N events, newest first. */
  recent(count = 50): IpcEvent[] {
    return this.events.slice(-count).reverse();
  }

  /** Return events newer than the given ID. */
  since(afterId: number): IpcEvent[] {
    return this.events.filter((e) => e.id > afterId);
  }

  /** Current count of buffered events. */
  get size(): number {
    return this.events.length;
  }
}
