import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mock as mockModule } from 'bun:test';

// Mock logger to prevent console noise during tests
mockModule.module('../logger.js', () => ({
  logger: {
    debug: mock(),
    info: mock(),
    warn: mock(),
    error: mock(),
  },
}));

import { StreamParser, OUTPUT_START_MARKER, OUTPUT_END_MARKER } from './stream-parser.js';
import type { ContainerOutput } from './types.js';

function makeOutput(overrides: Partial<ContainerOutput> = {}): ContainerOutput {
  return {
    status: 'success',
    result: 'test output',
    ...overrides,
  };
}

function wrapMarkers(json: string): string {
  return `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`;
}

describe('StreamParser', () => {
  let parser: StreamParser;
  let timeoutFn: ReturnType<typeof mock>;
  let outputFn: ReturnType<typeof mock<(o: ContainerOutput) => Promise<void>>>;

  beforeEach(() => {
    timeoutFn = mock();
    outputFn = mock(async () => {});
  });

  afterEach(() => {
    parser?.cleanup();
  });

  function createParser(overrides: Record<string, unknown> = {}) {
    return new StreamParser({
      groupName: 'test-group',
      containerName: 'test-container',
      timeoutMs: 60_000,
      startupTimeoutMs: 30_000,
      maxOutputSize: 1024 * 1024,
      onOutput: outputFn,
      onTimeout: timeoutFn,
      ...overrides,
    } as ConstructorParameters<typeof StreamParser>[0]);
  }

  /** Feed stdout and wait for the output chain to settle. */
  async function feedAndAwait(p: StreamParser, chunk: string): Promise<void> {
    p.feedStdout(chunk);
    await p.getState().outputChain;
  }

  // ============================================================
  // Output marker parsing
  // ============================================================

  describe('output marker parsing', () => {
    it('parses a complete output marker pair in a single chunk', async () => {
      parser = createParser();
      const output = makeOutput({ result: 'hello world' });
      await feedAndAwait(parser, wrapMarkers(JSON.stringify(output)));

      expect(outputFn).toHaveBeenCalledTimes(1);
      const arg = outputFn.mock.calls[0][0] as ContainerOutput;
      expect(arg.status).toBe('success');
      expect(arg.result).toBe('hello world');
    });

    it('parses markers split across multiple chunks', async () => {
      parser = createParser();
      const json = JSON.stringify(makeOutput({ result: 'split' }));
      const full = wrapMarkers(json);
      const mid = Math.floor(full.length / 2);

      parser.feedStdout(full.slice(0, mid));
      await parser.getState().outputChain;
      // Output not yet complete
      expect(outputFn).not.toHaveBeenCalled();

      await feedAndAwait(parser, full.slice(mid));
      // Now it should be parsed
      expect(outputFn).toHaveBeenCalledTimes(1);
      expect((outputFn.mock.calls[0][0] as ContainerOutput).result).toBe('split');
    });

    it('parses multiple output blocks in a single chunk', async () => {
      parser = createParser();
      const first = makeOutput({ result: 'first' });
      const second = makeOutput({ result: 'second' });
      const combined = wrapMarkers(JSON.stringify(first)) + wrapMarkers(JSON.stringify(second));

      await feedAndAwait(parser, combined);

      expect(outputFn).toHaveBeenCalledTimes(2);
      expect((outputFn.mock.calls[0][0] as ContainerOutput).result).toBe('first');
      expect((outputFn.mock.calls[1][0] as ContainerOutput).result).toBe('second');
    });

    it('parses multiple output blocks across interleaved chunks', async () => {
      parser = createParser();
      const first = wrapMarkers(JSON.stringify(makeOutput({ result: 'A' })));
      const second = wrapMarkers(JSON.stringify(makeOutput({ result: 'B' })));

      // Feed first complete, second split
      await feedAndAwait(parser, first + second.slice(0, 10));
      expect(outputFn).toHaveBeenCalledTimes(1);

      await feedAndAwait(parser, second.slice(10));
      expect(outputFn).toHaveBeenCalledTimes(2);
    });

    it('ignores non-marker stdout content', async () => {
      parser = createParser();
      await feedAndAwait(parser, 'random noise\nmore noise\n');

      expect(outputFn).not.toHaveBeenCalled();
    });

    it('handles noise before and after markers', async () => {
      parser = createParser();
      const output = makeOutput({ result: 'between noise' });
      await feedAndAwait(parser, 'prefix noise\n' + wrapMarkers(JSON.stringify(output)) + 'suffix noise\n');

      expect(outputFn).toHaveBeenCalledTimes(1);
      expect((outputFn.mock.calls[0][0] as ContainerOutput).result).toBe('between noise');
    });

    it('handles malformed JSON gracefully (does not throw)', async () => {
      parser = createParser();
      await feedAndAwait(parser, `${OUTPUT_START_MARKER}\n{not valid json\n${OUTPUT_END_MARKER}\n`);

      // Should not have called output (invalid JSON)
      expect(outputFn).not.toHaveBeenCalled();
      // Parser should not throw — it logs a warning
    });

    it('does not parse markers when onOutput is undefined', () => {
      parser = createParser({ onOutput: undefined });
      parser.feedStdout(wrapMarkers(JSON.stringify(makeOutput())));

      // No callback registered, so nothing should happen
      const state = parser.getState();
      expect(state.hadStreamingOutput).toBe(false);
    });
  });

  // ============================================================
  // Session ID tracking
  // ============================================================

  describe('session ID tracking', () => {
    it('captures newSessionId from output', async () => {
      parser = createParser();
      const output = makeOutput({ newSessionId: 'session-abc' });
      await feedAndAwait(parser, wrapMarkers(JSON.stringify(output)));

      expect(parser.getState().newSessionId).toBe('session-abc');
    });

    it('tracks the last newSessionId across multiple outputs', async () => {
      parser = createParser();
      await feedAndAwait(parser, wrapMarkers(JSON.stringify(makeOutput({ newSessionId: 'first' }))));
      await feedAndAwait(parser, wrapMarkers(JSON.stringify(makeOutput({ newSessionId: 'second' }))));

      expect(parser.getState().newSessionId).toBe('second');
    });

    it('newSessionId is undefined when outputs have none', async () => {
      parser = createParser();
      await feedAndAwait(parser, wrapMarkers(JSON.stringify(makeOutput())));

      expect(parser.getState().newSessionId).toBeUndefined();
    });
  });

  // ============================================================
  // Streaming output flag
  // ============================================================

  describe('hadStreamingOutput flag', () => {
    it('is false initially', () => {
      parser = createParser();
      expect(parser.getState().hadStreamingOutput).toBe(false);
    });

    it('is set to true after first valid output', () => {
      parser = createParser();
      parser.feedStdout(wrapMarkers(JSON.stringify(makeOutput())));
      // hadStreamingOutput is set synchronously during parsing, before the async chain
      expect(parser.getState().hadStreamingOutput).toBe(true);
    });
  });

  // ============================================================
  // Stdout truncation
  // ============================================================

  describe('stdout truncation', () => {
    it('accumulates stdout up to maxOutputSize', () => {
      parser = createParser({ maxOutputSize: 100 });
      parser.feedStdout('a'.repeat(50));
      parser.feedStdout('b'.repeat(50));

      const state = parser.getState();
      expect(state.stdout).toBe('a'.repeat(50) + 'b'.repeat(50));
      expect(state.stdoutTruncated).toBe(false);
    });

    it('truncates stdout that exceeds maxOutputSize', () => {
      parser = createParser({ maxOutputSize: 100 });
      parser.feedStdout('a'.repeat(80));
      parser.feedStdout('b'.repeat(80));

      const state = parser.getState();
      expect(state.stdout.length).toBe(100);
      expect(state.stdout).toBe('a'.repeat(80) + 'b'.repeat(20));
      expect(state.stdoutTruncated).toBe(true);
    });

    it('stops accumulating after truncation', () => {
      parser = createParser({ maxOutputSize: 50 });
      parser.feedStdout('x'.repeat(50));
      parser.feedStdout('y'.repeat(50));
      parser.feedStdout('z'.repeat(50));

      const state = parser.getState();
      expect(state.stdout.length).toBe(50);
      expect(state.stdout).toBe('x'.repeat(50));
      expect(state.stdoutTruncated).toBe(true);
    });
  });

  // ============================================================
  // Stderr truncation
  // ============================================================

  describe('stderr truncation', () => {
    it('accumulates stderr up to maxOutputSize', () => {
      parser = createParser({ maxOutputSize: 100 });
      parser.feedStderr('warn1\n');
      parser.feedStderr('warn2\n');

      const state = parser.getState();
      expect(state.stderr).toContain('warn1');
      expect(state.stderr).toContain('warn2');
      expect(state.stderrTruncated).toBe(false);
    });

    it('truncates stderr that exceeds maxOutputSize', () => {
      parser = createParser({ maxOutputSize: 50 });
      parser.feedStderr('e'.repeat(40));
      parser.feedStderr('f'.repeat(40));

      const state = parser.getState();
      expect(state.stderr.length).toBe(50);
      expect(state.stderrTruncated).toBe(true);
    });

    it('stops accumulating after truncation', () => {
      parser = createParser({ maxOutputSize: 30 });
      parser.feedStderr('a'.repeat(30));
      parser.feedStderr('b'.repeat(30));

      const state = parser.getState();
      expect(state.stderr.length).toBe(30);
      expect(state.stderrTruncated).toBe(true);
    });
  });

  // ============================================================
  // Startup timer behavior
  // ============================================================

  describe('startup timer', () => {
    it('fires timeout when no stderr received within startupTimeoutMs', async () => {
      parser = createParser({ startupTimeoutMs: 50, timeoutMs: 60_000 });

      // Wait for startup timer to fire
      await Bun.sleep(100);

      expect(timeoutFn).toHaveBeenCalledTimes(1);
      expect(parser.getState().timedOut).toBe(true);
    });

    it('clears startup timer when stderr is received', async () => {
      parser = createParser({ startupTimeoutMs: 50, timeoutMs: 60_000 });

      // Feed stderr immediately — should clear the startup timer
      parser.feedStderr('Claude Agent SDK started\n');

      // Wait past the startup timeout
      await Bun.sleep(100);

      // Timeout should NOT have fired (startup timer was cleared)
      expect(timeoutFn).not.toHaveBeenCalled();
      expect(parser.getState().timedOut).toBe(false);
    });
  });

  // ============================================================
  // Main timeout behavior
  // ============================================================

  describe('main timeout', () => {
    it('fires timeout after timeoutMs of inactivity', async () => {
      parser = createParser({ timeoutMs: 50, startupTimeoutMs: 60_000 });

      // Clear startup timer by feeding stderr
      parser.feedStderr('startup ok\n');

      await Bun.sleep(100);

      expect(timeoutFn).toHaveBeenCalledTimes(1);
      expect(parser.getState().timedOut).toBe(true);
    });

    it('resets the main timeout when output markers are parsed', async () => {
      parser = createParser({ timeoutMs: 100, startupTimeoutMs: 60_000 });

      // Clear startup timer
      parser.feedStderr('startup ok\n');

      // At 50ms, feed valid output — this should reset the main timeout
      await Bun.sleep(50);
      parser.feedStdout(wrapMarkers(JSON.stringify(makeOutput())));

      // At 100ms from start (50ms after reset), timeout should NOT have fired
      await Bun.sleep(40);
      expect(timeoutFn).not.toHaveBeenCalled();

      // Wait for the full reset period
      await Bun.sleep(100);
      expect(timeoutFn).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // Cleanup
  // ============================================================

  describe('cleanup', () => {
    it('prevents timeout from firing after cleanup', async () => {
      parser = createParser({ timeoutMs: 50, startupTimeoutMs: 50 });
      parser.cleanup();

      await Bun.sleep(100);

      expect(timeoutFn).not.toHaveBeenCalled();
    });

    it('can be called multiple times without error', () => {
      parser = createParser();
      parser.cleanup();
      parser.cleanup();
      // No throw
    });
  });

  // ============================================================
  // parseFinalOutput (legacy mode)
  // ============================================================

  describe('parseFinalOutput', () => {
    it('parses output from between markers in accumulated stdout', () => {
      parser = createParser({ onOutput: undefined });
      const output = makeOutput({ result: 'final' });
      parser.feedStdout(wrapMarkers(JSON.stringify(output)));

      const result = parser.parseFinalOutput();
      expect(result.status).toBe('success');
      expect(result.result).toBe('final');
    });

    it('falls back to last line of stdout when no markers present', () => {
      parser = createParser({ onOutput: undefined });
      const output = makeOutput({ result: 'last-line' });
      parser.feedStdout('some prefix\n' + JSON.stringify(output) + '\n');

      const result = parser.parseFinalOutput();
      expect(result.result).toBe('last-line');
    });

    it('parses markers even with surrounding noise', () => {
      parser = createParser({ onOutput: undefined });
      const output = makeOutput({ result: 'noisy' });
      parser.feedStdout(
        'noise before\n' + wrapMarkers(JSON.stringify(output)) + 'noise after\n'
      );

      const result = parser.parseFinalOutput();
      expect(result.result).toBe('noisy');
    });

    it('throws on invalid JSON in final output', () => {
      parser = createParser({ onOutput: undefined });
      parser.feedStdout('not json at all');

      expect(() => parser.parseFinalOutput()).toThrow();
    });
  });

  // ============================================================
  // Output chaining (ordered async callbacks)
  // ============================================================

  describe('output chaining', () => {
    it('calls output callbacks in order even with async operations', async () => {
      const callOrder: string[] = [];
      const slowOutputFn = mock(async (output: ContainerOutput) => {
        const id = output.result || 'unknown';
        // Simulate different async durations
        if (id === 'first') await Bun.sleep(20);
        callOrder.push(id);
      });

      parser = createParser({ onOutput: slowOutputFn });

      // Feed both outputs synchronously
      parser.feedStdout(wrapMarkers(JSON.stringify(makeOutput({ result: 'first' }))));
      parser.feedStdout(wrapMarkers(JSON.stringify(makeOutput({ result: 'second' }))));

      // Wait for async chain to complete
      await parser.getState().outputChain;

      // Even though 'first' takes longer, it should complete before 'second' starts
      expect(callOrder).toEqual(['first', 'second']);
    });
  });

  // ============================================================
  // Marker constants
  // ============================================================

  describe('marker constants', () => {
    it('exports expected marker strings', () => {
      expect(OUTPUT_START_MARKER).toBe('---OMNICLAW_OUTPUT_START---');
      expect(OUTPUT_END_MARKER).toBe('---OMNICLAW_OUTPUT_END---');
    });
  });
});
