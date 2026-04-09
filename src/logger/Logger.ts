import { appendFile, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const MAX_LOG_FILES = 10;

function getLogDir(): string {
  return join(homedir(), '.codeagent', 'logs');
}

/**
 * Session-scoped file logger.
 *
 * - Singleton per process (`Logger.getInstance()`).
 * - Writes NDJSON-style lines to `~/.codeagent/logs/session-<ISO>.log`.
 * - DEBUG/INFO/WARN are suppressed when debug mode is off; ERROR always writes.
 * - Fire-and-forget writes — never blocks the agentic loop.
 * - Rotates on startup: keeps the 10 most recent session files.
 */
export class Logger {
  private static instance: Logger | null = null;

  private readonly enabled: boolean;
  private readonly logPath: string;

  private constructor(enabled: boolean) {
    this.enabled = enabled;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    this.logPath = join(getLogDir(), `session-${ts}.log`);
    this.initLogDir();
  }

  /** Get or create the singleton. Must be called once at startup with the debug flag. */
  static getInstance(enabled = false): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger(enabled);
    }
    return Logger.instance;
  }

  /** Reset the singleton. For test isolation only — do not call in production code. */
  static resetForTest(): void {
    Logger.instance = null;
  }

  log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (!this.enabled && level !== 'ERROR') return;

    const entry = this.formatEntry(level, message, data);
    // Fire-and-forget — ignore write errors to avoid cascading failures.
    appendFile(this.logPath, `${entry}\n`, 'utf-8', () => {
      // Intentionally empty.
    });
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('DEBUG', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('INFO', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('WARN', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('ERROR', message, data);
  }

  /** Path to this session's log file. Used by /info to display log location. */
  getLogPath(): string {
    return this.logPath;
  }

  private formatEntry(level: LogLevel, message: string, data?: Record<string, unknown>): string {
    const ts = new Date().toISOString();
    const levelPadded = level.padEnd(5);
    const dataPart = data ? ` ${JSON.stringify(data)}` : '';
    return `[${ts}] [${levelPadded}] ${message}${dataPart}`;
  }

  private initLogDir(): void {
    try {
      mkdirSync(getLogDir(), { recursive: true, mode: 0o700 });
      this.rotateOldLogs();
    } catch {
      // If log dir creation fails, continue without logging.
    }
  }

  private rotateOldLogs(): void {
    try {
      const files = readdirSync(getLogDir())
        .filter((f) => f.startsWith('session-') && f.endsWith('.log'))
        .sort(); // ISO prefix → lexicographic = chronological; oldest first.

      // Delete oldest files until we are under the limit (accounting for the new file).
      const toDelete = files.slice(0, Math.max(0, files.length - MAX_LOG_FILES + 1));
      for (const file of toDelete) {
        try {
          unlinkSync(join(getLogDir(), file));
        } catch {
          // Ignore individual delete failures.
        }
      }
    } catch {
      // Ignore rotation failures.
    }
  }
}
