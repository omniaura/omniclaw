import { logger } from './logger.js';
import { readPersistentJson, writePersistentJson } from './persistent-state.js';

const RESUME_POSITIONS_STATE_KEY = 'resume_positions';

export interface ResumePositionStore {
  get(groupFolder: string): string | undefined;
  set(groupFolder: string, resumeAt: string): void;
  getAll(): Record<string, string>;
  clear(): void;
}

export class MemoryResumePositionStore implements ResumePositionStore {
  constructor(private readonly state: Record<string, string>) {}

  get(groupFolder: string): string | undefined {
    return this.state[groupFolder];
  }

  set(groupFolder: string, resumeAt: string): void {
    this.state[groupFolder] = resumeAt;
  }

  getAll(): Record<string, string> {
    return this.state;
  }

  clear(): void {
    for (const key of Object.keys(this.state)) {
      delete this.state[key];
    }
  }
}

export interface PersistentStateAdapter {
  read<T>(key: string): T | undefined;
  write(key: string, value: unknown): void;
}

interface PersistentStoreOptions {
  stateAdapter?: PersistentStateAdapter;
}

const defaultStateAdapter: PersistentStateAdapter = {
  read: readPersistentJson,
  write: writePersistentJson,
};

export class PersistentResumePositionStore implements ResumePositionStore {
  private readonly memoryStore: MemoryResumePositionStore;
  private readonly stateAdapter: PersistentStateAdapter;

  constructor(options?: PersistentStoreOptions) {
    this.stateAdapter = options?.stateAdapter ?? defaultStateAdapter;
    this.memoryStore = new MemoryResumePositionStore(this.loadInitialState());
  }

  get(groupFolder: string): string | undefined {
    return this.memoryStore.get(groupFolder);
  }

  set(groupFolder: string, resumeAt: string): void {
    this.memoryStore.set(groupFolder, resumeAt);
    this.persist();
  }

  getAll(): Record<string, string> {
    return this.memoryStore.getAll();
  }

  clear(): void {
    this.memoryStore.clear();
    this.persist();
  }

  private loadInitialState(): Record<string, string> {
    try {
      const persisted = this.stateAdapter.read<unknown>(
        RESUME_POSITIONS_STATE_KEY,
      );
      return sanitizeResumePositions(persisted);
    } catch (err) {
      logger.warn({ err }, 'Failed to load persisted resume positions');
      return {};
    }
  }

  private persist(): void {
    try {
      this.stateAdapter.write(
        RESUME_POSITIONS_STATE_KEY,
        this.memoryStore.getAll(),
      );
    } catch (err) {
      logger.warn({ err }, 'Failed to persist resume positions');
    }
  }
}

interface CreateStoreOptions {
  persistentTaskState: boolean;
  initialResumePositions?: Record<string, string>;
}

export function createResumePositionStore(
  options: CreateStoreOptions,
): ResumePositionStore {
  if (options.persistentTaskState) {
    return new PersistentResumePositionStore();
  }

  return new MemoryResumePositionStore(options.initialResumePositions ?? {});
}

function sanitizeResumePositions(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const sanitized: Record<string, string> = {};

  for (const [key, entryValue] of Object.entries(record)) {
    if (typeof entryValue === 'string') {
      sanitized[key] = entryValue;
    }
  }

  return sanitized;
}
