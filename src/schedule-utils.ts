/**
 * Utilities for schedule calculation shared across task scheduling.
 * Extracted to eliminate duplication in task-scheduler.ts, ipc.ts, and db.ts.
 *
 * Effect-migrated: core logic uses Effect.ts with typed errors.
 * Bridge functions maintain the original API for non-Effect callers.
 */

import { Effect } from 'effect';
import * as S from '@effect/schema/Schema';
import { CronExpressionParser } from 'cron-parser';
import { TIMEZONE } from './config.js';
import { logger } from './logger.js';

export type ScheduleType = 'cron' | 'interval' | 'once';

// ============================================================================
// Error Types
// ============================================================================

export class ScheduleValidationError extends S.TaggedError<ScheduleValidationError>()(
  'ScheduleValidationError',
  {
    scheduleType: S.String,
    scheduleValue: S.String,
    reason: S.String,
  },
) {}

// ============================================================================
// Effect API
// ============================================================================

/**
 * Calculate the next run time for a scheduled task (Effect version).
 * Returns the next ISO timestamp or fails with ScheduleValidationError.
 */
export const calculateNextRunEffect = (
  scheduleType: ScheduleType,
  scheduleValue: string,
  baseTime: Date = new Date(),
): Effect.Effect<string, ScheduleValidationError> => {
  switch (scheduleType) {
    case 'cron':
      return Effect.try({
        try: () => {
          const interval = CronExpressionParser.parse(scheduleValue, {
            tz: TIMEZONE,
          });
          const iso = interval.next().toISOString();
          if (iso === null) {
            throw new Error('CronDate.toISOString() returned null');
          }
          return iso;
        },
        catch: (err) =>
          new ScheduleValidationError({
            scheduleType,
            scheduleValue,
            reason: `Invalid cron expression: ${err instanceof Error ? err.message : String(err)}`,
          }),
      });

    case 'interval': {
      const ms = parseInt(scheduleValue, 10);
      if (isNaN(ms) || ms <= 0) {
        return Effect.fail(
          new ScheduleValidationError({
            scheduleType,
            scheduleValue,
            reason: 'Invalid interval: must be a positive integer',
          }),
        );
      }
      return Effect.succeed(new Date(baseTime.getTime() + ms).toISOString());
    }

    case 'once': {
      const scheduled = new Date(scheduleValue);
      if (isNaN(scheduled.getTime())) {
        return Effect.fail(
          new ScheduleValidationError({
            scheduleType,
            scheduleValue,
            reason: 'Invalid timestamp for once schedule',
          }),
        );
      }
      return Effect.succeed(scheduled.toISOString());
    }

    default:
      return Effect.fail(
        new ScheduleValidationError({
          scheduleType: scheduleType as string,
          scheduleValue,
          reason: `Unknown schedule type: ${scheduleType}`,
        }),
      );
  }
};

/**
 * Validate a schedule configuration (Effect version).
 * Succeeds if valid, fails with ScheduleValidationError otherwise.
 */
export const validateScheduleEffect = (
  scheduleType: ScheduleType,
  scheduleValue: string,
): Effect.Effect<void, ScheduleValidationError> =>
  calculateNextRunEffect(scheduleType, scheduleValue).pipe(Effect.asVoid);

// ============================================================================
// Bridge API (maintains original signatures for non-Effect callers)
// ============================================================================

/**
 * Calculate the next run time for a scheduled task.
 * Returns null if the schedule is invalid or one-shot (once) tasks.
 */
export function calculateNextRun(
  scheduleType: ScheduleType,
  scheduleValue: string,
  baseTime: Date = new Date(),
): string | null {
  return Effect.runSync(
    calculateNextRunEffect(scheduleType, scheduleValue, baseTime).pipe(
      Effect.catchAll((err) => {
        logger.warn(
          { scheduleType: err.scheduleType, scheduleValue: err.scheduleValue },
          err.reason,
        );
        return Effect.succeed(null as string | null);
      }),
    ),
  );
}

/**
 * Validate a schedule configuration without calculating the next run.
 * Useful for validating user input before persisting.
 */
export function validateSchedule(
  scheduleType: ScheduleType,
  scheduleValue: string,
): boolean {
  return calculateNextRun(scheduleType, scheduleValue) !== null;
}
