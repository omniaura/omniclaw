import { Effect, Ref, Layer, Context } from 'effect';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * User information for cross-platform mentions.
 * Populated at runtime from message activity.
 */
export interface UserInfo {
  /** Platform-specific user ID (e.g., Discord user ID, WhatsApp JID) */
  id: string;
  /** Display name or username */
  name: string;
  /** Platform identifier (discord, whatsapp, telegram) */
  platform: 'discord' | 'whatsapp' | 'telegram';
  /** Last seen timestamp */
  lastSeen: string;
}

/**
 * Registry mapping user names to their platform-specific IDs.
 * Key: normalized username (lowercase)
 * Value: UserInfo with platform details
 */
export type UserRegistry = Record<string, UserInfo>;

/**
 * Errors that can occur during user registry operations
 */
export class UserRegistryError {
  readonly _tag = 'UserRegistryError';
  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

/**
 * Service for managing user registry
 */
export interface UserRegistryService {
  /** Get user info by name (case-insensitive) */
  readonly getUser: (
    name: string,
  ) => Effect.Effect<UserInfo | null, UserRegistryError>;

  /** Add or update user in registry */
  readonly upsertUser: (
    user: UserInfo,
  ) => Effect.Effect<void, UserRegistryError>;

  /** Get all users for a platform */
  readonly getUsersByPlatform: (
    platform: UserInfo['platform'],
  ) => Effect.Effect<UserInfo[], UserRegistryError>;

  /** Load registry from disk */
  readonly load: () => Effect.Effect<void, UserRegistryError>;

  /** Save registry to disk */
  readonly save: () => Effect.Effect<void, UserRegistryError>;
}

export const UserRegistryService = Context.GenericTag<UserRegistryService>(
  'UserRegistryService',
);

const REGISTRY_PATH = '/workspace/ipc/user_registry.json';

/**
 * Create the user registry service implementation
 */
export const makeUserRegistryService = Effect.gen(function* (_) {
  // In-memory registry ref
  const registryRef = yield* _(Ref.make<UserRegistry>({}));

  const normalizeKey = (name: string) => name.toLowerCase().trim();

  const getUser = (
    name: string,
  ): Effect.Effect<UserInfo | null, UserRegistryError> =>
    Effect.gen(function* (_) {
      const registry = yield* _(Ref.get(registryRef));
      const key = normalizeKey(name);
      return registry[key] || null;
    });

  const upsertUser = (user: UserInfo): Effect.Effect<void, UserRegistryError> =>
    Effect.gen(function* (_) {
      const key = normalizeKey(user.name);
      yield* _(
        Ref.update(registryRef, (registry) => ({
          ...registry,
          [key]: { ...user, lastSeen: new Date().toISOString() },
        })),
      );
    });

  const getUsersByPlatform = (
    platform: UserInfo['platform'],
  ): Effect.Effect<UserInfo[], UserRegistryError> =>
    Effect.gen(function* (_) {
      const registry = yield* _(Ref.get(registryRef));
      return Object.values(registry).filter(
        (user) => user.platform === platform,
      );
    });

  const load = (): Effect.Effect<void, UserRegistryError> =>
    Effect.gen(function* (_) {
      try {
        // Ensure directory exists
        const dir = join(REGISTRY_PATH, '..');
        if (!existsSync(dir)) {
          yield* _(Effect.promise(() => mkdir(dir, { recursive: true })));
        }

        // Load registry if it exists
        if (existsSync(REGISTRY_PATH)) {
          const data = yield* _(
            Effect.promise(() => readFile(REGISTRY_PATH, 'utf-8')),
          );
          const registry = JSON.parse(data) as UserRegistry;
          yield* _(Ref.set(registryRef, registry));
        }
      } catch (error) {
        return yield* _(
          Effect.fail(
            new UserRegistryError('Failed to load user registry', error),
          ),
        );
      }
    });

  const save = (): Effect.Effect<void, UserRegistryError> =>
    Effect.gen(function* (_) {
      try {
        const registry = yield* _(Ref.get(registryRef));
        const data = JSON.stringify(registry, null, 2);
        yield* _(Effect.promise(() => writeFile(REGISTRY_PATH, data, 'utf-8')));
      } catch (error) {
        return yield* _(
          Effect.fail(
            new UserRegistryError('Failed to save user registry', error),
          ),
        );
      }
    });

  return {
    getUser,
    upsertUser,
    getUsersByPlatform,
    load,
    save,
  } satisfies UserRegistryService;
});

/**
 * Layer for providing the user registry service
 */
export const UserRegistryServiceLive = Layer.effect(
  UserRegistryService,
  makeUserRegistryService,
);

/**
 * Helper to format a platform-specific mention
 */
export const formatMention = (
  name: string,
): Effect.Effect<string, UserRegistryError, UserRegistryService> =>
  Effect.gen(function* (_) {
    const registry = yield* _(UserRegistryService);
    const user = yield* _(registry.getUser(name));

    if (!user) {
      // User not found - return plain @ mention as fallback
      return `@${name}`;
    }

    // Format based on platform
    switch (user.platform) {
      case 'discord':
        return `<@${user.id}>`;
      case 'whatsapp':
        // WhatsApp uses @<phone_number> format
        return `@${user.id}`;
      case 'telegram':
        // Telegram uses @username format
        return `@${user.name}`;
      default:
        return `@${user.name}`;
    }
  });
