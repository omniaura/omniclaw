#!/usr/bin/env bun
/**
 * OmniClaw Web UI Simulation Test Harness
 *
 * Starts the real web UI server backed by a fully fake state provider,
 * plus an admin API on a separate port to control the simulation.
 *
 * No secrets, no containers, no database required.
 *
 * Usage:
 *   bun run src/simtest/index.ts
 *   bun run src/simtest/index.ts --web-port 3000 --admin-port 3001
 *
 * Then:
 *   - Open http://localhost:3000 for the web UI
 *   - Use http://localhost:3001 for the admin API
 *   - GET http://localhost:3001/help for available endpoints
 *   - POST http://localhost:3001/scenario/task-storm to load a scenario
 */

import { parseArgs } from 'util';

import { setDiscoveryContext } from '../web/routes.js';
import { startWebServer } from '../web/server.js';
import { FakeState } from './fake-state.js';
import { startAdminApi } from './admin-api.js';
import { createSimDiscoveryEnvironment } from './discovery-sim.js';

const { values } = parseArgs({
  options: {
    'web-port': { type: 'string', default: '3000' },
    'admin-port': { type: 'string', default: '3001' },
    hostname: { type: 'string', default: '127.0.0.1' },
  },
  strict: false,
});

const webPort = parseInt(values['web-port'] as string, 10);
const adminPort = parseInt(values['admin-port'] as string, 10);
const hostname = values.hostname as string;

// Create fake state with seed data
const state = new FakeState();
const discovery = createSimDiscoveryEnvironment(state);

// Start the real web UI server (no auth in simtest mode)
const webServer = startWebServer(
  {
    port: webPort,
    hostname,
    // No auth — open access for testing
  },
  state,
);

webServer.setNetworkPageState(discovery.getNetworkPageState);
setDiscoveryContext(discovery.context, discovery.getNetworkPageState);

// Start the admin API on a separate port
const adminApi = startAdminApi(
  { port: adminPort, hostname },
  state,
  webServer,
  discovery,
);

console.log('');
console.log('╔══════════════════════════════════════════════════════╗');
console.log('║         OmniClaw Web UI — Simulation Mode           ║');
console.log('╠══════════════════════════════════════════════════════╣');
console.log(
  `║  Web UI:    http://${hostname}:${webServer.port.toString().padEnd(27)}║`,
);
console.log(
  `║  Admin API: http://${hostname}:${adminApi.port.toString().padEnd(27)}║`,
);
console.log('╠══════════════════════════════════════════════════════╣');
console.log('║  No secrets. No containers. No database.            ║');
console.log('║                                                     ║');
console.log('║  Admin commands:                                    ║');
console.log('║    GET  /help              — List all endpoints     ║');
console.log('║    GET  /state             — Current state snapshot ║');
console.log('║    POST /reset             — Reset to seed data     ║');
console.log('║    POST /scenario/:name    — Load a scenario        ║');
console.log('║    POST /agents            — Add an agent           ║');
console.log('║    POST /messages          — Inject a message       ║');
console.log('║    POST /broadcast         — Push event to web UI   ║');
console.log('║    GET  /remote-peers      — Remote sim snapshot    ║');
console.log('║    POST /remote-peers/:id/logs — Inject remote log  ║');
console.log('║                                                     ║');
console.log('║  Scenarios: agent-overload, task-storm,             ║');
console.log('║             error-cascade, idle-fleet, empty        ║');
console.log('╚══════════════════════════════════════════════════════╝');
console.log('');

// Graceful shutdown
let shuttingDown = false;

async function shutdown(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(
    signal === 'SIGINT'
      ? '\n[simtest] Shutting down...'
      : '[simtest] Shutting down...',
  );

  try {
    await Promise.resolve(adminApi.stop());
    await webServer.stop();
    process.exit(0);
  } catch (error) {
    console.error('[simtest] Shutdown failed:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
