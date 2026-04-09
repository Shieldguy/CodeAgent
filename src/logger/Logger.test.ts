import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from './Logger.js';

// vi.mock is hoisted — intercepts node:fs before Logger imports it.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    appendFile: vi.fn((_path: unknown, _data: unknown, _enc: unknown, cb: unknown) => {
      (cb as (err: null) => void)(null);
    }),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => [] as string[]),
    unlinkSync: vi.fn(),
  };
});

// Import after mock so Logger picks up the mocked fs.
const { appendFile } = await import('node:fs');

describe('Logger', () => {
  beforeEach(() => {
    Logger.resetForTest();
    vi.stubEnv('HOME', '/tmp');
    vi.clearAllMocks();
  });

  afterEach(() => {
    Logger.resetForTest();
    vi.unstubAllEnvs();
  });

  it('does not call appendFile for DEBUG when debug is disabled', () => {
    const logger = Logger.getInstance(false);
    logger.debug('test message');
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('does not call appendFile for INFO when debug is disabled', () => {
    const logger = Logger.getInstance(false);
    logger.info('test message');
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('does not call appendFile for WARN when debug is disabled', () => {
    const logger = Logger.getInstance(false);
    logger.warn('test message');
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('always calls appendFile for ERROR regardless of debug flag', () => {
    const logger = Logger.getInstance(false);
    logger.error('critical failure');
    expect(appendFile).toHaveBeenCalledOnce();
  });

  it('calls appendFile for DEBUG when debug is enabled', () => {
    const logger = Logger.getInstance(true);
    logger.debug('debug message');
    expect(appendFile).toHaveBeenCalledOnce();
  });

  it('log entry contains ISO timestamp', () => {
    const logger = Logger.getInstance(true);
    logger.info('startup');
    const written = vi.mocked(appendFile).mock.calls[0]?.[1] as string;
    expect(written).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('log entry contains padded level label [INFO ]', () => {
    const logger = Logger.getInstance(true);
    logger.info('startup');
    const written = vi.mocked(appendFile).mock.calls[0]?.[1] as string;
    expect(written).toContain('[INFO ]');
  });

  it('log entry contains the message text', () => {
    const logger = Logger.getInstance(true);
    logger.info('startup complete');
    const written = vi.mocked(appendFile).mock.calls[0]?.[1] as string;
    expect(written).toContain('startup complete');
  });

  it('log entry includes JSON-serialised data when provided', () => {
    const logger = Logger.getInstance(true);
    logger.debug('request', { model: 'claude-sonnet-4-6', count: 3 });
    const written = vi.mocked(appendFile).mock.calls[0]?.[1] as string;
    expect(written).toContain('"model":"claude-sonnet-4-6"');
    expect(written).toContain('"count":3');
  });

  it('log entry ends with a newline', () => {
    const logger = Logger.getInstance(true);
    logger.info('test');
    const written = vi.mocked(appendFile).mock.calls[0]?.[1] as string;
    expect(written).toMatch(/\n$/);
  });

  it('returns a log path ending in .log', () => {
    const logger = Logger.getInstance(false);
    expect(logger.getLogPath()).toMatch(/\.log$/);
  });

  it('getInstance returns the same instance on repeated calls', () => {
    const a = Logger.getInstance(false);
    const b = Logger.getInstance(false);
    expect(a).toBe(b);
  });

  it('resetForTest allows creating a fresh instance', () => {
    const a = Logger.getInstance(false);
    Logger.resetForTest();
    const b = Logger.getInstance(true);
    expect(a).not.toBe(b);
  });
});
