import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'crypto';

import { PeerClient, verifyPeerRequestSignature } from './peer-client.js';

const originalFetch = globalThis.fetch;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('PeerClient', () => {
  it('adds signed auth headers for authenticated requests', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return Promise.resolve(
        new Response(JSON.stringify([{ id: 'agent-1', name: 'Alpha' }]), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof fetch;

    const client = new PeerClient('peer.local', 8443, 'instance-123', 'shh', 'https');

    const agents = await client.getAgents();

    expect(agents).toEqual([{ id: 'agent-1', name: 'Alpha' }]);
    expect(capturedUrl).toBe('https://peer.local:8443/api/agents');

    const headers = new Headers(capturedInit?.headers);
    const timestamp = headers.get('X-OmniClaw-Timestamp');
    const nonce = headers.get('X-OmniClaw-Nonce');
    const bodyHash = headers.get('X-OmniClaw-Body-SHA256');
    const signature = headers.get('X-OmniClaw-Signature');

    expect(headers.get('X-OmniClaw-Instance')).toBe('instance-123');
    expect(timestamp).toBeTruthy();
    expect(nonce).toBeTruthy();
    expect(bodyHash).toBe(sha256Hex(''));
    expect(signature).toBeTruthy();
    expect(
      verifyPeerRequestSignature({
        sharedSecret: 'shh',
        method: 'GET',
        path: '/api/agents',
        timestamp: timestamp!,
        nonce: nonce!,
        bodyHash: bodyHash!,
        signature: signature!,
      }),
    ).toBe(true);
  });

  it('hashes JSON request bodies for authenticated writes', async () => {
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof fetch;

    const client = new PeerClient('peer.local', 8080, 'writer-1', 'secret');

    await expect(
      client.writeContextFile('groups/main/CLAUDE.md', 'hello world'),
    ).resolves.toEqual({ ok: true });

    const headers = new Headers(capturedInit?.headers);
    const body = String(capturedInit?.body);

    expect(capturedInit?.method).toBe('PUT');
    expect(body).toBe(
      JSON.stringify({ path: 'groups/main/CLAUDE.md', content: 'hello world' }),
    );
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('X-OmniClaw-Body-SHA256')).toBe(sha256Hex(body));
  });

  it('returns null for avatar fetch failures and defaults image content type', async () => {
    const fetchMock = mock((url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith('/api/agents/agent-404/avatar/image')) {
        return Promise.resolve(new Response('missing', { status: 404 }));
      }
      return Promise.resolve(new Response('icon-bytes'));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new PeerClient('peer.local', 3000, 'image-1', 'secret');

    await expect(client.getAgentAvatarImage('agent-404')).resolves.toBeNull();

    const icon = await client.getChatIcon('chat/room');
    expect(icon).not.toBeNull();
    expect(icon?.contentType).toBe('image/png');
    expect(new Uint8Array(icon!.data)).toEqual(new TextEncoder().encode('icon-bytes'));
  });

  it('rejects authenticated requests when the client is not paired', async () => {
    const client = new PeerClient('peer.local', 3000, 'unpaired');

    await expect(client.getStats()).rejects.toThrow(
      'Cannot make authenticated request: not paired',
    );
  });

  it('aborts slow fetches when a timeout is provided', async () => {
    let aborted = false;
    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_, reject) => {
        if (!signal) {
          reject(new Error('missing abort signal'));
          return;
        }

        signal.addEventListener('abort', () => {
          aborted = true;
          reject(signal.reason);
        });
      });
    }) as typeof fetch;

    const client = new PeerClient('peer.local', 3000, 'slow-1');

    await expect((client as any).fetch('/slow', undefined, 5)).rejects.toThrow();
    expect(aborted).toBe(true);
  });

  it('detects mismatched request signatures', () => {
    expect(
      verifyPeerRequestSignature({
        sharedSecret: 'secret',
        method: 'GET',
        path: '/api/agents',
        timestamp: '1',
        nonce: '2',
        bodyHash: sha256Hex(''),
        signature: '0'.repeat(64),
      }),
    ).toBe(false);
  });
});
