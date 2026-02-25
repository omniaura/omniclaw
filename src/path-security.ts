/**
 * Path security utilities for OmniClaw.
 * Shared validation functions to prevent path traversal attacks.
 */

import path from 'path';

/**
 * Reject a relative path that contains directory traversal segments.
 * Works for all backends where the path is relative
 * to a workspace root.
 *
 * @param relativePath - The path to validate (relative to workspace root)
 * @param label - Human-readable label for error messages
 * @throws Error if path contains traversal segments
 */
export function rejectTraversalSegments(relativePath: string, label: string): void {
  // Normalize to handle different separators and resolve ./ segments
  const normalized = path.normalize(relativePath);

  // Split into segments and check for any '..' component
  const segments = normalized.split(path.sep);
  if (segments.includes('..')) {
    throw new Error(
      `Path traversal detected in ${label}: "${relativePath}" contains '..' segments`,
    );
  }

  // Also reject absolute paths
  if (path.isAbsolute(relativePath)) {
    throw new Error(
      `Absolute path rejected in ${label}: "${relativePath}" must be relative`,
    );
  }
}

/**
 * Validate that a resolved path stays within a parent directory.
 * Used for local filesystem operations where we can resolve real paths.
 *
 * @param resolved - The resolved full path to check
 * @param parent - The parent directory that must contain the path
 * @param label - Human-readable label for error messages
 * @throws Error if the resolved path escapes the parent
 */
export function assertPathWithin(resolved: string, parent: string, label: string): void {
  const normalizedResolved = path.resolve(resolved);
  const normalizedParent = path.resolve(parent);
  if (
    !normalizedResolved.startsWith(normalizedParent + path.sep) &&
    normalizedResolved !== normalizedParent
  ) {
    throw new Error(
      `Path traversal detected in ${label}: ${resolved} escapes ${parent}`,
    );
  }
}
