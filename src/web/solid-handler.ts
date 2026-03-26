/**
 * SolidStart integration handler.
 *
 * When WEB_UI_SOLID=true, the main web server delegates page requests
 * to the compiled SolidStart app. The SolidStart build starts its own
 * internal server; we proxy page requests to it while keeping API routes,
 * SSE, and auth in the main process.
 */

import type { WebStateProvider } from './types.js';
import { buildAgentChannelData } from './agent-channels.js';
import { buildSettingsData } from './settings.js';
import { buildAgentDetailData } from './agent-detail.js';
import { listLocalContextFiles } from './context-files.js';
import { logger } from '../logger.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type SolidHandler = (req: Request) => Promise<Response>;

let solidHandler: SolidHandler | null = null;
let solidPort: number | null = null;

/**
 * Initialize the SolidStart handler by importing the compiled output.
 * The SolidStart build (bun preset) starts its own server on an internal port.
 * We proxy non-API requests to it.
 */
export async function initSolidHandler(
  state: WebStateProvider,
): Promise<SolidHandler | null> {
  try {
    const internalPort = 40000 + Math.floor(Math.random() * 20000);

    // Set up the augmented state for SolidStart API routes
    const augmentedState = createAugmentedState(state);

    // Set env vars before importing the SolidStart server
    process.env.NITRO_PORT = String(internalPort);
    process.env.PORT = String(internalPort);
    process.env.NITRO_HOST = '127.0.0.1';
    process.env.HOST = '127.0.0.1';

    // Dynamically import the compiled SolidStart server
    const solidServerEntry = path.join(
      import.meta.dir,
      '../../webui/.output/server/index.mjs',
    );
    await import(pathToFileURL(solidServerEntry).href);

    solidPort = internalPort;
    solidHandler = async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const targetUrl = `http://127.0.0.1:${internalPort}${url.pathname}${url.search}`;
      const headers = new Headers(req.headers);
      headers.set('host', `127.0.0.1:${internalPort}`);
      // Disable compression to avoid double-encoding when proxying
      headers.set('accept-encoding', 'identity');
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const resp = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: hasBody ? req.body : undefined,
        redirect: 'manual',
        decompress: false,
      } as RequestInit);
      return resp;
    };

    logger.info({ solidPort: internalPort }, 'SolidStart handler initialized');
    return solidHandler;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to initialize SolidStart handler — falling back to Datastar UI',
    );
    return null;
  }
}

export function getSolidHandler(): SolidHandler | null {
  return solidHandler;
}

/**
 * Check if a request should be handled by the main process
 * rather than SolidStart. API routes, SSE, and WebSocket are
 * handled by the main process.
 */
export function isMainProcessRoute(pathname: string): boolean {
  return (
    pathname === '/api/events' ||
    pathname === '/api/logs/stream' ||
    pathname === '/ws' ||
    pathname.startsWith('/api/')
  );
}

/**
 * Wrap the WebStateProvider with additional methods that
 * SolidStart API routes expect.
 */
function createAugmentedState(
  state: WebStateProvider,
): Record<string, unknown> {
  return Object.create(state, {
    getAgentChannelData: {
      value: () => buildAgentChannelData(state),
    },
    getSettings: {
      value: () => buildSettingsData(),
    },
    getAgentDetail: {
      value: (agentId: string) => buildAgentDetailData(agentId, state, []),
    },
    listContextFiles: {
      value: () => listLocalContextFiles(),
    },
  });
}
