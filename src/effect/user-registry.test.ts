import { describe, it, expect } from 'bun:test';
import { Effect, Layer } from 'effect';
import {
  UserRegistryService,
  UserRegistryServiceLive,
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
