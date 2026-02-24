import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';

import { createLogger, type Logger } from './logger.js';

describe('logger', () => {
  let stderrOutput: string[];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrOutput = [];
    originalWrite = process.stderr.write;
    // @ts-expect-error - override for testing
    process.stderr.write = (chunk: string) => {
      stderrOutput.push(chunk);
      return true;
    };
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  describe('createLogger', () => {
    it('creates a logger with all log methods', () => {
      const logger = createLogger({}, 'info');
      expect(typeof logger.trace).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.fatal).toBe('function');
      expect(typeof logger.child).toBe('function');
    });

    it('exposes the effective log level', () => {
      const logger = createLogger({}, 'warn');
      expect(logger.level).toBe('warn');
    });
  });

  describe('level filtering', () => {
    it('suppresses messages below the configured level', () => {
      // Non-TTY mode (JSON output) - force non-TTY for consistent testing
      const origTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });

      const logger = createLogger({}, 'warn');
      logger.debug('should be suppressed');
      logger.info('should be suppressed');

      // Debug and info should produce no output since level is warn
      // But error/fatal are never suppressed
      expect(stderrOutput.length).toBe(0);

      Object.defineProperty(process.stderr, 'isTTY', { value: origTTY, configurable: true });
    });

    it('passes messages at or above the configured level', () => {
      const origTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });

      const logger = createLogger({}, 'warn');
      logger.warn('warning message');

      expect(stderrOutput.length).toBe(1);
      const parsed = JSON.parse(stderrOutput[0]);
      expect(parsed.level).toBe('warn');
      expect(parsed.msg).toBe('warning message');

      Object.defineProperty(process.stderr, 'isTTY', { value: origTTY, configurable: true });
    });

    it('never suppresses error messages regardless of level', () => {
      const origTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });

      const logger = createLogger({}, 'fatal');
      logger.error('critical error');

      expect(stderrOutput.length).toBe(1);
      const parsed = JSON.parse(stderrOutput[0]);
      expect(parsed.level).toBe('error');

      Object.defineProperty(process.stderr, 'isTTY', { value: origTTY, configurable: true });
    });

    it('never suppresses fatal messages regardless of level', () => {
      const origTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });

      const logger = createLogger({}, 'fatal');
      logger.fatal('system crash');

      expect(stderrOutput.length).toBe(1);
      const parsed = JSON.parse(stderrOutput[0]);
      expect(parsed.level).toBe('fatal');

      Object.defineProperty(process.stderr, 'isTTY', { value: origTTY, configurable: true });
    });
  });

  describe('JSON output (non-TTY)', () => {
    let origTTY: boolean | undefined;

    beforeEach(() => {
      origTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(process.stderr, 'isTTY', { value: origTTY, configurable: true });
    });

    it('outputs valid JSON records', () => {
      const logger = createLogger({}, 'info');
      logger.info('test message');

      expect(stderrOutput.length).toBe(1);
      const parsed = JSON.parse(stderrOutput[0]);
      expect(parsed.msg).toBe('test message');
      expect(parsed.level).toBe('info');
      expect(parsed.service).toBe('omniclaw');
      expect(typeof parsed.ts).toBe('number');
    });

    it('includes fields in JSON output', () => {
      const logger = createLogger({}, 'info');
      logger.info({ op: 'startup', group: 'main' }, 'Server started');

      const parsed = JSON.parse(stderrOutput[0]);
      expect(parsed.op).toBe('startup');
      expect(parsed.group).toBe('main');
      expect(parsed.msg).toBe('Server started');
    });

    it('includes default fields in all records', () => {
      const logger = createLogger({ container: 'test-container' }, 'info');
      logger.info('hello');

      const parsed = JSON.parse(stderrOutput[0]);
      expect(parsed.container).toBe('test-container');
    });
  });

  describe('child loggers', () => {
    let origTTY: boolean | undefined;

    beforeEach(() => {
      origTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(process.stderr, 'isTTY', { value: origTTY, configurable: true });
    });

    it('inherits parent defaults', () => {
      const parent = createLogger({ component: 'router' }, 'info');
      const child = parent.child({ group: 'main' });
      child.info('routing message');

      const parsed = JSON.parse(stderrOutput[0]);
      expect(parsed.component).toBe('router');
      expect(parsed.group).toBe('main');
    });

    it('overrides parent fields', () => {
      const parent = createLogger({ group: 'default' }, 'info');
      const child = parent.child({ group: 'override' });
      child.info('test');

      const parsed = JSON.parse(stderrOutput[0]);
      expect(parsed.group).toBe('override');
    });

    it('inherits log level from parent', () => {
      const parent = createLogger({}, 'error');
      const child = parent.child({ group: 'test' });
      child.info('should be suppressed');
      child.warn('should be suppressed');

      expect(stderrOutput.length).toBe(0);

      child.error('should pass');
      expect(stderrOutput.length).toBe(1);
    });
  });

  describe('error flattening', () => {
    let origTTY: boolean | undefined;

    beforeEach(() => {
      origTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(process.stderr, 'isTTY', { value: origTTY, configurable: true });
    });

    it('flattens Error objects to message string', () => {
      const logger = createLogger({}, 'error');
      logger.error({ err: new Error('something broke') }, 'Operation failed');

      const parsed = JSON.parse(stderrOutput[0]);
      expect(parsed.err).toBe('something broke');
    });

    it('extracts error code from Error objects', () => {
      const logger = createLogger({}, 'error');
      const err = new Error('ENOENT') as Error & { code: string };
      err.code = 'ENOENT';
      logger.error({ err }, 'File not found');

      const parsed = JSON.parse(stderrOutput[0]);
      expect(parsed.err).toBe('ENOENT');
      expect(parsed.errCode).toBe('ENOENT');
    });

    it('flattens plain objects with message', () => {
      const logger = createLogger({}, 'error');
      logger.error({ err: { message: 'custom error', code: 42 } }, 'Failed');

      const parsed = JSON.parse(stderrOutput[0]);
      expect(parsed.err).toBe('custom error');
      expect(parsed.errCode).toBe(42);
    });

    it('flattens objects with reason field', () => {
      const logger = createLogger({}, 'error');
      logger.error({ err: { reason: 'timeout' } }, 'Connection dropped');

      const parsed = JSON.parse(stderrOutput[0]);
      expect(parsed.err).toBe('timeout');
    });

    it('handles string err field', () => {
      const logger = createLogger({}, 'error');
      logger.error({ err: 'raw error string' }, 'Something happened');

      const parsed = JSON.parse(stderrOutput[0]);
      expect(parsed.err).toBe('raw error string');
    });

    it('handles null err field', () => {
      const logger = createLogger({}, 'info');
      logger.info({ err: null }, 'No error');

      const parsed = JSON.parse(stderrOutput[0]);
      expect(parsed.err).toBeNull();
    });
  });

  describe('message-only signature', () => {
    let origTTY: boolean | undefined;

    beforeEach(() => {
      origTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(process.stderr, 'isTTY', { value: origTTY, configurable: true });
    });

    it('supports logger.info("message") without fields', () => {
      const logger = createLogger({}, 'info');
      logger.info('simple message');

      const parsed = JSON.parse(stderrOutput[0]);
      expect(parsed.msg).toBe('simple message');
    });

    it('supports logger.info({ fields }, "message") with fields', () => {
      const logger = createLogger({}, 'info');
      logger.info({ count: 5 }, 'items processed');

      const parsed = JSON.parse(stderrOutput[0]);
      expect(parsed.msg).toBe('items processed');
      expect(parsed.count).toBe(5);
    });
  });
});
