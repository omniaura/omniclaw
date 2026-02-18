/**
 * Utilities for schedule calculation shared across task scheduling.
 * Extracted to eliminate duplication in task-scheduler.ts, ipc.ts, and db.ts.
 */

import { CronExpressionParser } from 'cron-parser';
import { TIMEZONE } from './config.js';
import { logger } from './logger.js';

export type ScheduleType = 'cron' | 'interval' | 'once';

/**
 * Calculate the next run time for a scheduled task.
 * Returns null if the schedule is invalid or one-shot (once) tasks.
 *
 * @param scheduleType - The type of schedule (cron, interval, once)
 * @param scheduleValue - The schedule value (cron expression, milliseconds, or ISO timestamp)
 * @param baseTime - Optional base time for calculation (defaults to now)
 * @returns ISO timestamp string or null
 */
export function calculateNextRun(
  scheduleType: ScheduleType,
  scheduleValue: string,
  baseTime: Date = new Date(),
): string | null {
  switch (scheduleType) {
    case 'cron': {
      try {
        const interval = CronExpressionParser.parse(scheduleValue, { tz: TIMEZONE });
        return interval.next().toISOString();
      } catch (err) {
        logger.warn(
          { scheduleValue, error: err instanceof Error ? err.message : String(err) },
          'Invalid cron expression',
        );
        return null;
      }
    }

    case 'interval': {
      const ms = parseInt(scheduleValue, 10);
      if (isNaN(ms) || ms <= 0) {
        logger.warn({ scheduleValue }, 'Invalid interval');
        return null;
      }
      return new Date(baseTime.getTime() + ms).toISOString();
    }

    case 'once': {
      const scheduled = new Date(scheduleValue);
      if (isNaN(scheduled.getTime())) {
        logger.warn({ scheduleValue }, 'Invalid timestamp for once schedule');
        return null;
      }
      // One-shot tasks return the scheduled time on first call,
      // then null on subsequent calls (handled by caller)
      return scheduled.toISOString();
    }

    default:
      logger.warn({ scheduleType }, 'Unknown schedule type');
      return null;
  }
}

/**
 * Validate a schedule configuration without calculating the next run.
 * Useful for validating user input before persisting.
 *
 * @param scheduleType - The type of schedule
 * @param scheduleValue - The schedule value
 * @returns true if valid, false otherwise
 */
export function validateSchedule(
  scheduleType: ScheduleType,
  scheduleValue: string,
): boolean {
  const nextRun = calculateNextRun(scheduleType, scheduleValue);
  return nextRun !== null;
}
