import { describe, expect, it } from 'bun:test';

function runWithTimezone(script: string, timezone: string): string {
  const proc = Bun.spawnSync({
    cmd: ['bun', '-e', script],
    env: { ...process.env, TZ: timezone },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(proc.exitCode).toBe(0);
  return new TextDecoder().decode(proc.stdout).trim();
}

describe('schedule-utils DST behavior', () => {
  it('uses baseTime for cron calculations deterministically', () => {
    const output = runWithTimezone(
      "import { calculateNextRun } from './src/schedule-utils.js'; const base = new Date('2025-01-15T10:00:00.000Z'); console.log(calculateNextRun('cron', '* * * * *', base));",
      'UTC',
    );

    expect(output).toBe('2025-01-15T10:01:00.000Z');
  });

  it('handles spring-forward gap in America/New_York', () => {
    const output = runWithTimezone(
      "import { calculateNextRun } from './src/schedule-utils.js'; const base = new Date('2025-03-09T06:59:00.000Z'); console.log(calculateNextRun('cron', '30 2 * * *', base));",
      'America/New_York',
    );

    expect(output).toBe('2025-03-09T07:30:00.000Z');
  });
});
