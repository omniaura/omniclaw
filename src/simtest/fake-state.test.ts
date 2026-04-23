import { beforeEach, describe, expect, it } from 'bun:test';

import { FakeState } from './fake-state.js';

describe('FakeState', () => {
  let state: FakeState;

  beforeEach(() => {
    state = new FakeState();
  });

  it('filters chat messages by timestamp and limit', () => {
    const allGeneral = state.getMessages(
      'sim:general',
      '1970-01-01T00:00:00.000Z',
    );

    expect(allGeneral.map((message) => message.id)).toEqual([
      'msg-1',
      'msg-2',
      'msg-3',
      'msg-4',
    ]);

    const recentGeneral = state.getMessages(
      'sim:general',
      '2026-01-01T00:00:00.000Z',
      2,
    );

    expect(recentGeneral).toHaveLength(2);
    expect(recentGeneral[0]?.id).toBe('msg-1');
    expect(recentGeneral[1]?.id).toBe('msg-2');
  });

  it('searches messages case-insensitively, sorts newest first, and clamps limits', () => {
    state.addMessage(
      'sim:general',
      'agent:main',
      'Main Assistant',
      'PR #315 regression follow-up ready for review',
    );
    state.addMessage(
      'sim:code-review',
      'agent:code-reviewer',
      'Code Reviewer',
      'PR #315 looks good after the fix',
    );

    const matches = state.searchMessages('  pr #315  ', undefined, 500);

    expect(matches).toHaveLength(4);
    const jids = matches.map((m) => m.chat_jid);
    expect(jids).toContain('sim:general');
    expect(jids).toContain('sim:code-review');
    expect(jids.filter((j) => j === 'sim:general')).toHaveLength(3);
    expect(jids.filter((j) => j === 'sim:code-review')).toHaveLength(1);

    const filtered = state.searchMessages('pr #315', 'sim:general', 1);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.chat_jid).toBe('sim:general');

    expect(state.searchMessages('   ')).toEqual([]);
  });

  it('creates, updates, and deletes tasks with guard rails', () => {
    state.createTask({
      id: 'task-new',
      group_folder: 'main',
      chat_jid: 'sim:general',
      prompt: 'Simulated new task',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'group',
      next_run: '2026-03-24T00:00:00.000Z',
      status: 'active',
      created_at: '2026-03-23T00:00:00.000Z',
    });

    const created = state.getTaskById('task-new');
    expect(created).toMatchObject({
      id: 'task-new',
      prompt: 'Simulated new task',
      executing_since: null,
      last_run: null,
      last_result: null,
    });

    expect(() =>
      state.createTask({
        id: 'task-new',
        group_folder: 'main',
        chat_jid: 'sim:general',
        prompt: 'duplicate',
        schedule_type: 'interval',
        schedule_value: '60000',
        context_mode: 'isolated',
        next_run: '2026-03-24T00:00:00.000Z',
        status: 'active',
        created_at: '2026-03-23T00:00:00.000Z',
      }),
    ).toThrow('Task already exists: task-new');

    state.updateTask('task-new', {
      prompt: 'Updated task prompt',
      status: 'paused',
      next_run: null,
    });
    expect(state.getTaskById('task-new')).toMatchObject({
      prompt: 'Updated task prompt',
      status: 'paused',
      next_run: null,
    });

    expect(() =>
      state.updateTask('missing-task', { status: 'paused' }),
    ).toThrow('Task not found: missing-task');

    state.deleteTask('task-new');
    expect(state.getTaskById('task-new')).toBeUndefined();
    expect(() => state.deleteTask('task-new')).toThrow(
      'Task not found: task-new',
    );
  });

  it('removes agents and cleans up empty subscription lists', () => {
    state.addSubscription('sim:temp', 'research-bot');

    expect(state.removeAgent('research-bot')).toBe(true);
    expect(state.getAgents()['research-bot']).toBeUndefined();
    expect(state.getChannelSubscriptions()['sim:temp']).toBeUndefined();
    expect(
      state
        .getChannelSubscriptions()
        [
          'sim:general'
        ]?.some((subscription) => subscription.agentId === 'research-bot'),
    ).toBe(false);
    expect(state.removeAgent('research-bot')).toBe(false);
  });

  it('tracks message and IPC event mutations and caps event history', () => {
    const previousChatTime = state
      .getChats()
      .find((chat) => chat.jid === 'sim:general')?.last_message_time;

    const message = state.addMessage(
      'sim:general',
      'user:test',
      'Test User',
      'A brand new message',
    );
    expect(message.id).toBe('msg-8');
    expect(
      state.getChats().find((chat) => chat.jid === 'sim:general')
        ?.last_message_time,
    ).not.toBe(previousChatTime);

    for (let i = 0; i < 205; i++) {
      state.addIpcEvent('message_sent', 'main', `event-${i}`);
    }

    expect(state.ipcEvents).toHaveLength(200);
    expect(state.ipcEvents[0]?.summary).toBe('event-5');
    expect(state.ipcEvents.at(-1)?.summary).toBe('event-204');

    const latest = state.getIpcEvents(2);
    expect(latest.map((event) => event.summary)).toEqual([
      'event-204',
      'event-203',
    ]);
  });

  it('updates avatars, task logs, and reset restores seeded state', () => {
    state.updateAgentAvatar(
      'main',
      'https://example.com/avatar.png',
      'discord',
    );
    expect(state.getAgents().main).toMatchObject({
      avatarUrl: 'https://example.com/avatar.png',
      avatarSource: 'discord',
    });

    state.updateAgentAvatar('main', null, null);
    expect(state.getAgents().main?.avatarUrl).toBeUndefined();
    expect(state.getAgents().main?.avatarSource).toBeUndefined();
    expect(() => state.updateAgentAvatar('missing', null, null)).toThrow(
      'Agent not found: missing',
    );

    state.addTaskRunLog('task-heartbeat', {
      run_at: '2026-03-23T10:00:00.000Z',
      duration_ms: 1234,
      status: 'success',
      result: 'fresh result',
      error: null,
    });
    expect(state.getTaskRunLogs('task-heartbeat', 1)[0]).toMatchObject({
      task_id: 'task-heartbeat',
      result: 'fresh result',
    });

    state.writeContextFile('main', '# Updated Main');
    expect(state.readContextFile('main')).toBe('# Updated Main');

    state.reset();

    expect(state.getAgents().main?.avatarUrl).toBeUndefined();
    expect(state.getTaskRunLogs('task-heartbeat', 1)[0]?.result).toBe(
      'All systems healthy. 4 agents online.',
    );
    expect(state.readContextFile('main')).toBe(
      '# Main Agent\n\nThis is the main agent context.',
    );
  });
});
