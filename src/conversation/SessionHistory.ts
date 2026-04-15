import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';

const DEFAULT_HISTORY_DIR = path.join(os.homedir(), '.codeagent', 'history');
const MAX_RETAINED_SESSIONS = 50;

/**
 * Cumulative statistics for a session.
 * All token counts are sourced from the Anthropic API usage field.
 */
export interface SessionStats {
  /** ISO 8601 timestamp of when the session started. */
  readonly startedAt: string;
  /** ISO 8601 timestamp of when the session ended. Undefined while active. */
  endedAt?: string;
  /** Number of complete user-assistant exchanges. */
  readonly turnCount: number;
  /** Total input tokens billed across all API calls. */
  readonly totalInputTokens: number;
  /** Total output tokens billed across all API calls. */
  readonly totalOutputTokens: number;
  /** Estimated cost in USD. */
  readonly estimatedCostUsd: number;
  /** Ordered agent names used, consecutive duplicates suppressed. */
  readonly agentsUsed: string[];
}

/**
 * The complete serialized form of a single session.
 * Written after every turn for crash recovery, and finalized on clean exit.
 */
export interface SessionRecord {
  /** UUID v4 generated at session creation. Stable across saves. */
  readonly id: string;
  /** ISO 8601 timestamp of when the session was created. */
  readonly startedAt: string;
  /** The Claude model active when last saved. */
  readonly model: string;
  /** The agent name active when last saved. */
  readonly agent: string;
  /** Raw messages[] from ContextManager — compatible with Anthropic SDK MessageParam[]. */
  readonly messages: Anthropic.MessageParam[];
  /** Cumulative usage statistics. */
  readonly stats: SessionStats;
}

/**
 * SessionHistory
 *
 * Manages automatic persistence of conversation sessions.
 *
 * Lifecycle:
 *   1. Constructed at ConversationController startup.
 *   2. init() creates the history directory and runs retention cleanup.
 *   3. save() is called after every handleInput() for crash recovery.
 *   4. finalize() is called on clean exit — sets endedAt timestamp.
 *
 * Writes use atomic rename: write to .tmp then rename to final path.
 * Write errors are caught and logged — persistence failures never interrupt
 * the active conversation.
 */
export class SessionHistory {
  private readonly sessionId: string;
  readonly startedAt: string;
  private readonly filePath: string;
  private readonly historyDir: string;

  constructor(historyDir: string = DEFAULT_HISTORY_DIR) {
    this.historyDir = historyDir;
    this.sessionId = crypto.randomUUID();
    this.startedAt = new Date().toISOString();
    // Keep milliseconds for uniqueness; replace : and . for filesystem safety.
    const fileTimestamp = this.startedAt.replace(/:/g, '-').replace(/\./g, '-');
    this.filePath = path.join(historyDir, `session-${fileTimestamp}.json`);
  }

  /**
   * Initialize the history directory and run retention cleanup.
   * Must be called once before the first save().
   */
  async init(): Promise<void> {
    await fs.mkdir(this.historyDir, { recursive: true });
    await this.cleanup();
  }

  /**
   * Serialize the current session state to disk.
   * Uses atomic rename to prevent partial writes.
   * Errors are caught — they must never interrupt the active conversation.
   */
  async save(
    messages: readonly Anthropic.MessageParam[],
    stats: SessionStats,
    model: string,
    agent: string,
  ): Promise<void> {
    const record: SessionRecord = {
      id: this.sessionId,
      startedAt: this.startedAt,
      model,
      agent,
      messages: messages as Anthropic.MessageParam[],
      stats,
    };

    const tmpPath = `${this.filePath}.tmp`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(record, null, 2), 'utf-8');
      await fs.rename(tmpPath, this.filePath);
    } catch (error) {
      console.warn(`[SessionHistory] Failed to save session: ${String(error)}`);
      await fs.unlink(tmpPath).catch(() => undefined);
    }
  }

  /**
   * Write the final session record with endedAt timestamp.
   * Called on clean exit (Ctrl+D, /exit, /quit).
   */
  async finalize(
    messages: readonly Anthropic.MessageParam[],
    stats: SessionStats,
    model: string,
    agent: string,
  ): Promise<void> {
    const finalStats: SessionStats = { ...stats, endedAt: new Date().toISOString() };
    await this.save(messages, finalStats, model, agent);
  }

  /**
   * Returns the most recent session record, or undefined if none exist.
   * Used by --resume to restore a previous session's messages[].
   */
  static async loadLast(
    historyDir: string = DEFAULT_HISTORY_DIR,
  ): Promise<SessionRecord | undefined> {
    let files: string[];
    try {
      const entries = await fs.readdir(historyDir);
      files = entries
        .filter((f) => f.startsWith('session-') && f.endsWith('.json'))
        .sort()
        .reverse();
    } catch {
      return undefined;
    }

    for (const file of files) {
      try {
        const raw = await fs.readFile(path.join(historyDir, file), 'utf-8');
        return JSON.parse(raw) as SessionRecord;
      } catch {
        continue; // Corrupt file — try the next one
      }
    }

    return undefined;
  }

  /**
   * All session records sorted newest-to-oldest. Corrupt files are skipped.
   */
  static async list(historyDir: string = DEFAULT_HISTORY_DIR): Promise<SessionRecord[]> {
    let files: string[];
    try {
      const entries = await fs.readdir(historyDir);
      files = entries
        .filter((f) => f.startsWith('session-') && f.endsWith('.json'))
        .sort()
        .reverse();
    } catch {
      return [];
    }

    const results: SessionRecord[] = [];
    for (const file of files) {
      try {
        const raw = await fs.readFile(path.join(historyDir, file), 'utf-8');
        results.push(JSON.parse(raw) as SessionRecord);
      } catch {
        continue;
      }
    }
    return results;
  }

  /**
   * Delete oldest session files beyond MAX_RETAINED_SESSIONS.
   * Called once at init(), before the new session's first save.
   */
  private async cleanup(): Promise<void> {
    let files: string[];
    try {
      const entries = await fs.readdir(this.historyDir);
      files = entries
        .filter((f) => f.startsWith('session-') && f.endsWith('.json'))
        .sort(); // ascending = oldest first
    } catch {
      return;
    }

    const excess = files.length - MAX_RETAINED_SESSIONS;
    if (excess <= 0) return;

    for (const file of files.slice(0, excess)) {
      await fs.unlink(path.join(this.historyDir, file)).catch(() => undefined);
    }
  }
}
