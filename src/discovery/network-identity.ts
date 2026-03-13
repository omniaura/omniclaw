import os from 'os';

import { logger } from '../logger.js';
import type { DiscoveryNetworkIdentity } from './types.js';

export async function detectCurrentNetwork(): Promise<DiscoveryNetworkIdentity | null> {
  switch (process.platform) {
    case 'darwin':
      return detectMacWifiNetwork();
    case 'linux':
      return detectLinuxWifiNetwork();
    default:
      logger.debug(
        { platform: process.platform },
        'Wi-Fi detection unsupported',
      );
      return null;
  }
}

async function detectMacWifiNetwork(): Promise<DiscoveryNetworkIdentity | null> {
  const device = await getMacWifiDevice();
  if (!device) return null;

  const output = await runCommand([
    'networksetup',
    '-getairportnetwork',
    device,
  ]);
  const line = output.trim();
  if (!line || /not associated/i.test(line)) return null;

  const prefix = 'Current Wi-Fi Network: ';
  const ssid = line.startsWith(prefix)
    ? line.slice(prefix.length).trim()
    : line;
  if (!ssid) return null;
  return { id: `wifi:${ssid}`, label: ssid };
}

async function getMacWifiDevice(): Promise<string | null> {
  const output = await runCommand(['networksetup', '-listallhardwareports']);
  const blocks = output.split(/\n\n+/);

  for (const block of blocks) {
    if (!/Hardware Port: (Wi-Fi|AirPort)/i.test(block)) continue;
    const match = block.match(/Device: (.+)/);
    if (match?.[1]) return match[1].trim();
  }

  return null;
}

async function detectLinuxWifiNetwork(): Promise<DiscoveryNetworkIdentity | null> {
  const iwgetid = await runCommand(['iwgetid', '-r'], false);
  const ssid = iwgetid.trim();
  if (ssid) return { id: `wifi:${ssid}`, label: ssid };

  const nmcli = await runCommand(
    ['nmcli', '-t', '-f', 'active,ssid', 'dev', 'wifi'],
    false,
  );
  const active = nmcli
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('yes:'));
  if (!active) return null;
  const activeSsid = active.slice(4).trim();
  if (!activeSsid) return null;
  return { id: `wifi:${activeSsid}`, label: activeSsid };
}

const COMMAND_TIMEOUT_MS = 5_000;

async function runCommand(cmd: string[], logErrors = true): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, {
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    });

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => {
        proc.kill();
        reject(new Error('Command timed out'));
      }, COMMAND_TIMEOUT_MS),
    );

    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      timeout,
    ]);
    if (exitCode !== 0) {
      if (logErrors) {
        logger.debug(
          {
            cmd: cmd.join(' '),
            exitCode,
            stderr: stderr.trim(),
            host: os.hostname(),
          },
          'Network identity command failed',
        );
      }
      return '';
    }
    return stdout;
  } catch (err) {
    if (logErrors) {
      logger.debug(
        { cmd: cmd.join(' '), err },
        'Network identity command failed',
      );
    }
    return '';
  }
}
