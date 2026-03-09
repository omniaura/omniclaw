/**
 * HTTP client for communicating with remote OmniClaw instances.
 * Uses native fetch() with peer authentication headers.
 */
import type {
  ContextFileEntry,
  PairRequestBody,
  PairResponse,
  PeerInfoResponse,
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
  ) {
    this.baseUrl = `http://${host}:${port}`;
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
  async completePairing(
    sharedSecret: string,
    localInstanceId: string,
    localName: string,
  ): Promise<void> {
    await this.fetch('/api/discovery/complete-pairing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sharedSecret,
        instanceId: localInstanceId,
        name: localName,
      }),
    });
  }

  /** GET /api/agents — requires auth */
  async getAgents(): Promise<unknown[]> {
    const res = await this.authenticatedFetch('/api/agents');
    return res.json() as Promise<unknown[]>;
  }

  /** GET /api/stats — requires auth */
  async getStats(): Promise<unknown> {
    const res = await this.authenticatedFetch('/api/stats');
    return res.json();
  }

  /** GET /api/context/layers — requires auth */
  async getContextLayers(params: Record<string, string>): Promise<unknown> {
    const query = new URLSearchParams(params).toString();
    const res = await this.authenticatedFetch(
      `/api/context/layers?${query}`,
    );
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
  ): Promise<Response> {
    if (!this.sharedSecret) {
      throw new Error('Cannot make authenticated request: not paired');
    }

    const headers = new Headers(init?.headers);
    headers.set('X-OmniClaw-Instance', this.instanceId);
    headers.set('Authorization', `Bearer ${this.sharedSecret}`);

    return this.fetch(path, { ...init, headers });
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DEFAULT_TIMEOUT_MS,
    );

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
      clearTimeout(timeout);
    }
  }
}
