import os from 'os';

import { logger } from '../logger.js';
import type { DiscoveryNetworkIdentity } from './types.js';

const MAC_NETWORKSETUP_PATH = '/usr/sbin/networksetup';
const MAC_IPCONFIG_PATH = '/usr/sbin/ipconfig';
const MAC_SYSTEM_PROFILER_PATH = '/usr/sbin/system_profiler';
const MAC_WDUTIL_PATH = '/usr/bin/wdutil';
const NETWORK_IDENTITY_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
};

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

  if (device) {
    const networksetupSsid = parseMacNetworksetupSsid(
      await runCommand([
        ...getMacNetworksetupCommand(),
        '-getairportnetwork',
        device,
      ]),
    );
    if (networksetupSsid) {
      return toWifiIdentity(networksetupSsid);
    }

    const ipconfigSsid = parseIpconfigSsid(
      await runCommand([MAC_IPCONFIG_PATH, 'getsummary', device]),
    );
    if (ipconfigSsid) {
      return toWifiIdentity(ipconfigSsid);
    }
  }

  const systemProfilerSsid = parseSystemProfilerSsid(
    await runCommand([
      MAC_SYSTEM_PROFILER_PATH,
      'SPAirPortDataType',
      '-detailLevel',
      'mini',
    ]),
  );
  if (systemProfilerSsid) {
    return toWifiIdentity(systemProfilerSsid);
  }

  const wdutilSsid = parseWdutilSsid(
    // `wdutil info` often requires elevated privileges on macOS, so this is a
    // best-effort final fallback after the more common non-root paths.
    await runCommand([MAC_WDUTIL_PATH, 'info']),
  );
  if (wdutilSsid) {
    return toWifiIdentity(wdutilSsid);
  }

  logger.warn('All macOS Wi-Fi detection methods exhausted');

  return null;
}

async function getMacWifiDevice(): Promise<string | null> {
  const output = await runCommand([
    ...getMacNetworksetupCommand(),
    '-listallhardwareports',
  ]);
  const blocks = output.split(/\n\n+/);

  for (const block of blocks) {
    if (
      !/Hardware Port: (Wi-?Fi|AirPort|Wireless LAN|WLAN|802\.11)/i.test(block)
    ) {
      continue;
    }
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

export function getMacNetworksetupCommand(): string[] {
  return [MAC_NETWORKSETUP_PATH];
}

function toWifiIdentity(ssid: string): DiscoveryNetworkIdentity | null {
  const normalized = normalizeSsid(ssid);
  if (!normalized) return null;
  return { id: `wifi:${normalized}`, label: normalized };
}

function parseMacNetworksetupSsid(output: string): string | null {
  const line = output.trim();
  if (!line || /not associated/i.test(line)) return null;

  const prefix = 'Current Wi-Fi Network: ';
  if (line.startsWith(prefix)) {
    return normalizeSsid(line.slice(prefix.length));
  }

  return normalizeSsid(line);
}

function parseSystemProfilerSsid(output: string): string | null {
  const ssidLine = output.match(/^\s*SSID\s*:\s*(.+)$/im);
  if (ssidLine?.[1]) {
    return normalizeSsid(ssidLine[1]);
  }

  const lines = output.split('\n');
  let inCurrentNetworkSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^Current Network Information:$/i.test(trimmed)) {
      inCurrentNetworkSection = true;
      continue;
    }

    if (!inCurrentNetworkSection) continue;
    if (!/^\s/.test(line)) break;

    // Older `system_profiler` output sometimes nests the SSID as a section
    // heading under "Current Network Information" instead of an `SSID :` line.
    const sectionMatch = line.match(/^\s{2,}(.+):\s*$/);
    if (sectionMatch?.[1]) {
      return normalizeSsid(sectionMatch[1]);
    }
  }

  return null;
}

function parseIpconfigSsid(output: string): string | null {
  const match = output.match(/^\s*SSID\s*:\s*(.+)$/im);
  return normalizeSsid(match?.[1] ?? null);
}

function parseWdutilSsid(output: string): string | null {
  const match = output.match(/^\s*SSID\s*:\s*(.+)$/im);
  return normalizeSsid(match?.[1] ?? null);
}

function normalizeSsid(value: string | null | undefined): string | null {
  if (!value) return null;

  const trimmed = value.trim().replace(/^"(.+)"$/, '$1');
  if (!trimmed) return null;
  if (/^(none|n\/a|\(null\)|<none>|not associated)$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

async function runCommand(cmd: string[], logErrors = true): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, {
      stdout: 'pipe',
      stderr: 'pipe',
      env: NETWORK_IDENTITY_ENV,
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
        logger.warn(
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
    if (
      process.platform === 'darwin' &&
      cmd[0] === MAC_NETWORKSETUP_PATH &&
      err instanceof Error &&
      /Executable not found in \$PATH/i.test(err.message)
    ) {
      return runCommand(['networksetup', ...cmd.slice(1)], logErrors);
    }
    if (logErrors) {
      logger.warn(
        { cmd: cmd.join(' '), err },
        'Network identity command failed',
      );
    }
    return '';
  }
}
