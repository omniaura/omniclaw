import { describe, it, expect } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import {
  UserRegistryService,
  UserRegistryServiceLive,
  makeUserRegistryServiceAtPath,
  formatMention,
  UserRegistryError,
  type UserInfo,
} from './user-registry.js';

/**
 * Helper: run an effect that requires UserRegistryService,
 * providing the live layer. Does NOT touch disk — load/save are
 * never called in these tests (in-memory only).
 */
function runWithRegistry<E, A>(
  effect: Effect.Effect<A, E, UserRegistryService>,
) {
  return Effect.runPromise(Effect.provide(effect, UserRegistryServiceLive));
}

function runWithRegistryAtPath<E, A>(
  registryPath: string,
  effect: Effect.Effect<A, E, UserRegistryService>,
  now?: () => Date,
) {
  return Effect.runPromise(
    Effect.provide(
      effect,
      Layer.effect(
        UserRegistryService,
        makeUserRegistryServiceAtPath(registryPath, now),
      ),
    ),
  );
}

async function withTempRegistry<T>(
  callback: (registryPath: string, rootDir: string) => Promise<T>,
): Promise<T> {
  const rootDir = await mkdtemp(join(tmpdir(), 'omniclaw-user-registry-'));
  try {
    return await callback(join(rootDir, 'ipc', 'user_registry.json'), rootDir);
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
}

const alice: UserInfo = {
  id: '123456',
  name: 'Alice',
  platform: 'discord',
  lastSeen: '2024-01-01T00:00:00.000Z',
};

const bob: UserInfo = {
  id: '789',
  name: 'Bob',
  platform: 'whatsapp',
  lastSeen: '2024-01-01T00:00:00.000Z',
};

const charlie: UserInfo = {
  id: '999',
  name: 'Charlie',
  platform: 'telegram',
  lastSeen: '2024-01-01T00:00:00.000Z',
};

describe('UserRegistryService', () => {
  describe('getUser', () => {
    it('returns null for unknown user', async () => {
      const result = await runWithRegistry(
        Effect.gen(function* (_) {
          const svc = yield* _(UserRegistryService);
          return yield* _(svc.getUser('nonexistent'));
        }),
      );
      expect(result).toBeNull();
    });

    it('returns user after upsert', async () => {
      const result = await runWithRegistry(
        Effect.gen(function* (_) {
          const svc = yield* _(UserRegistryService);
          yield* _(svc.upsertUser(alice));
          return yield* _(svc.getUser('Alice'));
        }),
      );
      expect(result).not.toBeNull();
      expect(result!.id).toBe('123456');
      expect(result!.platform).toBe('discord');
    });

    it('is case-insensitive', async () => {
      const result = await runWithRegistry(
        Effect.gen(function* (_) {
          const svc = yield* _(UserRegistryService);
          yield* _(svc.upsertUser(alice));
          return yield* _(svc.getUser('ALICE'));
        }),
      );
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Alice');
    });

    it('trims whitespace in lookup key', async () => {
      const result = await runWithRegistry(
        Effect.gen(function* (_) {
          const svc = yield* _(UserRegistryService);
          yield* _(svc.upsertUser(alice));
          return yield* _(svc.getUser('  alice  '));
        }),
      );
      expect(result).not.toBeNull();
    });
  });

  describe('upsertUser', () => {
    it('updates lastSeen on upsert', async () => {
      const result = await runWithRegistry(
        Effect.gen(function* (_) {
          const svc = yield* _(UserRegistryService);
          yield* _(svc.upsertUser(alice));
          const user = yield* _(svc.getUser('Alice'));
          return user!.lastSeen;
        }),
      );
      // lastSeen should be updated to current time, not the original value
      expect(result).not.toBe('2024-01-01T00:00:00.000Z');
    });

    it('overwrites existing user data', async () => {
      const result = await runWithRegistry(
        Effect.gen(function* (_) {
          const svc = yield* _(UserRegistryService);
          yield* _(svc.upsertUser(alice));
          yield* _(
            svc.upsertUser({
              ...alice,
              id: '999999',
            }),
          );
          return yield* _(svc.getUser('Alice'));
        }),
      );
      expect(result!.id).toBe('999999');
    });
  });

  describe('getUsersByPlatform', () => {
    it('returns empty array when no users registered', async () => {
      const result = await runWithRegistry(
        Effect.gen(function* (_) {
          const svc = yield* _(UserRegistryService);
          return yield* _(svc.getUsersByPlatform('discord'));
        }),
      );
      expect(result).toEqual([]);
    });

    it('filters users by platform', async () => {
      const result = await runWithRegistry(
        Effect.gen(function* (_) {
          const svc = yield* _(UserRegistryService);
          yield* _(svc.upsertUser(alice)); // discord
          yield* _(svc.upsertUser(bob)); // whatsapp
          yield* _(svc.upsertUser(charlie)); // telegram
          return yield* _(svc.getUsersByPlatform('discord'));
        }),
      );
      expect(result.length).toBe(1);
      expect(result[0].name).toBe('Alice');
    });

    it('returns multiple users for same platform', async () => {
      const discordBob: UserInfo = { ...bob, platform: 'discord' };
      const result = await runWithRegistry(
        Effect.gen(function* (_) {
          const svc = yield* _(UserRegistryService);
          yield* _(svc.upsertUser(alice));
          yield* _(svc.upsertUser(discordBob));
          return yield* _(svc.getUsersByPlatform('discord'));
        }),
      );
      expect(result.length).toBe(2);
    });
  });

  describe('load/save', () => {
    it('creates the registry directory when loading with no file', async () => {
      await withTempRegistry(async (registryPath, rootDir) => {
        await runWithRegistryAtPath(
          registryPath,
          Effect.gen(function* (_) {
            const svc = yield* _(UserRegistryService);
            yield* _(svc.load());
            return yield* _(svc.getUser('Alice'));
          }),
        );

        expect(existsSync(join(rootDir, 'ipc'))).toBe(true);
      });
    });

    it('loads users from disk and supports normalized lookups', async () => {
      await withTempRegistry(async (registryPath) => {
        await mkdir(join(registryPath, '..'), { recursive: true });
        await writeFile(
          registryPath,
          JSON.stringify({ alice }, null, 2),
          'utf-8',
        );

        const result = await runWithRegistryAtPath(
          registryPath,
          Effect.gen(function* (_) {
            const svc = yield* _(UserRegistryService);
            yield* _(svc.load());
            return yield* _(svc.getUser(' ALICE '));
          }),
        );

        expect(result).toEqual(alice);
      });
    });

    it('saves current users as pretty-printed JSON', async () => {
      await withTempRegistry(async (registryPath) => {
        const now = () => new Date('2026-06-24T12:34:56.789Z');

        await runWithRegistryAtPath(
          registryPath,
          Effect.gen(function* (_) {
            const svc = yield* _(UserRegistryService);
            yield* _(svc.load());
            yield* _(svc.upsertUser(alice));
            yield* _(svc.save());
          }),
          now,
        );

        const savedData = await readFile(registryPath, 'utf-8');
        const saved = JSON.parse(savedData);
        expect(Object.keys(saved)).toEqual(['alice']);
        expect(saved.alice.id).toBe('123456');
        expect(saved.alice.lastSeen).toBe('2026-06-24T12:34:56.789Z');
        expect(savedData).toBe(JSON.stringify(saved, null, 2));
      });
    });

    it('wraps invalid JSON load failures', async () => {
      await withTempRegistry(async (registryPath) => {
        await runWithRegistryAtPath(
          registryPath,
          Effect.gen(function* (_) {
            const svc = yield* _(UserRegistryService);
            yield* _(svc.load());
          }),
        );
        await writeFile(registryPath, '{ invalid json', 'utf-8');

        const error = await runWithRegistryAtPath(
          registryPath,
          Effect.gen(function* (_) {
            const svc = yield* _(UserRegistryService);
            return yield* _(Effect.flip(svc.load()));
          }),
        );

        expect(error).toMatchObject({
          _tag: 'UserRegistryError',
          message: 'Failed to load user registry',
        });
        expect(error.cause).toBeInstanceOf(SyntaxError);
      });
    });

    it('wraps registry directory creation failures', async () => {
      const rootDir = await mkdtemp(join(tmpdir(), 'omniclaw-user-registry-'));
      try {
        const blockerPath = join(rootDir, 'blocker');
        await writeFile(blockerPath, 'not a directory', 'utf-8');

        const error = await runWithRegistryAtPath(
          join(blockerPath, 'ipc', 'user_registry.json'),
          Effect.gen(function* (_) {
            const svc = yield* _(UserRegistryService);
            return yield* _(Effect.flip(svc.load()));
          }),
        );

        expect(error).toMatchObject({
          _tag: 'UserRegistryError',
          message: 'Failed to load user registry',
        });
        expect(error.cause).toBeInstanceOf(Error);
      } finally {
        await rm(rootDir, { force: true, recursive: true });
      }
    });

    it('wraps write failures', async () => {
      const rootDir = await mkdtemp(join(tmpdir(), 'omniclaw-user-registry-'));
      try {
        const error = await runWithRegistryAtPath(
          rootDir,
          Effect.gen(function* (_) {
            const svc = yield* _(UserRegistryService);
            yield* _(svc.upsertUser(alice));
            return yield* _(Effect.flip(svc.save()));
          }),
        );

        expect(error).toMatchObject({
          _tag: 'UserRegistryError',
          message: 'Failed to save user registry',
        });
        expect(error.cause).toBeInstanceOf(Error);
      } finally {
        await rm(rootDir, { force: true, recursive: true });
      }
    });
  });
});

describe('formatMention', () => {
  it('returns @name fallback for unknown user', async () => {
    const result = await runWithRegistry(
      Effect.gen(function* (_) {
        return yield* _(formatMention('nobody'));
      }),
    );
    expect(result).toBe('@nobody');
  });

  it('formats Discord mention as <@id>', async () => {
    const result = await runWithRegistry(
      Effect.gen(function* (_) {
        const svc = yield* _(UserRegistryService);
        yield* _(svc.upsertUser(alice));
        return yield* _(formatMention('Alice'));
      }),
    );
    expect(result).toBe('<@123456>');
  });

  it('formats WhatsApp mention as @id', async () => {
    const result = await runWithRegistry(
      Effect.gen(function* (_) {
        const svc = yield* _(UserRegistryService);
        yield* _(svc.upsertUser(bob));
        return yield* _(formatMention('Bob'));
      }),
    );
    expect(result).toBe('@789');
  });

  it('formats Telegram mention as @name', async () => {
    const result = await runWithRegistry(
      Effect.gen(function* (_) {
        const svc = yield* _(UserRegistryService);
        yield* _(svc.upsertUser(charlie));
        return yield* _(formatMention('Charlie'));
      }),
    );
    expect(result).toBe('@Charlie');
  });
});

describe('UserRegistryError', () => {
  it('has correct tag', () => {
    const err = new UserRegistryError('test error');
    expect(err._tag).toBe('UserRegistryError');
    expect(err.message).toBe('test error');
  });

  it('captures cause', () => {
    const cause = new Error('original');
    const err = new UserRegistryError('wrapper', cause);
    expect(err.cause).toBe(cause);
  });
});
