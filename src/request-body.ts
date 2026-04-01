const textDecoder = new TextDecoder();

export class RequestBodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Request body exceeded ${limitBytes} bytes`);
  }
}

function parseContentLengthHeader(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

export async function readRequestBody(
  req: Request,
  maxBodyBytes: number,
): Promise<string> {
  const contentLength = parseContentLengthHeader(
    req.headers.get('content-length'),
  );
  if (contentLength !== null && contentLength > maxBodyBytes) {
    throw new RequestBodyTooLargeError(maxBodyBytes);
  }

  if (!req.body) return '';

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBodyBytes) {
        try {
          await reader.cancel('Request body exceeded size limit');
        } catch {
          // Ignore cancellation failures; callers only need the limit signal.
        }
        throw new RequestBodyTooLargeError(maxBodyBytes);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return textDecoder.decode(body);
}

export async function readJsonBody<T>(
  req: Request,
  maxBodyBytes: number,
): Promise<T> {
  return JSON.parse(await readRequestBody(req, maxBodyBytes)) as T;
}
