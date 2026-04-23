import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { processMessageIpc, type IpcDeps, type MessageResult } from './ipc.js';
import type { IpcMessagePayload, RegisteredGroup } from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Other',
  added_at: '2024-01-01T00:00:00.000Z',
};

describe('processMessageIpc: format_mention response files', () => {
  // Keep response-file assertions in a separate file because bun:test module
  // mocks leak across files, and group-queue.test.ts globally mocks fs.
  let tmpDir: string;
  let groups: Record<string, RegisteredGroup>;
  let deps: IpcDeps;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-format-mention-'));
    groups = {
      'main@g.us': MAIN_GROUP,
      'other@g.us': OTHER_GROUP,
    };
    deps = {
      sendMessage: async () => 'sent-1',
      notifyGroup: () => {},
      registeredGroups: () => groups,
      registerGroup: () => {},
      updateGroup: () => {},
      syncGroupMetadata: async () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function processMsg(
    data: IpcMessagePayload,
    sourceGroup = 'main',
    isMain = true,
  ): Promise<MessageResult> {
    return processMessageIpc(data, sourceGroup, isMain, tmpDir, groups, deps);
  }

  function readResponse(sourceGroup: string, requestId: string) {
    return JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, sourceGroup, 'responses', `${requestId}.json`),
        'utf8',
      ),
    );
  }

  it('writes a sanitized Discord mention response file', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'user_registry.json'),
      JSON.stringify({
        peyton: { platform: 'discord', id: '123456789', name: 'Peyton' },
      }),
    );

    const result = await processMsg({
      type: 'format_mention',
      userName: '  Peyton ',
      platform: 'discord',
      requestId: 'req/../discord!?',
    });

    expect(result).toEqual({ action: 'handled' });
    expect(readResponse('main', 'reqdiscord')).toEqual({
      type: 'format_mention_response',
      requestId: 'reqdiscord',
      result: '<@123456789>',
    });
  });

  it('uses WhatsApp ids from the registry in the response file', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'user_registry.json'),
      JSON.stringify({
        peyton: {
          platform: 'whatsapp',
          id: '15551234567@s.whatsapp.net',
          name: 'Peyton',
        },
      }),
    );

    const result = await processMsg({
      type: 'format_mention',
      userName: 'Peyton',
      platform: 'whatsapp',
      requestId: 'req-whatsapp',
    });

    expect(result).toEqual({ action: 'handled' });
    expect(readResponse('main', 'req-whatsapp')).toEqual({
      type: 'format_mention_response',
      requestId: 'req-whatsapp',
      result: '@15551234567@s.whatsapp.net',
    });
  });

  it('falls back to the registry display name for unsupported platforms', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'user_registry.json'),
      JSON.stringify({
        peyton: { platform: 'telegram', id: '42', name: 'Peyton Omni' },
      }),
    );

    const result = await processMsg({
      type: 'format_mention',
      userName: 'Peyton',
      platform: 'telegram',
      requestId: 'req-telegram',
    });

    expect(result).toEqual({ action: 'handled' });
    expect(readResponse('main', 'req-telegram')).toEqual({
      type: 'format_mention_response',
      requestId: 'req-telegram',
      result: '@Peyton Omni',
    });
  });

  it('falls back to the raw userName when the registry is unreadable', async () => {
    fs.writeFileSync(path.join(tmpDir, 'user_registry.json'), '{not-json');

    const result = await processMsg({
      type: 'format_mention',
      userName: 'Fallback User',
      platform: 'discord',
      requestId: 'req-fallback',
    });

    expect(result).toEqual({ action: 'handled' });
    expect(readResponse('main', 'req-fallback')).toEqual({
      type: 'format_mention_response',
      requestId: 'req-fallback',
      result: '@Fallback User',
    });
  });

  it('blocks empty sanitized requestIds and does not write a response file', async () => {
    const result = await processMsg({
      type: 'format_mention',
      userName: 'Peyton',
      platform: 'discord',
      requestId: '../../..',
    });

    expect(result).toEqual({
      action: 'blocked',
      reason: 'requestId sanitized to empty',
    });
    expect(fs.existsSync(path.join(tmpDir, 'main', 'responses'))).toBe(false);
  });
});
