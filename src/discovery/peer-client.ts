/**
 * HTTP client for communicating with remote OmniClaw instances.
 * Uses native fetch() with signed peer authentication headers.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';

import { readStreamWithByteLimit } from '../media.js';
import type {
  ContextFileEntry,
  PairApprovalCallback,
  PairRequestBody,
  PairResponse,
  PeerInfoResponse,
  RemoteAgentSummary,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PEER_PROXY_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PEER_ERROR_BODY_BYTES = 8 * 1024;
const MAX_PEER_JSON_RESPONSE_BYTES = 1024 * 1024;
const PEER_JSON_RESPONSE_LABEL = 'Peer JSON response';
const textDecoder = new TextDecoder();

export interface PeerClientLike {
  getAgents(): Promise<RemoteAgentSummary[]>;
  getStats(): Promise<unknown>;
  streamLogs(): Promise<Response>;
  getContextLayers(params: Record<string, string>): Promise<unknown>;
  listContextFiles(): Promise<ContextFileEntry[]>;
  writeContextFile(
    layerPath: string,
    content: string,
  ): Promise<{ ok: boolean }>;
  getAgentAvatarImage?(
    agentId: string,
  ): Promise<{ data: ArrayBuffer; contentType: string } | null>;
  getChatIcon?(
    jid: string,
  ): Promise<{ data: ArrayBuffer; contentType: string } | null>;
}

export class PeerClient implements PeerClientLike {
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
    return readJsonResponseWithLimit<PeerInfoResponse>(
      res,
      MAX_PEER_JSON_RESPONSE_BYTES,
    );
  }

  /** POST /api/discovery/pair — no auth required */
  async requestPairing(body: PairRequestBody): Promise<PairResponse> {
    const res = await this.fetch('/api/discovery/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return readJsonResponseWithLimit<PairResponse>(
      res,
      MAX_PEER_JSON_RESPONSE_BYTES,
    );
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
    return readJsonResponseWithLimit<RemoteAgentSummary[]>(
      res,
      MAX_PEER_JSON_RESPONSE_BYTES,
    );
  }

  /** GET /api/agents/:id/avatar/image — requires auth, returns image bytes */
  async getAgentAvatarImage(
    agentId: string,
  ): Promise<{ data: ArrayBuffer; contentType: string } | null> {
    const res = await this.authenticatedFetch(
      `/api/agents/${encodeURIComponent(agentId)}/avatar/image`,
      undefined,
      DEFAULT_TIMEOUT_MS,
      [404],
    );
    if (res.status === 404) return null;
    const contentType = res.headers.get('content-type') || 'image/png';
    const data = await readBinaryResponseWithLimit(
      res,
      MAX_PEER_PROXY_IMAGE_BYTES,
    );
    return { data, contentType };
  }

  /** GET /api/chats/:jid/icon — requires auth, returns image bytes */
  async getChatIcon(
    jid: string,
  ): Promise<{ data: ArrayBuffer; contentType: string } | null> {
    const res = await this.authenticatedFetch(
      `/api/chats/${encodeURIComponent(jid)}/icon`,
      undefined,
      DEFAULT_TIMEOUT_MS,
      [404],
    );
    if (res.status === 404) return null;
    const contentType = res.headers.get('content-type') || 'image/png';
    const data = await readBinaryResponseWithLimit(
      res,
      MAX_PEER_PROXY_IMAGE_BYTES,
    );
    return { data, contentType };
  }

  /** GET /api/stats — requires auth */
  async getStats(): Promise<unknown> {
    const res = await this.authenticatedFetch('/api/stats');
    return readJsonResponseWithLimit(res, MAX_PEER_JSON_RESPONSE_BYTES);
  }

  /** GET /api/logs/stream — requires auth */
  async streamLogs(): Promise<Response> {
    return this.authenticatedFetch('/api/logs/stream', undefined, null);
  }

  /** GET /api/context/layers — requires auth */
  async getContextLayers(params: Record<string, string>): Promise<unknown> {
    const query = new URLSearchParams(params).toString();
    const res = await this.authenticatedFetch(`/api/context/layers?${query}`);
    return readJsonResponseWithLimit(res, MAX_PEER_JSON_RESPONSE_BYTES);
  }

  /** GET /api/context/files — requires auth */
  async listContextFiles(): Promise<ContextFileEntry[]> {
    const res = await this.authenticatedFetch('/api/context/files');
    return readJsonResponseWithLimit<ContextFileEntry[]>(
      res,
      MAX_PEER_JSON_RESPONSE_BYTES,
    );
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
    return readJsonResponseWithLimit<{ ok: boolean }>(
      res,
      MAX_PEER_JSON_RESPONSE_BYTES,
    );
  }

  private async authenticatedFetch(
    path: string,
    init?: RequestInit,
    timeoutMs: number | null = DEFAULT_TIMEOUT_MS,
    allowedStatuses: number[] = [],
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

    return this.fetch(
      path,
      { ...init, method, headers },
      timeoutMs,
      allowedStatuses,
    );
  }

  private async fetch(
    path: string,
    init?: RequestInit,
    timeoutMs: number | null = DEFAULT_TIMEOUT_MS,
    allowedStatuses: number[] = [],
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

      if (!res.ok && !allowedStatuses.includes(res.status)) {
        const body = await readErrorResponseWithLimit(
          res,
          MAX_PEER_ERROR_BODY_BYTES,
        );
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

async function readBinaryResponseWithLimit(
  response: Response,
  maxBytes: number,
): Promise<ArrayBuffer> {
  const contentLength = Number.parseInt(
    response.headers.get('content-length') || '',
    10,
  );
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    response.body?.cancel().catch(() => {});
    throw new Error(`Peer image exceeded ${maxBytes} bytes`);
  }

  const bytes = await readStreamWithByteLimit(response.body, maxBytes);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function readErrorResponseWithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = Number.parseInt(
    response.headers.get('content-length') || '',
    10,
  );
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    response.body?.cancel().catch(() => {});
    return `[response body omitted: exceeds ${maxBytes} byte limit]`;
  }

  if (!response.body) {
    return response.text().catch(() => '');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const remainingBytes = maxBytes - totalBytes;
      if (remainingBytes <= 0) {
        truncated = true;
        await reader.cancel('Error body exceeded byte limit');
        break;
      }

      const chunk =
        value.byteLength > remainingBytes
          ? value.subarray(0, remainingBytes)
          : value;
      text += decoder.decode(chunk, { stream: true });
      totalBytes += chunk.byteLength;

      if (chunk.byteLength !== value.byteLength) {
        truncated = true;
        await reader.cancel('Error body exceeded byte limit');
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  text += decoder.decode();
  return truncated ? `${text}... [truncated]` : text;
}

async function readJsonResponseWithLimit<T>(
  response: Response,
  maxBytes: number,
  label = PEER_JSON_RESPONSE_LABEL,
): Promise<T> {
  const contentLength = Number.parseInt(
    response.headers.get('content-length') || '',
    10,
  );
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    response.body?.cancel().catch(() => {});
    throw new Error(`${label} exceeded ${maxBytes} bytes`);
  }

  try {
    const bytes = await readStreamWithByteLimit(response.body, maxBytes);
    return JSON.parse(textDecoder.decode(bytes)) as T;
  } catch (error) {
    if (error instanceof Error && error.message.includes('Download exceeded')) {
      throw new Error(`${label} exceeded ${maxBytes} bytes`);
    }
    throw error;
  }
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
