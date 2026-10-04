import { describe, it, expect, beforeEach, mock } from 'bun:test';

import realFs from 'fs';

import {
  GroupQueue,
  deriveMessageLaneReason,
  deriveTaskLaneReason,
  describeLaneReason,
  summarizeError,
  MESSAGE_LANE_REASONS,
  TASK_LANE_REASONS,
  MESSAGE_LANE_REASON_META,
  TASK_LANE_REASON_META,
  type MessageLaneReason,
  type TaskLaneReason,
} from './group-queue.js';

mock.restore();

describe('lane reason registry', () => {
  it('lists every message-lane reason that derivation can produce', () => {
    // Exercise all derivation branches and confirm each result is in the
    // canonical list — guards against the list drifting from the union type.
    const produced = new Set<MessageLaneReason>([
      deriveMessageLaneReason({
        laneState: 'running',
        pendingCount: 0,
        retryCount: 0,
      }),
      deriveMessageLaneReason({
        laneState: 'cooldown',
        pendingCount: 0,
        retryCount: 0,
      }),
      deriveMessageLaneReason({
        laneState: 'idle',
        pendingCount: 0,
        retryCount: 1,
      }),
      deriveMessageLaneReason({
        laneState: 'idle',
        pendingCount: 1,
        retryCount: 0,
      }),
      deriveMessageLaneReason({
        laneState: 'idle',
        pendingCount: 0,
        retryCount: 0,
      }),
    ]);
    for (const reason of produced) {
      expect(MESSAGE_LANE_REASONS).toContain(reason);
    }
    // Every canonical reason should be reachable by some derivation input.
    expect([...produced].sort()).toEqual([...MESSAGE_LANE_REASONS].sort());
  });

  it('lists every task-lane reason that derivation can produce', () => {
    const produced = new Set<TaskLaneReason>([
      deriveTaskLaneReason({ active: true, pendingCount: 0 }),
      deriveTaskLaneReason({ active: false, pendingCount: 1 }),
      deriveTaskLaneReason({ active: false, pendingCount: 0 }),
    ]);
    expect([...produced].sort()).toEqual([...TASK_LANE_REASONS].sort());
  });

  it('has no duplicate entries in the canonical lists', () => {
    expect(new Set(MESSAGE_LANE_REASONS).size).toBe(
      MESSAGE_LANE_REASONS.length,
    );
    expect(new Set(TASK_LANE_REASONS).size).toBe(TASK_LANE_REASONS.length);
  });

  it('provides non-empty label and description metadata for every reason', () => {
    for (const reason of MESSAGE_LANE_REASONS) {
      const meta = MESSAGE_LANE_REASON_META[reason];
      expect(meta).toBeDefined();
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
    }
    for (const reason of TASK_LANE_REASONS) {
      const meta = TASK_LANE_REASON_META[reason];
      expect(meta).toBeDefined();
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
    }
  });

  it('describeLaneReason resolves known codes and falls back safely', () => {
    expect(describeLaneReason('no-work')).toEqual(
      MESSAGE_LANE_REASON_META['no-work'],
    );
    // Task-only codes resolve via the message-lane superset map.
    expect(describeLaneReason('back-pressure').label).toBe('Back-pressure');
    // Unknown code returns a neutral, non-throwing fallback.
    const unknown = describeLaneReason('mystery' as MessageLaneReason);
    expect(unknown.label).toBe('mystery');
    expect(unknown.description).toBe('');
  });
});

describe('GroupQueue', () => {
  let queue: GroupQueue;
  let fsImpl: Pick<typeof realFs, 'mkdirSync' | 'writeFileSync' | 'renameSync'>;

  beforeEach(() => {
    fsImpl = {
      ...realFs,
      mkdirSync: mock(),
      writeFileSync: mock(),
      renameSync: mock(),
    };
    queue = new GroupQueue({
      dataDir: '/tmp/omniclaw-test-data',
      maxActiveContainers: 3,
      maxIdleContainers: 0,
      maxTaskContainers: 2,
      fsImpl,
    });
  });

  // --- Message lane isolation ---

  it('only runs one message container per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;
    const resolvers: Array<() => void> = [];

    const processMessages = mock(async (_groupJid: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise<void>((r) => resolvers.push(r));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    await Bun.sleep(10);
    expect(maxConcurrent).toBe(1);

    // Let first finish, second should drain
    resolvers[0]();
    await Bun.sleep(10);

    // Second call should now be running
    resolvers[1]?.();
    await Bun.sleep(10);
  });

  // --- Message enqueue while task is active ---

  it('message runs immediately even when task lane is active', async () => {
    let messageStarted = false;
    let taskResolve: () => void;

    const processMessages = mock(async () => {
      messageStarted = true;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start a task (occupies task lane)
    queue.enqueueTask(
      'group1@g.us',
      'task-1',
      () =>
        new Promise<void>((resolve) => {
          taskResolve = resolve;
        }),
      'Test task',
    );
    await Bun.sleep(10);

    expect(queue.isActive('group1@g.us', 'task')).toBe(true);

    // Enqueue a message — should run immediately on message lane
    queue.enqueueMessageCheck('group1@g.us');
    await Bun.sleep(10);

    expect(messageStarted).toBe(true);

    // Clean up
    taskResolve!();
    await Bun.sleep(10);
  });

  // --- Task enqueue while message is active ---

  it('task runs immediately even when message lane is active', async () => {
    let messageResolve: () => void;
    let taskRan = false;

    const processMessages = mock(async () => {
      await new Promise<void>((resolve) => {
        messageResolve = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start message processing
    queue.enqueueMessageCheck('group1@g.us');
    await Bun.sleep(10);

    expect(queue.isActive('group1@g.us', 'message')).toBe(true);

    // Enqueue a task — should run immediately on task lane
    queue.enqueueTask(
      'group1@g.us',
      'task-1',
      async () => {
        taskRan = true;
      },
      'Test task',
    );
    await Bun.sleep(10);

    expect(taskRan).toBe(true);

    // Clean up
    messageResolve!();
    await Bun.sleep(10);
  });

  // --- Both lanes active simultaneously ---

  it('both message and task lanes can be active at the same time', async () => {
    let messageResolve: () => void;
    let taskResolve: () => void;

    const processMessages = mock(async () => {
      await new Promise<void>((resolve) => {
        messageResolve = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('group1@g.us');
    await Bun.sleep(10);

    queue.enqueueTask(
      'group1@g.us',
      'task-1',
      () =>
        new Promise<void>((resolve) => {
          taskResolve = resolve;
        }),
      'Test task',
    );
    await Bun.sleep(10);

    expect(queue.isActive('group1@g.us', 'message')).toBe(true);
    expect(queue.isActive('group1@g.us', 'task')).toBe(true);
    expect(queue.isActive('group1@g.us')).toBe(true);

    messageResolve!();
    taskResolve!();
    await Bun.sleep(10);
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit across both lanes', async () => {
    const resolvers: Array<() => void> = [];

    const processMessages = mock(async () => {
      await new Promise<void>((resolve) => resolvers.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill all 3 slots (MAX_CONCURRENT_CONTAINERS = 3)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueTask(
      'group2@g.us',
      'task-1',
      () => new Promise<void>((resolve) => resolvers.push(resolve)),
      'Task 1',
    );
    queue.enqueueMessageCheck('group3@g.us');
    await Bun.sleep(10);

    expect(resolvers.length).toBe(3);

    // 4th should be queued (over global limit)
    let fourthStarted = false;
    queue.enqueueTask(
      'group4@g.us',
      'task-2',
      async () => {
        fourthStarted = true;
      },
      'Task 2',
    );
    await Bun.sleep(10);
    expect(fourthStarted).toBe(false);

    // Free one slot — 4th should start
    resolvers[0]();
    await Bun.sleep(10);
    expect(fourthStarted).toBe(true);

    // Clean up
    for (const r of resolvers.slice(1)) r();
    await Bun.sleep(10);
  });

  // --- Task concurrency limit ---

  it('respects MAX_TASK_CONTAINERS limit', async () => {
    const resolvers: Array<() => void> = [];

    queue.setProcessMessagesFn(mock(async () => true));

    // Start 2 tasks (MAX_TASK_CONTAINERS = 2)
    queue.enqueueTask(
      'group1@g.us',
      'task-1',
      () => new Promise<void>((resolve) => resolvers.push(resolve)),
      'Task 1',
    );
    queue.enqueueTask(
      'group2@g.us',
      'task-2',
      () => new Promise<void>((resolve) => resolvers.push(resolve)),
      'Task 2',
    );
    await Bun.sleep(10);

    expect(resolvers.length).toBe(2);

    // 3rd task should be queued
    let thirdStarted = false;
    queue.enqueueTask(
      'group3@g.us',
      'task-3',
      async () => {
        thirdStarted = true;
      },
      'Task 3',
    );
    await Bun.sleep(10);
    expect(thirdStarted).toBe(false);

    // But a message should still get through
    let messageStarted = false;
    queue.setProcessMessagesFn(
      mock(async () => {
        messageStarted = true;
        return true;
      }),
    );
    queue.enqueueMessageCheck('group3@g.us');
    await Bun.sleep(10);
    expect(messageStarted).toBe(true);

    // Free a task slot — 3rd task should start
    resolvers[0]();
    await Bun.sleep(10);
    expect(thirdStarted).toBe(true);

    // Clean up
    resolvers[1]();
    await Bun.sleep(10);
  });

  // --- activeTaskInfo tracking ---

  it('tracks activeTaskInfo while task is running', async () => {
    let taskResolve: () => void;

    queue.setProcessMessagesFn(mock(async () => true));

    expect(queue.getActiveTaskInfo('group1@g.us')).toBeNull();

    queue.enqueueTask(
      'group1@g.us',
      'task-42',
      () =>
        new Promise<void>((resolve) => {
          taskResolve = resolve;
        }),
      'Run daily report',
    );
    await Bun.sleep(10);

    const info = queue.getActiveTaskInfo('group1@g.us');
    expect(info).not.toBeNull();
    expect(info!.taskId).toBe('task-42');
    expect(info!.promptPreview).toBe('Run daily report');
    expect(info!.startedAt).toBeGreaterThan(0);

    taskResolve!();
    await Bun.sleep(10);

    expect(queue.getActiveTaskInfo('group1@g.us')).toBeNull();
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = mock(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueTask('group1@g.us', 'task-1', async () => {}, 'Test');
    await Bun.sleep(50);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting message groups when active slots free up', async () => {
    const processed: string[] = [];
    const resolvers: Array<() => void> = [];

    const processMessages = mock(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => resolvers.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill all 3 slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');
    await Bun.sleep(10);

    // Queue a 4th
    queue.enqueueMessageCheck('group4@g.us');
    await Bun.sleep(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us', 'group3@g.us']);

    // Free up a slot
    resolvers[0]();
    await Bun.sleep(10);

    expect(processed).toContain('group4@g.us');

    // Clean up
    for (const r of resolvers.slice(1)) r();
    await Bun.sleep(10);
  });

  // --- isActive with lane parameter ---

  it('isActive returns correct state per lane', async () => {
    let messageResolve: () => void;
    let taskResolve: () => void;

    const processMessages = mock(async () => {
      await new Promise<void>((resolve) => {
        messageResolve = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    expect(queue.isActive('group1@g.us')).toBe(false);
    expect(queue.isActive('group1@g.us', 'message')).toBe(false);
    expect(queue.isActive('group1@g.us', 'task')).toBe(false);

    queue.enqueueMessageCheck('group1@g.us');
    await Bun.sleep(10);

    expect(queue.isActive('group1@g.us')).toBe(true);
    expect(queue.isActive('group1@g.us', 'message')).toBe(true);
    expect(queue.isActive('group1@g.us', 'task')).toBe(false);

    queue.enqueueTask(
      'group1@g.us',
      'task-1',
      () =>
        new Promise<void>((resolve) => {
          taskResolve = resolve;
        }),
      'Test',
    );
    await Bun.sleep(10);

    expect(queue.isActive('group1@g.us', 'message')).toBe(true);
    expect(queue.isActive('group1@g.us', 'task')).toBe(true);

    messageResolve!();
    await Bun.sleep(10);

    expect(queue.isActive('group1@g.us', 'message')).toBe(false);
    expect(queue.isActive('group1@g.us', 'task')).toBe(true);

    taskResolve!();
    await Bun.sleep(10);
  });

  // --- IPC lane isolation ---

  describe('IPC lane isolation', () => {
    it('sendMessage returns false when only task lane active', async () => {
      let taskResolve: () => void;
      const processMessages = mock(async () => true);
      queue.setProcessMessagesFn(processMessages);

      queue.enqueueTask(
        'group1@g.us',
        'task-1',
        () =>
          new Promise<void>((resolve) => {
            taskResolve = resolve;
          }),
        'Test task',
      );
      await Bun.sleep(10);

      expect(queue.isActive('group1@g.us', 'task')).toBe(true);
      expect(queue.isActive('group1@g.us', 'message')).toBe(false);

      // sendMessage targets message lane only — should return false
      const result = await queue.sendMessage('group1@g.us', 'hello');
      expect(result).toBe(false);

      taskResolve!();
      await Bun.sleep(10);
    });

    it('sendMessage targets message backend only, not task backend', async () => {
      let messageResolve: () => void;
      let taskResolve: () => void;

      const messageSendMock = mock(() => true);
      const taskSendMock = mock(() => true);

      const messageBackend = {
        sendMessage: messageSendMock,
        closeStdin: mock(),
        runAgent: mock(async () => ({
          status: 'success' as const,
          result: null,
        })),
      };
      const taskBackend = {
        sendMessage: taskSendMock,
        closeStdin: mock(),
        runAgent: mock(async () => ({
          status: 'success' as const,
          result: null,
        })),
      };

      const processMessages = mock(async () => {
        await new Promise<void>((resolve) => {
          messageResolve = resolve;
        });
        return true;
      });
      queue.setProcessMessagesFn(processMessages);

      // Start message lane
      queue.enqueueMessageCheck('group1@g.us');
      await Bun.sleep(10);

      // Register message backend
      queue.registerProcess(
        'group1@g.us',
        {} as any,
        'msg-ctr',
        'group1-folder',
        messageBackend as any,
        'message',
      );

      // Start task lane
      queue.enqueueTask(
        'group1@g.us',
        'task-1',
        () =>
          new Promise<void>((resolve) => {
            taskResolve = resolve;
          }),
        'Test task',
      );
      await Bun.sleep(10);

      // Register task backend
      queue.registerProcess(
        'group1@g.us',
        {} as any,
        'task-ctr',
        'group1-folder',
        taskBackend as any,
        'task',
      );

      // sendMessage should only go to message backend
      await queue.sendMessage('group1@g.us', 'reaction text');

      expect(messageSendMock).toHaveBeenCalled();
      expect(taskSendMock).not.toHaveBeenCalled();

      messageResolve!();
      taskResolve!();
      await Bun.sleep(10);
    });

    it('reaction flow: sendMessage returns false when only task active, triggers new message container', async () => {
      let taskResolve: () => void;
      let messageRan = false;

      const processMessages = mock(async () => {
        messageRan = true;
        return true;
      });
      queue.setProcessMessagesFn(processMessages);

      // Start only a task
      queue.enqueueTask(
        'group1@g.us',
        'task-1',
        () =>
          new Promise<void>((resolve) => {
            taskResolve = resolve;
          }),
        'Test task',
      );
      await Bun.sleep(10);

      // Simulate reaction handler: sendMessage fails → enqueue message check
      const sent = await queue.sendMessage('group1@g.us', 'reaction');
      expect(sent).toBe(false);

      // This is what the reaction handler would do on failure
      queue.enqueueMessageCheck('group1@g.us');
      await Bun.sleep(10);

      expect(messageRan).toBe(true);
      expect(queue.isActive('group1@g.us', 'message')).toBe(false); // already completed
      expect(queue.isActive('group1@g.us', 'task')).toBe(true);

      taskResolve!();
      await Bun.sleep(10);
    });

    it('reaction flow: sendMessage succeeds when both lanes active', async () => {
      let messageResolve: () => void;
      let taskResolve: () => void;

      const messageSendMock = mock(() => true);
      const messageBackend = {
        sendMessage: messageSendMock,
        closeStdin: mock(),
        runAgent: mock(async () => ({
          status: 'success' as const,
          result: null,
        })),
      };

      const processMessages = mock(async () => {
        await new Promise<void>((resolve) => {
          messageResolve = resolve;
        });
        return true;
      });
      queue.setProcessMessagesFn(processMessages);

      // Start both lanes
      queue.enqueueMessageCheck('group1@g.us');
      await Bun.sleep(10);
      queue.registerProcess(
        'group1@g.us',
        {} as any,
        'msg-ctr',
        'group1-folder',
        messageBackend as any,
        'message',
      );

      queue.enqueueTask(
        'group1@g.us',
        'task-1',
        () =>
          new Promise<void>((resolve) => {
            taskResolve = resolve;
          }),
        'Test task',
      );
      await Bun.sleep(10);

      // sendMessage should succeed via message backend
      const sent = await queue.sendMessage('group1@g.us', 'reaction text');
      expect(sent).toBe(true);
      expect(messageSendMock).toHaveBeenCalled();

      messageResolve!();
      taskResolve!();
      await Bun.sleep(10);
    });

    it('closeStdin targets correct lane subdirectory', async () => {
      let messageResolve: () => void;
      let taskResolve: () => void;

      const messageCloseMock = mock((_folder: string, _subdir: string) => {});
      const taskCloseMock = mock((_folder: string, _subdir: string) => {});

      const messageBackend = {
        sendMessage: mock(() => true),
        closeStdin: messageCloseMock,
        runAgent: mock(async () => ({
          status: 'success' as const,
          result: null,
        })),
      };
      const taskBackend = {
        sendMessage: mock(() => true),
        closeStdin: taskCloseMock,
        runAgent: mock(async () => ({
          status: 'success' as const,
          result: null,
        })),
      };

      const processMessages = mock(async () => {
        await new Promise<void>((resolve) => {
          messageResolve = resolve;
        });
        return true;
      });
      queue.setProcessMessagesFn(processMessages);

      // Start both lanes
      queue.enqueueMessageCheck('group1@g.us');
      await Bun.sleep(10);
      queue.registerProcess(
        'group1@g.us',
        {} as any,
        'msg-ctr',
        'group1-folder',
        messageBackend as any,
        'message',
      );

      queue.enqueueTask(
        'group1@g.us',
        'task-1',
        () =>
          new Promise<void>((resolve) => {
            taskResolve = resolve;
          }),
        'Test task',
      );
      await Bun.sleep(10);
      queue.registerProcess(
        'group1@g.us',
        {} as any,
        'task-ctr',
        'group1-folder',
        taskBackend as any,
        'task',
      );

      // Close message lane → should use 'input'
      queue.closeStdin('group1@g.us', 'message');
      expect(messageCloseMock).toHaveBeenCalledWith('group1-folder', 'input');

      // Close task lane → should use 'input-task'
      queue.closeStdin('group1@g.us', 'task');
      expect(taskCloseMock).toHaveBeenCalledWith('group1-folder', 'input-task');

      messageResolve!();
      taskResolve!();
      await Bun.sleep(10);
    });
  });

  it('normalizes dispatch JID to channel JID for IPC routing', async () => {
    const queue = new GroupQueue();
    queue.setProcessMessagesFn(
      mock(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return true;
      }),
    );

    const writes: Array<{
      groupFolder: string;
      text: string;
      chatJid?: string;
    }> = [];
    const backend = {
      name: 'test',
      runAgent: async () => ({ status: 'success', result: 'ok' as const }),
      sendMessage: (
        groupFolder: string,
        text: string,
        opts?: { chatJid?: string },
      ) => {
        writes.push({ groupFolder, text, chatJid: opts?.chatJid });
        return true;
      },
      closeStdin: () => {},
      writeIpcData: () => {},
      readFile: async () => null,
      writeFile: async () => {},
      initialize: async () => {},
      shutdown: async () => {},
    };

    const dispatchJid = 'dc:123::agent::ocpeyton-discord';
    queue.enqueueMessageCheck(dispatchJid);
    queue.registerProcess(
      dispatchJid,
      { killed: false } as any,
      'container-1',
      'ocpeyton-discord',
      backend as any,
      'message',
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    const sent = await queue.sendMessage(dispatchJid, 'hello');
    expect(sent).toBe(true);
    expect(writes.length).toBe(1);
    expect(writes[0].chatJid).toBe('dc:123');
  });

  // --- Task deduplication ---

  it('prevents double-queuing of the same task', async () => {
    let taskRunCount = 0;
    let taskResolve: () => void;

    queue.setProcessMessagesFn(mock(async () => true));

    // Start a task to occupy the lane
    queue.enqueueTask(
      'group1@g.us',
      'task-blocker',
      () =>
        new Promise<void>((resolve) => {
          taskResolve = resolve;
        }),
      'Blocker',
    );
    await Bun.sleep(10);

    // Try to enqueue the same task twice while lane is occupied
    queue.enqueueTask(
      'group1@g.us',
      'task-dup',
      async () => {
        taskRunCount++;
      },
      'Dup',
    );
    queue.enqueueTask(
      'group1@g.us',
      'task-dup',
      async () => {
        taskRunCount++;
      },
      'Dup',
    );

    // Release the blocker
    taskResolve!();
    await Bun.sleep(10);

    expect(taskRunCount).toBe(1);
  });

  describe('notifyIdle', () => {
    it('derives detailed message lane stats from the explicit lane state', async () => {
      queue = new GroupQueue({
        dataDir: '/tmp/omniclaw-test-data',
        maxActiveContainers: 3,
        maxIdleContainers: 1,
        maxTaskContainers: 2,
        fsImpl,
      });
      let processResolve: (() => void) | null = null;
      const backendSend = mock(() => true);
      queue.setProcessMessagesFn(
        () =>
          new Promise<boolean>((resolve) => {
            processResolve = () => resolve(true);
          }),
      );

      queue.enqueueMessageCheck('group1@g.us');
      await Bun.sleep(5);
      queue.registerProcess(
        'group1@g.us',
        { killed: false } as any,
        'msg-ctr',
        'group1-folder',
        {
          sendMessage: backendSend,
          closeStdin: mock(),
          runAgent: mock(async () => ({
            status: 'success' as const,
            result: null,
          })),
        } as any,
        'message',
      );

      let detail = queue
        .getDetailedStats()
        .find((d) => d.folderKey === 'group1@g.us');
      expect(detail?.messageLane.active).toBe(true);
      expect(detail?.messageLane.idle).toBe(false);

      queue.notifyIdle('group1@g.us');
      detail = queue
        .getDetailedStats()
        .find((d) => d.folderKey === 'group1@g.us');
      expect(detail?.messageLane.active).toBe(true);
      expect(detail?.messageLane.idle).toBe(true);

      const sent = await queue.sendMessage('group1@g.us', 'wake up');
      expect(sent).toBe(true);
      expect(backendSend).toHaveBeenCalled();

      detail = queue
        .getDetailedStats()
        .find((d) => d.folderKey === 'group1@g.us');
      expect(detail?.messageLane.active).toBe(true);
      expect(detail?.messageLane.idle).toBe(false);

      processResolve!();
      await Bun.sleep(5);
    });

    it('should never let active - idle go negative after container exits', async () => {
      let processResolve: (() => void) | null = null;
      queue.setProcessMessagesFn(
        () =>
          new Promise<boolean>((resolve) => {
            processResolve = () => resolve(true);
          }),
      );

      queue.enqueueMessageCheck('group1@g.us');
      await Bun.sleep(5);

      expect(queue.getStats().activeContainers).toBe(1);

      // Simulate multiple idle notifications from the same container
      // (the IPC stream can emit multiple 'success' statuses).
      // With MAX_IDLE_CONTAINERS=0, each notifyIdle triggers immediate preemption,
      // but without the duplicate guard the idleCount could drift.
      queue.notifyIdle('group1@g.us');
      queue.notifyIdle('group1@g.us');
      queue.notifyIdle('group1@g.us');

      // Invariant: active - idle must never be negative
      const stats = queue.getStats();
      expect(
        stats.activeContainers - stats.idleContainers,
      ).toBeGreaterThanOrEqual(0);

      processResolve!();
      await Bun.sleep(5);

      // After container exits, counts should be balanced
      const final = queue.getStats();
      expect(final.activeContainers).toBe(0);
      expect(final.idleContainers).toBe(0);
    });
  });

  describe('atomic message dispatch transitions', () => {
    it('drains a waiting group exactly once when a slot opens', async () => {
      queue = new GroupQueue({
        dataDir: '/tmp/omniclaw-test-data',
        maxActiveContainers: 1,
        maxIdleContainers: 0,
        maxTaskContainers: 2,
        fsImpl,
      });

      const started: string[] = [];
      const resolvers = new Map<string, () => void>();
      queue.setProcessMessagesFn(
        mock(
          (groupJid: string) =>
            new Promise<boolean>((resolve) => {
              started.push(groupJid);
              resolvers.set(groupJid, () => resolve(true));
            }),
        ),
      );

      queue.enqueueMessageCheck('group1@g.us');
      await Bun.sleep(10);

      queue.enqueueMessageCheck('group2@g.us');
      queue.enqueueMessageCheck('group2@g.us');
      await Bun.sleep(10);

      expect(
        queue.getDetailedStats().find((d) => d.folderKey === 'group2@g.us')
          ?.messageLane.pendingCount,
      ).toBe(1);

      resolvers.get('group1@g.us')?.();
      await Bun.sleep(10);

      expect(started.filter((jid) => jid === 'group2@g.us')).toHaveLength(1);
      expect(
        queue.getDetailedStats().find((d) => d.folderKey === 'group2@g.us')
          ?.messageLane.pendingCount,
      ).toBe(0);

      resolvers.get('group2@g.us')?.();
      await Bun.sleep(10);
    });

    it('captures last error message on caught failure and clears on success', async () => {
      const scheduled: Array<() => void> = [];
      const originalSetTimeout = globalThis.setTimeout;
      let attempts = 0;

      queue.setProcessMessagesFn(
        mock(async () => {
          attempts++;
          if (attempts === 1) {
            throw new Error('processor blew up');
          }
          return true;
        }),
      );

      (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
        fn: Parameters<typeof setTimeout>[0],
      ) => {
        scheduled.push(fn as () => void);
        return { id: 'retry' } as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout;

      try {
        queue.enqueueMessageCheck('group1@g.us');
        await Bun.sleep(10);

        let detail = queue
          .getDetailedStats()
          .find((g) => g.folderKey === 'group1@g.us');
        expect(detail).toBeDefined();
        expect(detail!.retryCount).toBe(1);
        expect(detail!.messageLane.lastError).not.toBeNull();
        expect(detail!.messageLane.lastError!.message).toBe(
          'processor blew up',
        );
        expect(typeof detail!.messageLane.lastError!.at).toBe('number');

        // Trigger the retry; this time the processor succeeds.
        scheduled[0]();
        await Bun.sleep(10);

        detail = queue
          .getDetailedStats()
          .find((g) => g.folderKey === 'group1@g.us');
        expect(detail).toBeDefined();
        expect(detail!.retryCount).toBe(0);
        expect(detail!.messageLane.lastError).toBeNull();
      } finally {
        (globalThis as { setTimeout: typeof setTimeout }).setTimeout =
          originalSetTimeout;
      }
    });

    it('captures task lane last error on failure and clears on success', async () => {
      queue.setProcessMessagesFn(mock(async () => true));

      queue.enqueueTask(
        'group1@g.us',
        'task-fail',
        async () => {
          throw new Error('task blew up');
        },
        'Failing task',
      );
      await Bun.sleep(10);

      let detail = queue
        .getDetailedStats()
        .find((g) => g.folderKey === 'group1@g.us');
      expect(detail).toBeDefined();
      expect(detail!.taskLane.lastError).not.toBeNull();
      expect(detail!.taskLane.lastError!.message).toBe('task blew up');
      expect(typeof detail!.taskLane.lastError!.at).toBe('number');

      // A subsequent successful task on the same lane clears the error.
      queue.enqueueTask(
        'group1@g.us',
        'task-ok',
        async () => {},
        'Passing task',
      );
      await Bun.sleep(10);

      detail = queue
        .getDetailedStats()
        .find((g) => g.folderKey === 'group1@g.us');
      expect(detail).toBeDefined();
      expect(detail!.taskLane.lastError).toBeNull();
    });

    it('does not record a lastError when the processor merely returns false', async () => {
      const scheduled: Array<() => void> = [];
      const originalSetTimeout = globalThis.setTimeout;

      queue.setProcessMessagesFn(mock(async () => false));

      (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
        fn: Parameters<typeof setTimeout>[0],
      ) => {
        scheduled.push(fn as () => void);
        return { id: 'retry' } as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout;

      try {
        queue.enqueueMessageCheck('group1@g.us');
        await Bun.sleep(10);

        const detail = queue
          .getDetailedStats()
          .find((g) => g.folderKey === 'group1@g.us');
        expect(detail).toBeDefined();
        expect(detail!.retryCount).toBe(1);
        // A soft failure (success=false) should not synthesize an error message.
        expect(detail!.messageLane.lastError).toBeNull();
      } finally {
        (globalThis as { setTimeout: typeof setTimeout }).setTimeout =
          originalSetTimeout;
      }
    });

    it('truncates very long error messages and collapses whitespace', async () => {
      const scheduled: Array<() => void> = [];
      const originalSetTimeout = globalThis.setTimeout;
      const longMessage = 'x'.repeat(500) + '\n\nmore stuff';

      queue.setProcessMessagesFn(
        mock(async () => {
          throw new Error(longMessage);
        }),
      );

      (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
        fn: Parameters<typeof setTimeout>[0],
      ) => {
        scheduled.push(fn as () => void);
        return { id: 'retry' } as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout;

      try {
        queue.enqueueMessageCheck('group1@g.us');
        await Bun.sleep(10);

        const detail = queue
          .getDetailedStats()
          .find((g) => g.folderKey === 'group1@g.us');
        expect(detail).toBeDefined();
        const captured = detail!.messageLane.lastError;
        expect(captured).not.toBeNull();
        expect(captured!.message.length).toBeLessThanOrEqual(200);
        expect(captured!.message.endsWith('\u2026')).toBe(true);
        expect(captured!.message).not.toContain('\n');
      } finally {
        (globalThis as { setTimeout: typeof setTimeout }).setTimeout =
          originalSetTimeout;
      }
    });

    it('resets active counts before scheduling a retry', async () => {
      const scheduled: Array<() => void> = [];
      const originalSetTimeout = globalThis.setTimeout;
      let attempts = 0;

      queue.setProcessMessagesFn(
        mock(async () => {
          attempts++;
          return attempts > 1;
        }),
      );

      (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
        fn: Parameters<typeof setTimeout>[0],
      ) => {
        scheduled.push(fn as () => void);
        return { id: 'retry' } as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout;

      try {
        queue.enqueueMessageCheck('group1@g.us');
        await Bun.sleep(10);

        expect(queue.getStats().activeContainers).toBe(0);
        expect(scheduled).toHaveLength(1);

        scheduled[0]();
        await Bun.sleep(10);

        expect(attempts).toBe(2);
        expect(queue.getStats().activeContainers).toBe(0);
      } finally {
        (globalThis as { setTimeout: typeof setTimeout }).setTimeout =
          originalSetTimeout;
      }
    });
  });
});

describe('summarizeError', () => {
  it('returns a string for undefined without throwing', () => {
    expect(typeof summarizeError(undefined)).toBe('string');
  });

  it('returns a string for function inputs without throwing', () => {
    expect(typeof summarizeError(() => {})).toBe('string');
  });

  it('returns a string for symbol inputs without throwing', () => {
    expect(typeof summarizeError(Symbol('x'))).toBe('string');
  });

  it('preserves Error messages and collapses whitespace', () => {
    expect(summarizeError(new Error('boom\n  details'))).toBe('boom details');
  });

  it('passes string inputs through with whitespace collapsing', () => {
    expect(summarizeError('hello\n  world')).toBe('hello world');
  });
});

describe('deriveMessageLaneReason', () => {
  it("returns 'running' when lane is running regardless of pending/retry", () => {
    expect(
      deriveMessageLaneReason({
        laneState: 'running',
        pendingCount: 0,
        retryCount: 0,
      }),
    ).toBe('running');
    expect(
      deriveMessageLaneReason({
        laneState: 'running',
        pendingCount: 5,
        retryCount: 2,
      }),
    ).toBe('running');
  });

  it("returns 'cooling-down' when lane is in cooldown", () => {
    expect(
      deriveMessageLaneReason({
        laneState: 'cooldown',
        pendingCount: 0,
        retryCount: 0,
      }),
    ).toBe('cooling-down');
  });

  it("returns 'retrying' when idle and retryCount > 0", () => {
    expect(
      deriveMessageLaneReason({
        laneState: 'idle',
        pendingCount: 0,
        retryCount: 1,
      }),
    ).toBe('retrying');
    // Retry takes precedence over back-pressure when idle
    expect(
      deriveMessageLaneReason({
        laneState: 'idle',
        pendingCount: 5,
        retryCount: 2,
      }),
    ).toBe('retrying');
  });

  it("returns 'back-pressure' when idle with pending work and no retry", () => {
    expect(
      deriveMessageLaneReason({
        laneState: 'idle',
        pendingCount: 3,
        retryCount: 0,
      }),
    ).toBe('back-pressure');
  });

  it("returns 'no-work' when idle with nothing pending or retrying", () => {
    expect(
      deriveMessageLaneReason({
        laneState: 'idle',
        pendingCount: 0,
        retryCount: 0,
      }),
    ).toBe('no-work');
  });
});

describe('deriveTaskLaneReason', () => {
  it("returns 'running' when active", () => {
    expect(deriveTaskLaneReason({ active: true, pendingCount: 0 })).toBe(
      'running',
    );
    expect(deriveTaskLaneReason({ active: true, pendingCount: 4 })).toBe(
      'running',
    );
  });

  it("returns 'back-pressure' when not active but pending tasks exist", () => {
    expect(deriveTaskLaneReason({ active: false, pendingCount: 2 })).toBe(
      'back-pressure',
    );
  });

  it("returns 'no-work' when not active and no pending tasks", () => {
    expect(deriveTaskLaneReason({ active: false, pendingCount: 0 })).toBe(
      'no-work',
    );
  });
});

describe('GroupQueue.getDetailedStats reason codes', () => {
  it('exposes reason codes for empty queue (no groups)', () => {
    const fresh = new GroupQueue({
      dataDir: '/tmp/omniclaw-test-data-reason',
      maxActiveContainers: 1,
      maxIdleContainers: 0,
      maxTaskContainers: 1,
      fsImpl: {
        ...realFs,
        mkdirSync: mock(),
        writeFileSync: mock(),
        renameSync: mock(),
      },
    });
    expect(fresh.getDetailedStats()).toEqual([]);
  });
});

describe('GroupQueue.getDetailedStats message lane run age', () => {
  const fsStub = {
    ...realFs,
    mkdirSync: mock(),
    writeFileSync: mock(),
    renameSync: mock(),
  };

  it('reports startedAt/runningMs while a message run is in flight', async () => {
    const queue = new GroupQueue({
      dataDir: '/tmp/omniclaw-test-data-msgage',
      maxActiveContainers: 1,
      maxIdleContainers: 0,
      maxTaskContainers: 1,
      fsImpl: fsStub,
    });

    let resolveRun: (() => void) | null = null;
    queue.setProcessMessagesFn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRun = () => resolve(true);
        }),
    );

    const before = Date.now();
    queue.enqueueMessageCheck('groupA@g.us');
    await Bun.sleep(5);

    const inFlight = queue
      .getDetailedStats()
      .find((d) => d.folderKey === 'groupA@g.us');
    expect(inFlight?.messageLane.active).toBe(true);
    expect(typeof inFlight?.messageLane.startedAt).toBe('number');
    expect(inFlight?.messageLane.startedAt).toBeGreaterThanOrEqual(before);
    expect(typeof inFlight?.messageLane.runningMs).toBe('number');
    expect(inFlight?.messageLane.runningMs).toBeGreaterThanOrEqual(0);

    resolveRun!();
    await Bun.sleep(5);

    const after = queue
      .getDetailedStats()
      .find((d) => d.folderKey === 'groupA@g.us');
    // After the run finishes the lane returns to idle and the timer clears.
    expect(after?.messageLane.active).toBe(false);
    expect(after?.messageLane.startedAt).toBeNull();
    expect(after?.messageLane.runningMs).toBeNull();
  });

  it('clears startedAt/runningMs while in cooldown and restamps when sendMessage resumes', async () => {
    const queue = new GroupQueue({
      dataDir: '/tmp/omniclaw-test-data-msgage-cooldown',
      maxActiveContainers: 1,
      maxIdleContainers: 1,
      maxTaskContainers: 1,
      fsImpl: fsStub,
    });

    let resolveRun: (() => void) | null = null;
    queue.setProcessMessagesFn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRun = () => resolve(true);
        }),
    );

    const backendSend = mock(() => true);
    queue.enqueueMessageCheck('groupC@g.us');
    await Bun.sleep(5);
    queue.registerProcess(
      'groupC@g.us',
      { killed: false } as any,
      'msg-ctr-c',
      'groupC-folder',
      {
        sendMessage: backendSend,
        closeStdin: mock(),
        runAgent: mock(async () => ({
          status: 'success' as const,
          result: null,
        })),
      } as any,
      'message',
    );

    // While running we have an age.
    const inFlight = queue
      .getDetailedStats()
      .find((d) => d.folderKey === 'groupC@g.us');
    expect(typeof inFlight?.messageLane.startedAt).toBe('number');
    expect(typeof inFlight?.messageLane.runningMs).toBe('number');

    // Entering cooldown clears the age so /ipc doesn't grow it while idle.
    queue.notifyIdle('groupC@g.us');
    const cooling = queue
      .getDetailedStats()
      .find((d) => d.folderKey === 'groupC@g.us');
    expect(cooling?.messageLane.idle).toBe(true);
    expect(cooling?.messageLane.startedAt).toBeNull();
    expect(cooling?.messageLane.runningMs).toBeNull();

    // Resuming via sendMessage stamps a fresh start time.
    const beforeResume = Date.now();
    const sent = await queue.sendMessage('groupC@g.us', 'wake up');
    expect(sent).toBe(true);
    const resumed = queue
      .getDetailedStats()
      .find((d) => d.folderKey === 'groupC@g.us');
    expect(resumed?.messageLane.idle).toBe(false);
    expect(typeof resumed?.messageLane.startedAt).toBe('number');
    expect(resumed?.messageLane.startedAt).toBeGreaterThanOrEqual(beforeResume);
    expect(typeof resumed?.messageLane.runningMs).toBe('number');
    expect(resumed?.messageLane.runningMs).toBeGreaterThanOrEqual(0);

    resolveRun!();
    await Bun.sleep(5);
  });

  it('does not reset startedAt on sendMessage when lane is already running', async () => {
    const queue = new GroupQueue({
      dataDir: '/tmp/omniclaw-test-data-msgage-running',
      maxActiveContainers: 1,
      maxIdleContainers: 0,
      maxTaskContainers: 1,
      fsImpl: fsStub,
    });

    let resolveRun: (() => void) | null = null;
    queue.setProcessMessagesFn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRun = () => resolve(true);
        }),
    );

    const backendSend = mock(() => true);
    queue.enqueueMessageCheck('groupD@g.us');
    await Bun.sleep(5);
    queue.registerProcess(
      'groupD@g.us',
      { killed: false } as any,
      'msg-ctr-d',
      'groupD-folder',
      {
        sendMessage: backendSend,
        closeStdin: mock(),
        runAgent: mock(async () => ({
          status: 'success' as const,
          result: null,
        })),
      } as any,
      'message',
    );

    // Snapshot the initial run start time while the lane is `running`.
    const inFlight = queue
      .getDetailedStats()
      .find((d) => d.folderKey === 'groupD@g.us');
    const originalStartedAt = inFlight?.messageLane.startedAt;
    expect(typeof originalStartedAt).toBe('number');

    // Wait long enough for Date.now() to advance.
    await Bun.sleep(10);

    // Follow-up sendMessage on an already-running lane must NOT restamp
    // startedAt — otherwise long-running/stuck runs get underreported on /ipc.
    const sent = await queue.sendMessage('groupD@g.us', 'follow-up');
    expect(sent).toBe(true);
    const afterFollowUp = queue
      .getDetailedStats()
      .find((d) => d.folderKey === 'groupD@g.us');
    expect(afterFollowUp?.messageLane.startedAt).toBe(originalStartedAt);

    resolveRun!();
    await Bun.sleep(5);
  });

  it('clears startedAt/runningMs after a message run finishes', async () => {
    const queue = new GroupQueue({
      dataDir: '/tmp/omniclaw-test-data-msgage-done',
      maxActiveContainers: 1,
      maxIdleContainers: 0,
      maxTaskContainers: 1,
      fsImpl: fsStub,
    });

    queue.setProcessMessagesFn(async () => true);
    queue.enqueueMessageCheck('groupB@g.us');
    await Bun.sleep(20);

    const detail = queue
      .getDetailedStats()
      .find((d) => d.folderKey === 'groupB@g.us');
    // After completion the lane should be idle with timers cleared.
    expect(detail?.messageLane.active).toBe(false);
    expect(detail?.messageLane.startedAt).toBeNull();
    expect(detail?.messageLane.runningMs).toBeNull();
  });
});
