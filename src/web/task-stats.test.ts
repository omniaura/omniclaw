import { describe, it, expect } from 'bun:test';

import type { GroupQueueDetail } from '../group-queue.js';
import { countWorkingAgents, formatAgentsValue } from './task-stats.js';

function makeDetail(
  overrides: {
    message?: Partial<GroupQueueDetail['messageLane']>;
    task?: Partial<GroupQueueDetail['taskLane']>;
    folderKey?: string;
  } = {},
): GroupQueueDetail {
  return {
    folderKey: overrides.folderKey ?? 'agent',
    messageLane: {
      active: false,
      idle: true,
      pendingCount: 0,
      containerName: null,
      ...overrides.message,
    },
    taskLane: {
      active: false,
      pendingCount: 0,
      containerName: null,
      activeTask: null,
      ...overrides.task,
    },
    retryCount: 0,
  };
}

describe('countWorkingAgents', () => {
  it('returns 0 when there are no queue details', () => {
    expect(countWorkingAgents([])).toBe(0);
  });

  it('counts an agent processing a message (active, not idle)', () => {
    expect(
      countWorkingAgents([
        makeDetail({ message: { active: true, idle: false } }),
      ]),
    ).toBe(1);
  });

  it('does not count an idle-waiting message lane', () => {
    // active but idle means cooling down / waiting — not actively working.
    expect(
      countWorkingAgents([
        makeDetail({ message: { active: true, idle: true } }),
      ]),
    ).toBe(0);
  });

  it('counts an agent running a scheduled task', () => {
    expect(countWorkingAgents([makeDetail({ task: { active: true } })])).toBe(
      1,
    );
  });

  it('counts an agent only once when both lanes are in flight', () => {
    expect(
      countWorkingAgents([
        makeDetail({
          message: { active: true, idle: false },
          task: { active: true },
        }),
      ]),
    ).toBe(1);
  });

  it('sums working agents across multiple groups', () => {
    expect(
      countWorkingAgents([
        makeDetail({ folderKey: 'a', message: { active: true, idle: false } }),
        makeDetail({ folderKey: 'b', task: { active: true } }),
        makeDetail({ folderKey: 'c' }),
      ]),
    ).toBe(2);
  });
});

describe('formatAgentsValue', () => {
  it('renders a bare count when no agents are working', () => {
    expect(formatAgentsValue(3, 0)).toBe('3');
  });

  it('appends a working annotation when agents are in flight', () => {
    expect(formatAgentsValue(3, 2)).toBe('3 (2 working)');
  });

  it('renders zero total without annotation', () => {
    expect(formatAgentsValue(0, 0)).toBe('0');
  });
});
