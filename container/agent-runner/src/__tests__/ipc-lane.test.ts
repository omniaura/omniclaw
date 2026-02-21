import { describe, it, expect } from 'bun:test';
import { resolveIpcInputDir } from '../index.ts';

describe('IPC lane selection', () => {
  it('returns message lane when isScheduledTask is false', () => {
    expect(resolveIpcInputDir(false)).toBe('/workspace/ipc/input');
  });

  it('returns message lane when isScheduledTask is undefined', () => {
    expect(resolveIpcInputDir(undefined)).toBe('/workspace/ipc/input');
  });

  it('returns task lane when isScheduledTask is true', () => {
    expect(resolveIpcInputDir(true)).toBe('/workspace/ipc/input-task');
  });
});
