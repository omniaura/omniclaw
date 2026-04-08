/**
 * WhatsApp Authentication Script
 *
 * Run this during setup to authenticate with WhatsApp.
 * Displays QR code, waits for scan, saves credentials, then exits.
 *
 * Usage: npx tsx src/whatsapp-auth.ts
 */
import fs from 'fs';
import qrcode from 'qrcode-terminal';
import readline from 'readline';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import { createLogger } from './logger.js';

const AUTH_DIR = './store/auth';
const QR_FILE = './store/qr-data.txt';
const STATUS_FILE = './store/auth-status.txt';

const logger = createLogger({}, 'warn');

type CliOptions = {
  usePairingCode: boolean;
  phoneArg?: string;
};

type AuthLogger = ReturnType<typeof createLogger>;

type SocketLike = {
  requestPairingCode: (phoneNumber: string) => Promise<string>;
  ev: {
    on: (event: string, handler: (...args: any[]) => void) => void;
  };
};

type ConnectSocketDeps = {
  fs: Pick<typeof fs, 'writeFileSync' | 'unlinkSync'>;
  makeWASocket: (config: Parameters<typeof makeWASocket>[0]) => SocketLike;
  fetchLatestWaWebVersion: typeof fetchLatestWaWebVersion;
  makeCacheableSignalKeyStore: typeof makeCacheableSignalKeyStore;
  useMultiFileAuthState: typeof useMultiFileAuthState;
  qrcodeGenerate: (qr: string, options: { small: boolean }) => void;
  exit: (code: number) => void;
  setTimeout: typeof setTimeout;
  console: Pick<typeof console, 'log' | 'error'>;
  logger: AuthLogger;
};

type AuthenticateDeps = {
  fs: Pick<typeof fs, 'mkdirSync' | 'unlinkSync'>;
  askQuestion: (prompt: string) => Promise<string>;
  connectSocket: (phoneNumber?: string) => Promise<void>;
  console: Pick<typeof console, 'log'>;
};

const defaultConnectSocketDeps: ConnectSocketDeps = {
  fs,
  makeWASocket,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  qrcodeGenerate: qrcode.generate,
  exit: (code) => process.exit(code),
  setTimeout,
  console,
  logger,
};

const defaultAuthenticateDeps: AuthenticateDeps = {
  fs,
  askQuestion: (prompt) => askQuestion(prompt),
  connectSocket: (phoneNumber) => connectSocket(phoneNumber),
  console,
};

export function getCliOptions(argv = process.argv): CliOptions {
  return {
    usePairingCode: argv.includes('--pairing-code'),
    phoneArg: argv.find((_, i, values) => values[i - 1] === '--phone'),
  };
}

export function askQuestion(
  prompt: string,
  createInterface: typeof readline.createInterface = readline.createInterface,
): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function connectSocket(
  phoneNumber?: string,
  isReconnect = false,
  cliOptions = getCliOptions(),
  deps: ConnectSocketDeps = defaultConnectSocketDeps,
): Promise<void> {
  const { state, saveCreds } = await deps.useMultiFileAuthState(AUTH_DIR);

  if (state.creds.registered && !isReconnect) {
    deps.fs.writeFileSync(STATUS_FILE, 'already_authenticated');
    deps.console.log('✓ Already authenticated with WhatsApp');
    deps.console.log(
      '  To re-authenticate, delete the store/auth folder and run again.',
    );
    deps.exit(0);
    return;
  }

  const { version } = await deps.fetchLatestWaWebVersion({});
  const sock = deps.makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: deps.makeCacheableSignalKeyStore(state.keys, deps.logger),
    },
    printQRInTerminal: false,
    logger: deps.logger,
    browser: Browsers.macOS('Chrome'),
  });

  if (cliOptions.usePairingCode && phoneNumber && !state.creds.me) {
    deps.setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        deps.console.log(`\n🔗 Your pairing code: ${code}\n`);
        deps.console.log('  1. Open WhatsApp on your phone');
        deps.console.log('  2. Tap Settings → Linked Devices → Link a Device');
        deps.console.log('  3. Tap "Link with phone number instead"');
        deps.console.log(`  4. Enter this code: ${code}\n`);
        deps.fs.writeFileSync(STATUS_FILE, `pairing_code:${code}`);
      } catch (err: any) {
        deps.console.error('Failed to request pairing code:', err.message);
        deps.exit(1);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      deps.fs.writeFileSync(QR_FILE, qr);
      deps.console.log('Scan this QR code with WhatsApp:\n');
      deps.console.log('  1. Open WhatsApp on your phone');
      deps.console.log('  2. Tap Settings → Linked Devices → Link a Device');
      deps.console.log('  3. Point your camera at the QR code below\n');
      deps.qrcodeGenerate(qr, { small: true });
    }

    if (connection === 'close') {
      const reason = (
        lastDisconnect?.error as { output?: { statusCode?: number } }
      )?.output?.statusCode;

      if (reason === DisconnectReason.loggedOut) {
        deps.fs.writeFileSync(STATUS_FILE, 'failed:logged_out');
        deps.console.log('\n✗ Logged out. Delete store/auth and try again.');
        deps.exit(1);
      } else if (reason === DisconnectReason.timedOut) {
        deps.fs.writeFileSync(STATUS_FILE, 'failed:qr_timeout');
        deps.console.log('\n✗ QR code timed out. Please try again.');
        deps.exit(1);
      } else if (reason === 515) {
        deps.logger.warn(
          { statusCode: 515 },
          'Stream error after pairing — reconnecting',
        );
        void connectSocket(phoneNumber, true, cliOptions, deps);
      } else {
        deps.fs.writeFileSync(STATUS_FILE, `failed:${reason || 'unknown'}`);
        deps.console.log('\n✗ Connection failed. Please try again.');
        deps.exit(1);
      }
    }

    if (connection === 'open') {
      deps.fs.writeFileSync(STATUS_FILE, 'authenticated');

      try {
        deps.fs.unlinkSync(QR_FILE);
      } catch {}

      deps.console.log('\n✓ Successfully authenticated with WhatsApp!');
      deps.console.log('  Credentials saved to store/auth/');
      deps.console.log('  You can now start the OmniClaw service.\n');
      deps.setTimeout(() => deps.exit(0), 1000);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

export async function authenticate(
  cliOptions = getCliOptions(),
  deps: AuthenticateDeps = defaultAuthenticateDeps,
): Promise<void> {
  deps.fs.mkdirSync(AUTH_DIR, { recursive: true });

  try {
    deps.fs.unlinkSync(QR_FILE);
  } catch {}

  try {
    deps.fs.unlinkSync(STATUS_FILE);
  } catch {}

  let phoneNumber = cliOptions.phoneArg;
  if (cliOptions.usePairingCode && !phoneNumber) {
    phoneNumber = await deps.askQuestion(
      'Enter your phone number (with country code, no + or spaces, e.g. 14155551234): ',
    );
  }

  deps.console.log('Starting WhatsApp authentication...\n');
  await deps.connectSocket(phoneNumber);
}

if (import.meta.main) {
  authenticate().catch((err) => {
    console.error('Authentication failed:', err.message);
    process.exit(1);
  });
}
