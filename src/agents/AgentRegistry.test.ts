import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentRegistry } from './AgentRegistry.js';
import { BUILT_IN_AGENTS } from './built-in/index.js';

function withTempDir(fn: (dir: string) => void | Promise<void>): ReturnType<typeof fn> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-reg-test-'));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  const result = fn(dir);
  if (result instanceof Promise) {
    return result.finally(cleanup) as ReturnType<typeof fn>;
  }
  cleanup();
  return result as ReturnType<typeof fn>;
}

function writeAgent(dir: string, name: string, extraFrontmatter = ''): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} agent${extraFrontmatter}\n---\nYou are ${name}.`,
    'utf-8',
  );
}

describe('AgentRegistry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads all built-in agents when no external directories exist', async () => {
    await withTempDir(async (dir) => {
      const registry = new AgentRegistry();
      await registry.load(dir); // project dir with no .codeagent/agents/

      const names = registry.list().map((a) => a.name);
      for (const builtin of BUILT_IN_AGENTS) {
        expect(names).toContain(builtin.name);
      }
    });
  });

  it('list() returns agents sorted alphabetically', async () => {
    await withTempDir(async (dir) => {
      const registry = new AgentRegistry();
      await registry.load(dir);

      const names = registry.list().map((a) => a.name);
      expect(names).toEqual([...names].sort());
    });
  });

  it('resolve() returns undefined for unknown agent', async () => {
    await withTempDir(async (dir) => {
      const registry = new AgentRegistry();
      await registry.load(dir);
      expect(registry.resolve('no-such-agent')).toBeUndefined();
    });
  });

  it('project-local overrides built-in', async () => {
    await withTempDir(async (dir) => {
      const agentsDir = path.join(dir, '.codeagent', 'agents');
      writeAgent(agentsDir, 'default', '\nmodel: claude-haiku-4-5-20251001');

      const registry = new AgentRegistry();
      await registry.load(dir);

      const def = registry.resolve('default');
      expect(def?.model).toBe('claude-haiku-4-5-20251001');
    });
  });

  it('skips malformed files and logs a warning', async () => {
    await withTempDir(async (dir) => {
      const agentsDir = path.join(dir, '.codeagent', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      // Good file
      writeAgent(agentsDir, 'good-agent');
      // Bad file — missing closing ---
      fs.writeFileSync(path.join(agentsDir, 'bad.md'), '---\nname: bad\nNo closing.');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const registry = new AgentRegistry();
      await registry.load(dir);

      expect(registry.resolve('good-agent')).toBeDefined();
      expect(registry.resolve('bad')).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping'));
    });
  });

  it('load() is idempotent — calling twice does not double-load', async () => {
    await withTempDir(async (dir) => {
      const registry = new AgentRegistry();
      await registry.load(dir);
      const countBefore = registry.list().length;
      await registry.load(dir); // second call — should be a no-op
      expect(registry.list().length).toBe(countBefore);
    });
  });

  it('silently skips non-existent agent directories', async () => {
    await withTempDir(async (dir) => {
      // Pass a cwd that has no .codeagent/agents/ directory at all
      const registry = new AgentRegistry();
      await expect(registry.load(dir)).resolves.toBeUndefined();
    });
  });
});
