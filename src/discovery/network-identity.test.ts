import { describe, expect, it } from 'bun:test';

import { getMacNetworksetupCommand } from './network-identity.js';

describe('getMacNetworksetupCommand', () => {
  it('prefers the absolute macOS system binary path', () => {
    expect(getMacNetworksetupCommand()).toEqual(['/usr/sbin/networksetup']);
  });
});
