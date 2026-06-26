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
  let timeoutSpy: any = null;
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
    timeoutSpy?.mockRestore();
    warnSpy?.mockRestore();
    spawnSpy = null;
    timeoutSpy = null;
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

  it('logs generic spawn errors and continues through macOS fallbacks', async () => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((cmd: string[]) => {
      if (cmd.includes('-listallhardwareports')) {
        throw new Error('spawn failed before process creation');
      }

      if (cmd[0] === '/usr/sbin/system_profiler') {
        return createProcess({ stdout: '' });
      }

      if (cmd[0] === '/usr/bin/wdutil') {
        return createProcess({ stdout: '' });
      }

      throw new Error(`Unexpected command: ${cmd.join(' ')}`);
    }) as typeof Bun.spawn);

    warnSpy = spyOn(logger, 'warn');

    const result = await detectCurrentNetwork();

    expect(result).toBeNull();
    expect(
      warnSpy.mock.calls.some((call: unknown[]) =>
        String(call[1]).includes('Network identity command failed'),
      ),
    ).toBe(true);
    expect(spawnSpy).toHaveBeenCalledWith(
      [
        '/usr/sbin/system_profiler',
        'SPAirPortDataType',
        '-detailLevel',
        'mini',
      ],
      expect.any(Object),
    );
    expect(spawnSpy).toHaveBeenCalledWith(
      ['/usr/bin/wdutil', 'info'],
      expect.any(Object),
    );
  });

  it('kills timed-out linux probes and continues to the next detector', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });

    const hangingProcess = createHangingProcess();
    const originalSetTimeout = globalThis.setTimeout;
    let timeoutCalls = 0;
    timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: Parameters<typeof setTimeout>[0],
      timeout?: number,
      ...args: unknown[]
    ) => {
      timeoutCalls += 1;
      if (timeoutCalls === 1) {
        queueMicrotask(() => {
          if (typeof handler === 'function') handler(...args);
        });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout);
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((cmd: string[]) => {
      if (cmd[0] === 'iwgetid') {
        return hangingProcess;
      }

      if (cmd[0] === 'nmcli') {
        return createProcess({ stdout: 'yes:Fallback Linux\n' });
      }

      throw new Error(`Unexpected command: ${cmd.join(' ')}`);
    }) as typeof Bun.spawn);

    const result = await detectCurrentNetwork();

    expect(result).toEqual({
      id: 'wifi:Fallback Linux',
      label: 'Fallback Linux',
    });
    expect(hangingProcess.kill).toHaveBeenCalledTimes(1);
  });

  it('retries networksetup via PATH when the absolute macOS binary is unavailable', async () => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((cmd: string[]) => {
      if (cmd[0] === '/usr/sbin/networksetup') {
        throw new Error('Executable not found in $PATH');
      }

      if (cmd[0] === 'networksetup' && cmd.includes('-listallhardwareports')) {
        return createProcess({
          stdout:
            'Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: aa:bb:cc:dd:ee:ff\n',
        });
      }

      if (cmd[0] === 'networksetup' && cmd.includes('-getairportnetwork')) {
        return createProcess({
          stdout: 'Current Wi-Fi Network: Fallback WiFi\n',
        });
      }

      throw new Error(`Unexpected command: ${cmd.join(' ')}`);
    }) as typeof Bun.spawn);

    const result = await detectCurrentNetwork();
    const spawnCalls = spawnSpy.mock.calls as unknown as Array<[string[]]>;

    expect(result).toEqual({
      id: 'wifi:Fallback WiFi',
      label: 'Fallback WiFi',
    });
    expect(spawnCalls.some((call) => call[0]?.[0] === 'networksetup')).toBe(
      true,
    );
  });

  it('uses nmcli on linux when iwgetid is empty', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });

    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((cmd: string[]) => {
      if (cmd[0] === 'iwgetid') {
        return createProcess({ stdout: '\n' });
      }

      if (cmd[0] === 'nmcli') {
        return createProcess({ stdout: 'no:Guest\nyes:Office Linux\n' });
      }

      throw new Error(`Unexpected command: ${cmd.join(' ')}`);
    }) as typeof Bun.spawn);

    const result = await detectCurrentNetwork();

    expect(result).toEqual({ id: 'wifi:Office Linux', label: 'Office Linux' });
  });

  it('returns null on linux when nmcli reports no active SSID', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });

    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((cmd: string[]) => {
      if (cmd[0] === 'iwgetid') {
        return createProcess({ stdout: '' });
      }

      if (cmd[0] === 'nmcli') {
        return createProcess({ stdout: 'no:Guest\nyes:   \n' });
      }

      throw new Error(`Unexpected command: ${cmd.join(' ')}`);
    }) as typeof Bun.spawn);

    const result = await detectCurrentNetwork();

    expect(result).toBeNull();
  });

  it('returns null on unsupported platforms without spawning subprocesses', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });

    spawnSpy = spyOn(Bun, 'spawn');

    const result = await detectCurrentNetwork();

    expect(result).toBeNull();
    expect(spawnSpy).not.toHaveBeenCalled();
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

function createHangingProcess() {
  return {
    stdout: new ReadableStream<Uint8Array>(),
    stderr: new ReadableStream<Uint8Array>(),
    exited: new Promise<number>(() => {}),
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
