/**
 * HTTP client for communicating with remote OmniClaw instances.
 * Uses native fetch() with signed peer authentication headers.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';

import type {
  ContextFileEntry,
  PairApprovalCallback,
  PairRequestBody,
  PairResponse,
  PeerInfoResponse,
  RemoteAgentSummary,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;

export class PeerClient {
  private baseUrl: string;
  private instanceId: string;
  private sharedSecret: string | null;

  constructor(
    host: string,
    port: number,
    instanceId: string,
    sharedSecret: string | null = null,
    scheme: 'http' | 'https' = 'http',
  ) {
    this.baseUrl = `${scheme}://${host}:${port}`;
    this.instanceId = instanceId;
    this.sharedSecret = sharedSecret;
  }

  /** GET /api/discovery/info — no auth required */
  async getInfo(): Promise<PeerInfoResponse> {
    const res = await this.fetch('/api/discovery/info');
    return res.json() as Promise<PeerInfoResponse>;
  }

  /** POST /api/discovery/pair — no auth required */
  async requestPairing(body: PairRequestBody): Promise<PairResponse> {
    const res = await this.fetch('/api/discovery/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json() as Promise<PairResponse>;
  }

  /** POST /api/discovery/complete-pairing — sends approval callback */
  async completePairing(payload: PairApprovalCallback): Promise<void> {
    await this.fetch('/api/discovery/complete-pairing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /** GET /api/agents — requires auth */
  async getAgents(): Promise<RemoteAgentSummary[]> {
    const res = await this.authenticatedFetch('/api/agents');
    return res.json() as Promise<RemoteAgentSummary[]>;
  }

  /** GET /api/agents/:id/avatar/image — requires auth, returns image bytes */
  async getAgentAvatarImage(
    agentId: string,
  ): Promise<{ data: ArrayBuffer; contentType: string } | null> {
    try {
      const res = await this.authenticatedFetch(
        `/api/agents/${encodeURIComponent(agentId)}/avatar/image`,
      );
      const contentType = res.headers.get('content-type') || 'image/png';
      const data = await res.arrayBuffer();
      return { data, contentType };
    } catch {
      return null;
    }
  }

  /** GET /api/chats/:jid/icon — requires auth, returns image bytes */
  async getChatIcon(
    jid: string,
  ): Promise<{ data: ArrayBuffer; contentType: string } | null> {
    try {
      const res = await this.authenticatedFetch(
        `/api/chats/${encodeURIComponent(jid)}/icon`,
      );
      const contentType = res.headers.get('content-type') || 'image/png';
      const data = await res.arrayBuffer();
      return { data, contentType };
    } catch {
      return null;
    }
  }

  /** GET /api/stats — requires auth */
  async getStats(): Promise<unknown> {
    const res = await this.authenticatedFetch('/api/stats');
    return res.json();
  }

  /** GET /api/logs/stream — requires auth */
  async streamLogs(): Promise<Response> {
    return this.authenticatedFetch('/api/logs/stream', undefined, null);
  }

  /** GET /api/context/layers — requires auth */
  async getContextLayers(params: Record<string, string>): Promise<unknown> {
    const query = new URLSearchParams(params).toString();
    const res = await this.authenticatedFetch(`/api/context/layers?${query}`);
    return res.json();
  }

  /** GET /api/context/files — requires auth */
  async listContextFiles(): Promise<ContextFileEntry[]> {
    const res = await this.authenticatedFetch('/api/context/files');
    return res.json() as Promise<ContextFileEntry[]>;
  }

  /** PUT /api/context/file — requires auth */
  async writeContextFile(
    layerPath: string,
    content: string,
  ): Promise<{ ok: boolean }> {
    const res = await this.authenticatedFetch('/api/context/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: layerPath, content }),
    });
    return res.json() as Promise<{ ok: boolean }>;
  }

  private async authenticatedFetch(
    path: string,
    init?: RequestInit,
    timeoutMs: number | null = DEFAULT_TIMEOUT_MS,
  ): Promise<Response> {
    if (!this.sharedSecret) {
      throw new Error('Cannot make authenticated request: not paired');
    }

    const method = (init?.method || 'GET').toUpperCase();
    const nonce = randomUUID();
    const timestamp = Date.now().toString();
    const bodyHash = sha256Hex(getBodyString(init?.body));
    const signature = signRequest(
      this.sharedSecret,
      method,
      path,
      timestamp,
      nonce,
      bodyHash,
    );
    const headers = new Headers(init?.headers);
    headers.set('X-OmniClaw-Instance', this.instanceId);
    headers.set('X-OmniClaw-Timestamp', timestamp);
    headers.set('X-OmniClaw-Nonce', nonce);
    headers.set('X-OmniClaw-Body-SHA256', bodyHash);
    headers.set('X-OmniClaw-Signature', signature);

    return this.fetch(path, { ...init, method, headers }, timeoutMs);
  }

  private async fetch(
    path: string,
    init?: RequestInit,
    timeoutMs: number | null = DEFAULT_TIMEOUT_MS,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout =
      timeoutMs == null
        ? null
        : setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `Peer API error: ${res.status} ${res.statusText} - ${body}`,
        );
      }

      return res;
    } finally {
      if (timeout != null) clearTimeout(timeout);
    }
  }
}

function getBodyString(body: RequestInit['body']): string {
  if (!body) return '';
  if (typeof body === 'string') return body;
  throw new Error('PeerClient only supports string request bodies');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function signRequest(
  sharedSecret: string,
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  bodyHash: string,
): string {
  return createHmac('sha256', sharedSecret)
    .update([method, path, timestamp, nonce, bodyHash].join('\n'))
    .digest('hex');
}

export function verifyPeerRequestSignature(params: {
  sharedSecret: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
  signature: string;
}): boolean {
  const expected = signRequest(
    params.sharedSecret,
    params.method,
    params.path,
    params.timestamp,
    params.nonce,
    params.bodyHash,
  );
  if (expected.length !== params.signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(params.signature));
}
