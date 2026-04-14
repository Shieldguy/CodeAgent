import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadProjectContext, loadProjectContextSync } from './ProjectContextLoader.js';

function withTempDir(fn: (dir: string) => void | Promise<void>): ReturnType<typeof fn> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ctx-test-'));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  const result = fn(dir);
  if (result instanceof Promise) {
    return result.finally(cleanup) as ReturnType<typeof fn>;
  }
  cleanup();
  return result as ReturnType<typeof fn>;
}

describe('loadProjectContext (async)', () => {
  it('returns empty content when CLAUDE.md does not exist', async () => {
    await withTempDir(async (dir) => {
      const result = await loadProjectContext(dir);
      expect(result.found).toBe(false);
      expect(result.content).toBe('');
      expect(result.truncated).toBe(false);
    });
  });

  it('returns file content when CLAUDE.md exists', async () => {
    await withTempDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Hello\nWorld');
      const result = await loadProjectContext(dir);
      expect(result.found).toBe(true);
      expect(result.content).toBe('# Hello\nWorld');
      expect(result.truncated).toBe(false);
    });
  });

  it('truncates content exceeding 20,000 characters', async () => {
    await withTempDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'x'.repeat(25_000));
      const result = await loadProjectContext(dir);
      expect(result.found).toBe(true);
      expect(result.truncated).toBe(true);
      expect(result.content.length).toBeLessThan(25_000);
      expect(result.content).toContain('[CLAUDE.md truncated');
    });
  });

  it('includes full content when exactly at 20,000 chars', async () => {
    await withTempDir(async (dir) => {
      const exact = 'a'.repeat(20_000);
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), exact);
      const result = await loadProjectContext(dir);
      expect(result.truncated).toBe(false);
      expect(result.content).toBe(exact);
    });
  });

  it('returns empty content when file is unreadable', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'CLAUDE.md');
      fs.writeFileSync(filePath, 'secret');
      fs.chmodSync(filePath, 0o000); // make unreadable
      const result = await loadProjectContext(dir);
      expect(result.found).toBe(false);
      expect(result.content).toBe('');
      fs.chmodSync(filePath, 0o644); // restore so cleanup can delete the file
    });
  });
});

describe('loadProjectContextSync', () => {
  it('returns empty content when CLAUDE.md does not exist', () => {
    withTempDir((dir) => {
      const result = loadProjectContextSync(dir);
      expect(result.found).toBe(false);
      expect(result.content).toBe('');
    });
  });

  it('returns file content when CLAUDE.md exists', () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Project');
      const result = loadProjectContextSync(dir);
      expect(result.found).toBe(true);
      expect(result.content).toBe('# Project');
    });
  });

  it('truncates and marks truncated for oversized content', () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'y'.repeat(21_000));
      const result = loadProjectContextSync(dir);
      expect(result.truncated).toBe(true);
      expect(result.content).toContain('[CLAUDE.md truncated');
    });
  });
});
