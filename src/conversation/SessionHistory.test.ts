import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionHistory, type SessionStats } from './SessionHistory.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-hist-test-'));
}

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    startedAt: new Date().toISOString(),
    turnCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    estimatedCostUsd: 0,
    agentsUsed: ['default'],
    ...overrides,
  };
}

describe('SessionHistory', () => {
  it('saves a valid JSON file and can be loaded back', async () => {
    const dir = makeTempDir();
    try {
      const history = new SessionHistory(dir);
      await history.init();
      await history.save([], makeStats(), 'claude-sonnet-4-6', 'default');

      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      expect(files).toHaveLength(1);

      const raw = fs.readFileSync(path.join(dir, files[0]!), 'utf-8');
      const record = JSON.parse(raw) as { model: string; agent: string };
      expect(record.model).toBe('claude-sonnet-4-6');
      expect(record.agent).toBe('default');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadLast() returns the most recent session', async () => {
    const dir = makeTempDir();
    try {
      const h1 = new SessionHistory(dir);
      await h1.init();
      await h1.save([], makeStats({ turnCount: 1 }), 'model-a', 'default');

      // Small delay so second session has a later timestamp.
      await new Promise((r) => setTimeout(r, 5));

      const h2 = new SessionHistory(dir);
      // No init() needed — dir already exists.
      await h2.save([], makeStats({ turnCount: 2 }), 'model-b', 'default');

      const last = await SessionHistory.loadLast(dir);
      expect(last?.stats.turnCount).toBe(2);
      expect(last?.model).toBe('model-b');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadLast() returns undefined when history directory is empty', async () => {
    const dir = makeTempDir();
    try {
      const result = await SessionHistory.loadLast(dir);
      expect(result).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadLast() returns undefined when history directory does not exist', async () => {
    const result = await SessionHistory.loadLast('/tmp/__nonexistent_hist_dir_12345__');
    expect(result).toBeUndefined();
  });

  it('finalize() writes a record with endedAt set', async () => {
    const dir = makeTempDir();
    try {
      const history = new SessionHistory(dir);
      await history.init();
      await history.finalize([], makeStats(), 'claude-sonnet-4-6', 'default');

      const last = await SessionHistory.loadLast(dir);
      expect(last?.stats.endedAt).toBeDefined();
      expect(typeof last?.stats.endedAt).toBe('string');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('save() does not throw when the directory is not writable', async () => {
    const dir = makeTempDir();
    try {
      const history = new SessionHistory(dir);
      await history.init();
      // Make dir read-only
      fs.chmodSync(dir, 0o444);
      // Should not throw — errors are swallowed
      await expect(
        history.save([], makeStats(), 'model', 'default'),
      ).resolves.toBeUndefined();
    } finally {
      fs.chmodSync(dir, 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses atomic rename — no .tmp file remains after successful save', async () => {
    const dir = makeTempDir();
    try {
      const history = new SessionHistory(dir);
      await history.init();
      await history.save([], makeStats(), 'model', 'default');

      const files = fs.readdirSync(dir);
      expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
      expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('list() returns all sessions newest-first', async () => {
    const dir = makeTempDir();
    try {
      for (let i = 0; i < 3; i++) {
        const h = new SessionHistory(dir);
        await h.save([], makeStats({ turnCount: i }), 'model', 'default');
        await new Promise((r) => setTimeout(r, 5));
      }

      const records = await SessionHistory.list(dir);
      expect(records).toHaveLength(3);
      // Newest first — turnCount 2 should come before 0
      expect(records[0]!.stats.turnCount).toBeGreaterThanOrEqual(
        records[records.length - 1]!.stats.turnCount,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cleanup deletes oldest files beyond 50 sessions', async () => {
    const dir = makeTempDir();
    try {
      // Create 55 fake session files with incrementing timestamps.
      for (let i = 0; i < 55; i++) {
        const timestamp = new Date(Date.now() + i * 1000)
          .toISOString()
          .replace(/:/g, '-')
          .replace(/\.\d{3}Z$/, 'Z');
        fs.writeFileSync(
          path.join(dir, `session-${timestamp}.json`),
          JSON.stringify({ id: `id-${String(i)}` }),
        );
      }

      const history = new SessionHistory(dir);
      await history.init(); // triggers cleanup

      const remaining = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      // cleanup keeps 50, then init creates 0 new files (save hasn't been called)
      expect(remaining.length).toBe(50);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
