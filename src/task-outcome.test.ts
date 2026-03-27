import { describe, it, expect } from 'bun:test';

import type { ContainerOutput } from './backends/types.js';
import { inferOutcome } from './task-scheduler.js';

describe('inferOutcome', () => {
  it('returns done when output is successful with no explicit signal', () => {
    const output: ContainerOutput = { status: 'success', result: 'ok' };
    expect(inferOutcome(output, null, false)).toEqual({ state: 'done' });
  });

  it('returns blocked when there is an error and no explicit signal', () => {
    const output: ContainerOutput = {
      status: 'error',
      result: null,
      error: 'API rate limited',
    };
    expect(inferOutcome(output, 'API rate limited', false)).toEqual({
      state: 'blocked',
      reason: 'API rate limited',
    });
  });

  it('returns abandoned when timed out', () => {
    expect(inferOutcome(null, 'timed out waiting', true)).toEqual({
      state: 'abandoned',
      reason: 'Execution timed out',
    });
  });

  it('prefers explicit agent signal over inference', () => {
    const output: ContainerOutput = {
      status: 'success',
      result: 'partial',
      outcome: {
        state: 'blocked',
        reason: 'Need user API key',
        question: 'What is your OpenAI API key?',
      },
    };
    expect(inferOutcome(output, null, false)).toEqual({
      state: 'blocked',
      reason: 'Need user API key',
      question: 'What is your OpenAI API key?',
    });
  });

  it('prefers explicit abandoned signal over error inference', () => {
    const output: ContainerOutput = {
      status: 'error',
      result: null,
      error: 'some error',
      outcome: {
        state: 'abandoned',
        reason: 'Unrecoverable — missing credentials',
      },
    };
    expect(inferOutcome(output, 'some error', false)).toEqual({
      state: 'abandoned',
      reason: 'Unrecoverable — missing credentials',
    });
  });

  it('falls back to inference when outcome state is invalid', () => {
    const output: ContainerOutput = {
      status: 'success',
      result: 'ok',
      outcome: { state: 'invalid' as any },
    };
    expect(inferOutcome(output, null, false)).toEqual({ state: 'done' });
  });

  it('falls back to inference when outcome is malformed (missing state)', () => {
    const output: ContainerOutput = {
      status: 'error',
      result: null,
      error: 'oops',
      outcome: {} as any,
    };
    expect(inferOutcome(output, 'oops', false)).toEqual({
      state: 'blocked',
      reason: 'oops',
    });
  });

  it('returns done for null output with no error', () => {
    expect(inferOutcome(null, null, false)).toEqual({ state: 'done' });
  });

  it('timeout takes priority over error', () => {
    expect(inferOutcome(null, 'connection refused', true)).toEqual({
      state: 'abandoned',
      reason: 'Execution timed out',
    });
  });

  it('explicit done signal passes through reason', () => {
    const output: ContainerOutput = {
      status: 'success',
      result: 'done',
      outcome: { state: 'done', reason: 'All steps completed' },
    };
    expect(inferOutcome(output, null, false)).toEqual({
      state: 'done',
      reason: 'All steps completed',
    });
  });
});
