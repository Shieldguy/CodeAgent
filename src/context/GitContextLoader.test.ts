import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isGitRepo, loadGitContext } from './GitContextLoader.js';

function withTempDir(fn: (dir: string) => void | Promise<void>): ReturnType<typeof fn> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ctx-test-'));
  try {
    return fn(dir) as ReturnType<typeof fn>;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('isGitRepo()', () => {
  it('returns false for a plain directory', () => {
    withTempDir((dir) => {
      expect(isGitRepo(dir)).toBe(false);
    });
  });

  it('returns true when .git directory exists', () => {
    withTempDir((dir) => {
      fs.mkdirSync(path.join(dir, '.git'));
      expect(isGitRepo(dir)).toBe(true);
    });
  });

  it('returns true for a subdirectory of a git repo', () => {
    withTempDir((dir) => {
      fs.mkdirSync(path.join(dir, '.git'));
      const sub = path.join(dir, 'src', 'components');
      fs.mkdirSync(sub, { recursive: true });
      expect(isGitRepo(sub)).toBe(true);
    });
  });
});

describe('loadGitContext()', () => {
  it('returns null for a non-git directory', async () => {
    await withTempDir(async (dir) => {
      const result = await loadGitContext(dir);
      expect(result).toBeNull();
    });
  });

  it('returns GitContext with string fields for a real git repo', async () => {
    // Integration test — uses the actual CodeAgent repo directory.
    const result = await loadGitContext(process.cwd());
    if (result === null) return; // skip if git not available in this environment
    expect(typeof result.branch).toBe('string');
    expect(typeof result.status).toBe('string');
    expect(typeof result.diffStat).toBe('string');
  });

  it('returns a branch string for the current repo', async () => {
    const result = await loadGitContext(process.cwd());
    if (result === null) return;
    // Should have a non-empty branch (e.g. "main")
    expect(result.branch.length).toBeGreaterThan(0);
  });
});
