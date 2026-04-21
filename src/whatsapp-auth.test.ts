import { beforeEach, describe, expect, it, mock } from 'bun:test';

import fs from 'fs';

import { DisconnectReason } from '@whiskeysockets/baileys';

import {
  askQuestion,
  authenticate,
  connectSocket,
  getCliOptions,
} from './whatsapp-auth.js';

type Handler = (...args: any[]) => void;
type ConnectSocketDeps = NonNullable<Parameters<typeof connectSocket>[3]>;

function createSocketHarness(pairingCode = '123-456') {
  const handlers: Record<string, Handler> = {};
  const requestPairingCode = mock(async (_phoneNumber: string) => pairingCode);

  return {
    handlers,
    socket: {
      requestPairingCode,
      ev: {
        on: mock((event: string, handler: Handler) => {
          handlers[event] = handler;
        }),
      },
    },
    requestPairingCode,
  };
}

function createConnectDeps(overrides: Record<string, unknown> = {}) {
  const timers: Array<() => void | Promise<void>> = [];
  const socketHarness = createSocketHarness();
  const saveCreds = mock(() => {});
  const writeFileSync = mock(() => {});
  const unlinkSync = mock(() => {});
  const exit = mock((_code: number) => {});
  const log = mock(() => {});
  const error = mock(() => {});
  const warn = mock(() => {});

  const deps = {
    fs: { writeFileSync, unlinkSync },
    makeWASocket: mock((_config: unknown) => socketHarness.socket),
    fetchLatestWaWebVersion: mock(async () => ({
      version: [1, 2, 3],
      isLatest: true,
    })),
    makeCacheableSignalKeyStore: mock(
      (_keys: unknown, _logger: unknown) => ({}),
    ),
    useMultiFileAuthState: mock(async () => ({
      state: { creds: { registered: false }, keys: {} },
      saveCreds,
    })),
    qrcodeGenerate: mock((_qr: string, _options: { small: boolean }) => {}),
    exit,
    setTimeout: mock((handler: () => void | Promise<void>, _delay: number) => {
      timers.push(handler);
      return 1 as unknown as Timer;
    }),
    console: { log, error },
    logger: { warn } as unknown,
  };

  return {
    deps: { ...deps, ...overrides } as unknown as ConnectSocketDeps,
    timers,
    socketHarness,
    writeFileSync,
    unlinkSync,
    exit,
    log,
    error,
    warn,
    saveCreds,
  };
}

describe('getCliOptions', () => {
  it('parses pairing mode and phone number flags', () => {
    expect(
      getCliOptions([
        'bun',
        'src/whatsapp-auth.ts',
        '--pairing-code',
        '--phone',
        '14155551234',
      ]),
    ).toEqual({
      usePairingCode: true,
      phoneArg: '14155551234',
    });
  });

  it('returns falsey defaults when flags are absent', () => {
    expect(getCliOptions(['bun', 'src/whatsapp-auth.ts'])).toEqual({
      usePairingCode: false,
      phoneArg: undefined,
    });
  });
});

describe('askQuestion', () => {
  it('trims the answer and closes the readline interface', async () => {
    const close = mock(() => {});
    const createInterface = mock(() => ({
      question: (_prompt: string, callback: (answer: string) => void) => {
        callback('  14155551234  ');
      },
      close,
    }));

    await expect(askQuestion('Phone?', createInterface as never)).resolves.toBe(
      '14155551234',
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('authenticate', () => {
  it('cleans stale files, prompts in pairing mode, and connects with the answer', async () => {
    const mkdirSync = mock(
      ((..._args: Parameters<typeof fs.mkdirSync>) =>
        undefined) as typeof fs.mkdirSync,
    );
    const unlinkSync = mock(() => {
      throw new Error('missing');
    });
    const askQuestionMock = mock(async () => '14155551234');
    const connectSocketMock = mock(async (_phoneNumber?: string) => {});
    const log = mock(() => {});

    await authenticate(
      { usePairingCode: true },
      {
        fs: { mkdirSync, unlinkSync },
        askQuestion: askQuestionMock,
        connectSocket: connectSocketMock,
        console: { log },
      },
    );

    expect(mkdirSync).toHaveBeenCalledWith('./store/auth', { recursive: true });
    expect(unlinkSync).toHaveBeenCalledTimes(2);
    expect(askQuestionMock).toHaveBeenCalledTimes(1);
    expect(connectSocketMock).toHaveBeenCalledWith('14155551234');
  });
});

describe('connectSocket', () => {
  let cliOptions: ReturnType<typeof getCliOptions>;

  beforeEach(() => {
    cliOptions = { usePairingCode: false };
  });

  it('exits early when credentials are already registered', async () => {
    const harness = createConnectDeps({
      useMultiFileAuthState: mock(async () => ({
        state: { creds: { registered: true }, keys: {} },
        saveCreds: mock(() => {}),
      })),
    });

    await connectSocket(undefined, false, cliOptions, harness.deps);

    expect(harness.writeFileSync).toHaveBeenCalledWith(
      './store/auth-status.txt',
      'already_authenticated',
    );
    expect(harness.exit).toHaveBeenCalledWith(0);
    expect(harness.deps.makeWASocket).not.toHaveBeenCalled();
  });

  it('requests a pairing code and records it after the delayed startup timer', async () => {
    const harness = createConnectDeps();

    await connectSocket(
      '14155551234',
      false,
      { usePairingCode: true },
      harness.deps,
    );

    expect(harness.timers).toHaveLength(1);
    await harness.timers[0]!();
    expect(harness.socketHarness.requestPairingCode).toHaveBeenCalledWith(
      '14155551234',
    );
    expect(harness.writeFileSync).toHaveBeenCalledWith(
      './store/auth-status.txt',
      'pairing_code:123-456',
    );
  });

  it('fails the flow when requesting a pairing code throws', async () => {
    const harness = createConnectDeps();
    harness.socketHarness.requestPairingCode.mockImplementationOnce(async () => {
      throw new Error('phone offline');
    });

    await connectSocket(
      '14155551234',
      false,
      { usePairingCode: true },
      harness.deps,
    );

    expect(harness.timers).toHaveLength(1);
    await harness.timers[0]!();

    expect(harness.error).toHaveBeenCalledWith(
      'Failed to request pairing code:',
      'phone offline',
    );
    expect(harness.exit).toHaveBeenCalledWith(1);
  });

  it('writes QR payloads and renders them in the terminal', async () => {
    const harness = createConnectDeps();

    await connectSocket(undefined, false, cliOptions, harness.deps);
    harness.socketHarness.handlers['connection.update']({ qr: 'qr-payload' });

    expect(harness.writeFileSync).toHaveBeenCalledWith(
      './store/qr-data.txt',
      'qr-payload',
    );
    expect(harness.deps.qrcodeGenerate).toHaveBeenCalledWith('qr-payload', {
      small: true,
    });
  });

  it('marks logged-out disconnects as failures', async () => {
    const harness = createConnectDeps();

    await connectSocket(undefined, false, cliOptions, harness.deps);
    harness.socketHarness.handlers['connection.update']({
      connection: 'close',
      lastDisconnect: {
        error: { output: { statusCode: DisconnectReason.loggedOut } },
      },
    });

    expect(harness.writeFileSync).toHaveBeenCalledWith(
      './store/auth-status.txt',
      'failed:logged_out',
    );
    expect(harness.exit).toHaveBeenCalledWith(1);
  });

  it('marks timed-out disconnects as qr timeouts', async () => {
    const harness = createConnectDeps();

    await connectSocket(undefined, false, cliOptions, harness.deps);
    harness.socketHarness.handlers['connection.update']({
      connection: 'close',
      lastDisconnect: {
        error: { output: { statusCode: DisconnectReason.timedOut } },
      },
    });

    expect(harness.writeFileSync).toHaveBeenCalledWith(
      './store/auth-status.txt',
      'failed:qr_timeout',
    );
    expect(harness.exit).toHaveBeenCalledWith(1);
  });

  it('reconnects after stream error 515 instead of failing the flow', async () => {
    const harness = createConnectDeps();

    await connectSocket('14155551234', false, cliOptions, harness.deps);
    harness.socketHarness.handlers['connection.update']({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.warn).toHaveBeenCalledTimes(1);
    expect(harness.deps.makeWASocket).toHaveBeenCalledTimes(2);
    expect(harness.exit).not.toHaveBeenCalled();
  });

  it('records successful authentication, removes the QR file, and exits after the success timer', async () => {
    const harness = createConnectDeps();

    await connectSocket(undefined, false, cliOptions, harness.deps);
    harness.socketHarness.handlers['connection.update']({ connection: 'open' });

    expect(harness.writeFileSync).toHaveBeenCalledWith(
      './store/auth-status.txt',
      'authenticated',
    );
    expect(harness.unlinkSync).toHaveBeenCalledWith('./store/qr-data.txt');
    expect(harness.timers).toHaveLength(1);
    harness.timers[0]!();
    expect(harness.exit).toHaveBeenCalledWith(0);
  });

  it('records unknown close reasons as generic failures', async () => {
    const harness = createConnectDeps();

    await connectSocket(undefined, false, cliOptions, harness.deps);
    harness.socketHarness.handlers['connection.update']({
      connection: 'close',
    });

    expect(harness.writeFileSync).toHaveBeenCalledWith(
      './store/auth-status.txt',
      'failed:unknown',
    );
    expect(harness.exit).toHaveBeenCalledWith(1);
  });
});
