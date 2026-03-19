import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';

import { logger } from '../logger.js';
import {
  detectCurrentNetwork,
  getMacNetworksetupCommand,
} from './network-identity.js';

const encoder = new TextEncoder();

describe('network identity detection', () => {
  const originalPlatform = process.platform;
  let spawnSpy: any = null;
  let warnSpy: any = null;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
    spawnSpy?.mockRestore();
    warnSpy?.mockRestore();
    spawnSpy = null;
    warnSpy = null;
  });

  it('prefers the absolute macOS system binary path', () => {
    expect(getMacNetworksetupCommand()).toEqual(['/usr/sbin/networksetup']);
  });

  it('detects the SSID from networksetup when available', async () => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((cmd: string[]) => {
      if (cmd.includes('-listallhardwareports')) {
        return createProcess({
          stdout:
            'Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: aa:bb:cc:dd:ee:ff\n',
        });
      }

      if (cmd.includes('-getairportnetwork')) {
        return createProcess({ stdout: 'Current Wi-Fi Network: Home WiFi\n' });
      }

      throw new Error(`Unexpected command: ${cmd.join(' ')}`);
    }) as typeof Bun.spawn);

    const result = await detectCurrentNetwork();

    expect(result).toEqual({ id: 'wifi:Home WiFi', label: 'Home WiFi' });
    expect(spawnSpy).toHaveBeenCalledTimes(2);
  });

  it('falls back to system_profiler when networksetup cannot identify the SSID', async () => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((cmd: string[]) => {
      if (cmd.includes('-listallhardwareports')) {
        return createProcess({
          stdout:
            'Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: aa:bb:cc:dd:ee:ff\n',
        });
      }

      if (cmd.includes('-getairportnetwork')) {
        return createProcess({
          stdout: 'You are not associated with an AirPort network.\n',
        });
      }

      if (cmd[0] === '/usr/sbin/ipconfig') {
        return createProcess({ stdout: '' });
      }

      if (cmd[0] === '/usr/sbin/system_profiler') {
        return createProcess({
          stdout:
            'Wi-Fi:\n\n    Current Network Information:\n\n      Office Network:\n          PHY Mode: 802.11ax\n',
        });
      }

      throw new Error(`Unexpected command: ${cmd.join(' ')}`);
    }) as typeof Bun.spawn);

    const result = await detectCurrentNetwork();

    expect(result).toEqual({
      id: 'wifi:Office Network',
      label: 'Office Network',
    });
  });

  it('detects the SSID from ipconfig before invoking system_profiler', async () => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((cmd: string[]) => {
      if (cmd.includes('-listallhardwareports')) {
        return createProcess({
          stdout:
            'Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: aa:bb:cc:dd:ee:ff\n',
        });
      }

      if (cmd.includes('-getairportnetwork')) {
        return createProcess({
          stdout: 'You are not associated with an AirPort network.\n',
        });
      }

      if (cmd[0] === '/usr/sbin/ipconfig') {
        return createProcess({
          stdout: 'SSID : Office WiFi\nSecurity : WPA3\n',
        });
      }

      if (cmd[0] === '/usr/sbin/system_profiler') {
        throw new Error(
          'system_profiler should not run when ipconfig succeeds',
        );
      }

      throw new Error(`Unexpected command: ${cmd.join(' ')}`);
    }) as typeof Bun.spawn);

    const result = await detectCurrentNetwork();

    expect(result).toEqual({ id: 'wifi:Office WiFi', label: 'Office WiFi' });
  });

  it('falls back to wdutil when the older macOS commands fail', async () => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((cmd: string[]) => {
      if (cmd.includes('-listallhardwareports')) {
        return createProcess({
          stdout:
            'Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: aa:bb:cc:dd:ee:ff\n',
        });
      }

      if (cmd.includes('-getairportnetwork')) {
        return createProcess({
          stdout: 'You are not associated with an AirPort network.\n',
        });
      }

      if (cmd[0] === '/usr/sbin/system_profiler') {
        return createProcess({
          stdout: '',
          stderr: 'permission denied',
          exitCode: 1,
        });
      }

      if (cmd[0] === '/usr/sbin/ipconfig') {
        return createProcess({ stdout: '' });
      }

      if (cmd[0] === '/usr/bin/wdutil') {
        return createProcess({ stdout: 'SSID : Lab Network\nChannel : 149\n' });
      }

      throw new Error(`Unexpected command: ${cmd.join(' ')}`);
    }) as typeof Bun.spawn);

    const result = await detectCurrentNetwork();

    expect(result).toEqual({ id: 'wifi:Lab Network', label: 'Lab Network' });
  });

  it('logs command failures at warn level for troubleshooting', async () => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((cmd: string[]) => {
      if (cmd.includes('-listallhardwareports')) {
        return createProcess({
          stdout:
            'Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: aa:bb:cc:dd:ee:ff\n',
        });
      }

      if (cmd.includes('-getairportnetwork')) {
        return createProcess({
          stdout: 'You are not associated with an AirPort network.\n',
        });
      }

      if (cmd[0] === '/usr/sbin/system_profiler') {
        return createProcess({
          stdout: '',
          stderr: 'system profiler unavailable',
          exitCode: 1,
        });
      }

      if (cmd[0] === '/usr/sbin/ipconfig') {
        return createProcess({
          stdout: '',
          stderr: 'ipconfig unavailable',
          exitCode: 1,
        });
      }

      if (cmd[0] === '/usr/bin/wdutil') {
        return createProcess({
          stdout: '',
          stderr: 'wdutil unavailable',
          exitCode: 1,
        });
      }

      throw new Error(`Unexpected command: ${cmd.join(' ')}`);
    }) as typeof Bun.spawn);

    warnSpy = spyOn(logger, 'warn');

    const result = await detectCurrentNetwork();

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.some((call: unknown[]) =>
        String(call[1]).includes('Network identity command failed'),
      ),
    ).toBe(true);
  });
});

function createProcess({
  stdout,
  stderr = '',
  exitCode = 0,
}: {
  stdout: string;
  stderr?: string;
  exitCode?: number;
}) {
  return {
    stdout: createStream(stdout),
    stderr: createStream(stderr),
    exited: Promise.resolve(exitCode),
    kill: mock(() => {}),
  } as unknown as ReturnType<typeof Bun.spawn>;
}

function createStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}
