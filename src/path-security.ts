/**
 * Path security utilities for OmniClaw.
 * Shared validation functions to prevent path traversal attacks.
 *
 * Effect-migrated: core logic uses Effect.ts with typed errors.
 * Bridge functions maintain the original throwing API for non-Effect callers.
 */

import { Effect } from 'effect';
import * as S from '@effect/schema/Schema';
import path from 'path';

// ============================================================================
// Error Types
// ============================================================================

export class PathTraversalError extends S.TaggedError<PathTraversalError>()(
  'PathTraversalError',
  {
    path: S.String,
    label: S.String,
    reason: S.String,
  },
) {}

// ============================================================================
// Effect API
// ============================================================================

/**
 * Reject a relative path that contains directory traversal segments (Effect version).
 * Fails with PathTraversalError if the path is unsafe.
 */
export const rejectTraversalSegmentsEffect = (
  relativePath: string,
  label: string,
): Effect.Effect<void, PathTraversalError> => {
  // Normalize to handle different separators and resolve ./ segments
  const normalized = path.normalize(relativePath);

  // Split into segments and check for any '..' component
  const segments = normalized.split(path.sep);
  if (segments.includes('..')) {
    return Effect.fail(
      new PathTraversalError({
        path: relativePath,
        label,
        reason: `Path traversal detected in ${label}: "${relativePath}" contains '..' segments`,
      }),
    );
  }

  // Also reject absolute paths
  if (path.isAbsolute(relativePath)) {
    return Effect.fail(
      new PathTraversalError({
        path: relativePath,
        label,
        reason: `Absolute path rejected in ${label}: "${relativePath}" must be relative`,
      }),
    );
  }

  return Effect.void;
};

/**
 * Validate that a resolved path stays within a parent directory (Effect version).
 * Fails with PathTraversalError if the path escapes the parent.
 */
export const assertPathWithinEffect = (
  resolved: string,
  parent: string,
  label: string,
): Effect.Effect<void, PathTraversalError> => {
  const normalizedResolved = path.resolve(resolved);
  const normalizedParent = path.resolve(parent);
  if (
    !normalizedResolved.startsWith(normalizedParent + path.sep) &&
    normalizedResolved !== normalizedParent
  ) {
    return Effect.fail(
      new PathTraversalError({
        path: resolved,
        label,
        reason: `Path traversal detected in ${label}: ${resolved} escapes ${parent}`,
      }),
    );
  }

  return Effect.void;
};

// ============================================================================
// Bridge API (maintains original throwing signatures for non-Effect callers)
// ============================================================================

/**
 * Reject a relative path that contains directory traversal segments.
 * @throws Error if path contains traversal segments
 */
export function rejectTraversalSegments(
  relativePath: string,
  label: string,
): void {
  Effect.runSync(
    rejectTraversalSegmentsEffect(relativePath, label).pipe(
      Effect.catchAll((err) => Effect.die(new Error(err.reason))),
    ),
  );
}

/**
 * Validate that a resolved path stays within a parent directory.
 * @throws Error if the resolved path escapes the parent
 */
export function assertPathWithin(
  resolved: string,
  parent: string,
  label: string,
): void {
  Effect.runSync(
    assertPathWithinEffect(resolved, parent, label).pipe(
      Effect.catchAll((err) => Effect.die(new Error(err.reason))),
    ),
  );
}
