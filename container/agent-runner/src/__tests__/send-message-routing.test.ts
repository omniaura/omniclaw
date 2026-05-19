import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildSendMessageChannelDescription,
  resolveSendMessageTarget,
} from '../send-message-routing.ts';

const tempFiles: string[] = [];

function makeCurrentChatFile(value: string): string {
  const file = path.join(
    os.tmpdir(),
    `omniclaw-current-chat-${process.pid}-${Math.random().toString(36).slice(2)}.txt`,
  );
  fs.writeFileSync(file, value);
  tempFiles.push(file);
  return file;
}

afterEach(() => {
  for (const file of tempFiles.splice(0)) {
    fs.rmSync(file, { force: true });
  }
});

describe('send_message routing', () => {
  const channels = [
    { id: '1', name: 'omniclaw', jid: 'dc:omniclaw' },
    { id: '2', name: 'agentflow', jid: 'dc:agentflow' },
  ];

  it('defaults omitted target_jid to the origin chat, not the mutable current chat', () => {
    const currentChatFile = makeCurrentChatFile('dc:agentflow');

    expect(
      resolveSendMessageTarget(undefined, {
        channels,
        currentChatFile,
        initialChatJid: 'dc:omniclaw',
        originChatJid: 'dc:omniclaw',
      }),
    ).toEqual({
      targetJid: 'dc:omniclaw',
      currentChatJid: 'dc:agentflow',
      targetWasExplicit: false,
    });
  });

  it('keeps explicit channel targets working by ID, name, and JID', () => {
    const currentChatFile = makeCurrentChatFile('dc:agentflow');
    const context = {
      channels,
      currentChatFile,
      initialChatJid: 'dc:omniclaw',
      originChatJid: 'dc:omniclaw',
    };

    expect(resolveSendMessageTarget('2', context).targetJid).toBe(
      'dc:agentflow',
    );
    expect(resolveSendMessageTarget('agentflow', context).targetJid).toBe(
      'dc:agentflow',
    );
    expect(resolveSendMessageTarget('dc:custom', context).targetJid).toBe(
      'dc:custom',
    );
    expect(resolveSendMessageTarget('2', context).targetWasExplicit).toBe(true);
  });

  it('describes omitted target_jid as the recommended same-channel path', () => {
    expect(buildSendMessageChannelDescription(channels)).toContain(
      'Omit target_jid to reply in the channel that started this turn',
    );
    expect(buildSendMessageChannelDescription(channels)).toContain(
      'explicit delegation',
    );
  });
});
