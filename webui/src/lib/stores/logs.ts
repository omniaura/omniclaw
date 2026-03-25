import { createStore } from 'solid-js/store';

const MAX_LOG_LINES = 500;

export interface LogLine {
  ts: number;
  level: string;
  msg: string;
  op?: string;
  container?: string;
  group?: string;
  err?: string;
  durationMs?: number;
  costUsd?: number;
}

interface LogsState {
  lines: LogLine[];
}

const [logs, setLogs] = createStore<LogsState>({ lines: [] });

export { logs };

export function appendLog(line: LogLine) {
  setLogs('lines', (prev) => {
    const next = [...prev, line];
    if (next.length > MAX_LOG_LINES) {
      return next.slice(next.length - MAX_LOG_LINES);
    }
    return next;
  });
}

export function clearLogs() {
  setLogs('lines', []);
}
