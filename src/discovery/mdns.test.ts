import { describe, expect, it } from 'bun:test';

import { selectPeerHost } from './mdns.js';

describe('selectPeerHost', () => {
  it('prefers a routable IP address over an mDNS hostname', () => {
    expect(selectPeerHost('orangepi5', ['10.0.0.118', 'fe80::1'])).toBe(
      '10.0.0.118',
    );
  });

  it('falls back to the host when no usable address exists', () => {
    expect(selectPeerHost('orangepi5', ['127.0.0.1', '::1'])).toBe('orangepi5');
  });

  it('returns unknown when host and addresses are missing', () => {
    expect(selectPeerHost(undefined, undefined)).toBe('unknown');
  });
});
