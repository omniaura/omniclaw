import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

import { calculateNextRun, validateSchedule, type ScheduleType } from './schedule-utils.js';

describe('schedule-utils', () => {
  describe('calculateNextRun', () => {
    describe('cron schedules', () => {
      it('returns a valid ISO timestamp for a valid cron expression', () => {
        const result = calculateNextRun('cron', '0 9 * * *');
        expect(result).not.toBeNull();
        // Should be a valid ISO date
        expect(new Date(result!).toISOString()).toBe(result);
      });

      it('returns a future date', () => {
        const result = calculateNextRun('cron', '* * * * *');
        expect(result).not.toBeNull();
        const nextRun = new Date(result!);
        // next run should be in the future (within a couple minutes)
        expect(nextRun.getTime()).toBeGreaterThan(Date.now() - 60_000);
      });

      it('returns null for an invalid cron expression', () => {
        const result = calculateNextRun('cron', 'not-a-cron');
        expect(result).toBeNull();
      });

      it('handles empty string cron (cron-parser treats as valid defaults)', () => {
        const result = calculateNextRun('cron', '');
        // cron-parser accepts empty string with default field values
        expect(result).not.toBeNull();
        expect(new Date(result!).toISOString()).toBe(result);
      });
    });

    describe('interval schedules', () => {
      it('returns baseTime + interval for valid milliseconds', () => {
        const base = new Date('2025-01-15T10:00:00.000Z');
        const result = calculateNextRun('interval', '60000', base);
        expect(result).toBe('2025-01-15T10:01:00.000Z');
      });

      it('handles large intervals', () => {
        const base = new Date('2025-01-15T10:00:00.000Z');
        const result = calculateNextRun('interval', '3600000', base); // 1 hour
        expect(result).toBe('2025-01-15T11:00:00.000Z');
      });

      it('returns null for non-numeric interval', () => {
        const result = calculateNextRun('interval', 'abc');
        expect(result).toBeNull();
      });

      it('returns null for zero interval', () => {
        const result = calculateNextRun('interval', '0');
        expect(result).toBeNull();
      });

      it('returns null for negative interval', () => {
        const result = calculateNextRun('interval', '-1000');
        expect(result).toBeNull();
      });

      it('returns null for empty string interval', () => {
        const result = calculateNextRun('interval', '');
        expect(result).toBeNull();
      });

      it('defaults baseTime to now when not provided', () => {
        const before = Date.now();
        const result = calculateNextRun('interval', '5000');
        const after = Date.now();
        expect(result).not.toBeNull();
        const nextRun = new Date(result!).getTime();
        expect(nextRun).toBeGreaterThanOrEqual(before + 5000);
        expect(nextRun).toBeLessThanOrEqual(after + 5000);
      });
    });

    describe('once schedules', () => {
      it('returns the ISO timestamp for a valid date string', () => {
        const result = calculateNextRun('once', '2025-06-01T12:00:00.000Z');
        expect(result).toBe('2025-06-01T12:00:00.000Z');
      });

      it('parses various date formats', () => {
        const result = calculateNextRun('once', '2025-06-01T12:00:00');
        expect(result).not.toBeNull();
        expect(new Date(result!).getFullYear()).toBe(2025);
      });

      it('returns null for an invalid date string', () => {
        const result = calculateNextRun('once', 'not-a-date');
        expect(result).toBeNull();
      });

      it('returns null for empty string', () => {
        const result = calculateNextRun('once', '');
        expect(result).toBeNull();
      });
    });

    describe('unknown schedule type', () => {
      it('returns null for unknown types', () => {
        const result = calculateNextRun('unknown' as ScheduleType, '123');
        expect(result).toBeNull();
      });
    });
  });

  describe('validateSchedule', () => {
    it('returns true for valid cron', () => {
      expect(validateSchedule('cron', '0 9 * * *')).toBe(true);
    });

    it('returns false for invalid cron', () => {
      expect(validateSchedule('cron', 'bad')).toBe(false);
    });

    it('returns true for valid interval', () => {
      expect(validateSchedule('interval', '60000')).toBe(true);
    });

    it('returns false for invalid interval', () => {
      expect(validateSchedule('interval', '-1')).toBe(false);
    });

    it('returns true for valid once timestamp', () => {
      expect(validateSchedule('once', '2025-06-01T12:00:00.000Z')).toBe(true);
    });

    it('returns false for invalid once timestamp', () => {
      expect(validateSchedule('once', 'garbage')).toBe(false);
    });
  });
});
