import { describe, expect, it } from 'bun:test';

describe('startSchedulerLoop', () => {
  it('runs the isolated scheduler-loop harness successfully', () => {
    const proc = Bun.spawnSync({
      cmd: ['bun', 'test', './src/task-scheduler-loop.harness.ts'],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    });

    if (proc.exitCode !== 0) {
      const stderr = new TextDecoder().decode(proc.stderr);
      const stdout = new TextDecoder().decode(proc.stdout);
      throw new Error(`Scheduler harness failed\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    }

    expect(proc.exitCode).toBe(0);
  });
});
