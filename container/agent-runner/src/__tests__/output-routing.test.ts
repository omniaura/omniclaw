import { describe, expect, it } from 'bun:test';

import { getOriginChatJid, withOutputChatJid } from '../output-routing.js';

describe('output routing', () => {
  it('uses origin chat over mutable current chat for turn output snapshots', () => {
    const origin = getOriginChatJid({
      chatJid: 'dc:mutable-current',
      originChatJid: 'dc:turn-origin',
    } as any);

    const output = withOutputChatJid(
      { status: 'success', result: 'final' },
      origin,
    );

    expect(output.chatJid).toBe('dc:turn-origin');
  });

  it('falls back to initial chat when origin chat is absent', () => {
    expect(getOriginChatJid({ chatJid: 'dc:initial' } as any)).toBe(
      'dc:initial',
    );
  });

  it('does not add an empty output chat jid', () => {
    expect(withOutputChatJid({ status: 'success', result: null }, '')).toEqual({
      status: 'success',
      result: null,
    });
  });
});
