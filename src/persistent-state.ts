import { getRouterState, setRouterState } from './db.js';
import { logger } from './logger.js';

export function readPersistentJson<T>(key: string): T | undefined {
  let raw: string | undefined;

  try {
    raw = getRouterState(key);
  } catch (err) {
    logger.warn({ err, key }, 'Failed to read persistent state');
    return undefined;
  }

  if (!raw) return undefined;

  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.warn({ err, key }, 'Failed to parse persistent state JSON');
    return undefined;
  }
}

export function writePersistentJson(key: string, value: unknown): void {
  try {
    setRouterState(key, JSON.stringify(value));
  } catch (err) {
    logger.warn({ err, key }, 'Failed to write persistent state');
  }
}
