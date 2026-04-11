import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PermissionGuard, DESTRUCTIVE_TOOLS } from './PermissionGuard.js';

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Inject a mock promptUser that captures calls and returns canned answers.
 * Uses private property access to avoid opening real readline.
 */
function mockPrompt(guard: PermissionGuard, answer: string): void {
  // @ts-expect-error - accessing private method for testing
  guard['promptUser'] = vi.fn().mockResolvedValue(answer === 'a' ? true : answer === 'y' || answer === 'yes' || answer === '');
  // Actually we need to mock more carefully — let's mock 'ask' instead
}

/**
 * Create a guard with a mocked `ask()` that returns the given answer.
 */
function makeGuardWithAnswer(mode: 'auto' | 'default' | 'deny', answer: string): PermissionGuard {
  const guard = new PermissionGuard(mode);
  // @ts-expect-error - accessing private method for testing
  guard['ask'] = vi.fn().mockResolvedValue(answer);
  return guard;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('PermissionGuard', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  // ── riskOf() ─────────────────────────────────────────────────────────────────

  describe('riskOf()', () => {
    it.each([...DESTRUCTIVE_TOOLS])('classifies %s as destructive', (toolName) => {
      const guard = new PermissionGuard('default');
      expect(guard.riskOf(toolName)).toBe('destructive');
    });

    it.each(['read_file', 'glob', 'grep', 'unknown_tool'])(
      'classifies %s as safe',
      (toolName) => {
        const guard = new PermissionGuard('default');
        expect(guard.riskOf(toolName)).toBe('safe');
      },
    );
  });

  // ── mode routing ─────────────────────────────────────────────────────────────

  describe('mode routing', () => {
    it('allows safe tools in any mode without prompting', async () => {
      const guard = new PermissionGuard('default');
      // @ts-expect-error - private
      const askSpy = vi.spyOn(guard, 'ask' as never);

      const result = await guard.check('read_file', 'Read a file');
      expect(result).toBe(true);
      expect(askSpy).not.toHaveBeenCalled();
    });

    it('allows destructive tools in auto mode without prompting', async () => {
      const guard = makeGuardWithAnswer('auto', 'n');
      const result = await guard.check('bash', 'Run command');
      expect(result).toBe(true);
      // @ts-expect-error - private
      expect(guard['ask']).not.toHaveBeenCalled();
    });

    it('denies destructive tools in deny mode without prompting', async () => {
      const guard = makeGuardWithAnswer('deny', 'y');
      const result = await guard.check('write_file', 'Write file');
      expect(result).toBe(false);
      // @ts-expect-error - private
      expect(guard['ask']).not.toHaveBeenCalled();
    });

    it('prints a message when denying in deny mode', async () => {
      const guard = new PermissionGuard('deny');
      await guard.check('bash', 'Run rm -rf');
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Permission denied') as string);
    });
  });

  // ── prompt responses ─────────────────────────────────────────────────────────

  describe('prompt responses (default mode)', () => {
    it.each(['', 'y', 'yes', 'Y', 'YES'])(
      'allows when user answers "%s"',
      async (answer) => {
        const guard = makeGuardWithAnswer('default', answer);
        const result = await guard.check('bash', 'summary');
        expect(result).toBe(true);
        expect(guard.currentMode).toBe('default');
      },
    );

    it.each(['n', 'no', 'N', 'maybe', 'nope'])(
      'denies when user answers "%s"',
      async (answer) => {
        const guard = makeGuardWithAnswer('default', answer);
        const result = await guard.check('bash', 'summary');
        expect(result).toBe(false);
        expect(guard.currentMode).toBe('default');
      },
    );

    it('allows and upgrades to auto when user answers "a"', async () => {
      const guard = makeGuardWithAnswer('default', 'a');
      const result = await guard.check('bash', 'summary');
      expect(result).toBe(true);
      expect(guard.currentMode).toBe('auto');
    });

    it('allows and upgrades to auto when user answers "always"', async () => {
      const guard = makeGuardWithAnswer('default', 'always');
      const result = await guard.check('write_file', 'summary');
      expect(result).toBe(true);
      expect(guard.currentMode).toBe('auto');
    });
  });

  // ── mode upgrade ──────────────────────────────────────────────────────────────

  describe('mode upgrade (always)', () => {
    it('skips prompt on subsequent calls after upgrading to auto', async () => {
      const guard = makeGuardWithAnswer('default', 'a');
      await guard.check('bash', 'first call');

      expect(guard.currentMode).toBe('auto');

      // Second call — ask() should NOT be called because mode is now auto.
      // @ts-expect-error - private
      const askSpy = guard['ask'] as ReturnType<typeof vi.fn>;
      askSpy.mockClear();

      await guard.check('write_file', 'second call');
      expect(askSpy).not.toHaveBeenCalled();
    });
  });

  // ── diff preview ──────────────────────────────────────────────────────────────

  describe('diff preview display', () => {
    it('writes the diff to stdout before the prompt', async () => {
      const guard = makeGuardWithAnswer('default', 'n');
      const diff = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new';

      await guard.check('write_file', 'Write foo.ts', diff);

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('--- a/foo.ts') as string);
    });

    it('does not write anything for empty diff preview', async () => {
      const guard = makeGuardWithAnswer('default', 'y');
      stdoutSpy.mockClear();

      await guard.check('write_file', 'Write foo.ts', '');

      // Only the prompt itself should be written, not a blank diff.
      const calls = stdoutSpy.mock.calls.map((c) => String(c[0]));
      expect(calls.some((s) => s === '\n\n')).toBe(false);
    });
  });

  // ── serialization ─────────────────────────────────────────────────────────────

  describe('serialization', () => {
    it('serializes concurrent destructive tool checks (order preserved)', async () => {
      const order: string[] = [];
      let call = 0;
      const guard = new PermissionGuard('default');
      // @ts-expect-error - private
      guard['ask'] = vi.fn().mockImplementation(async () => {
        call++;
        const id = String(call);
        // Simulate async delay so calls overlap.
        await new Promise((r) => setTimeout(r, 10));
        order.push(id);
        return 'y';
      });

      const [a, b, c] = await Promise.all([
        guard.check('bash', 'A'),
        guard.check('write_file', 'B'),
        guard.check('edit_file', 'C'),
      ]);

      expect(a).toBe(true);
      expect(b).toBe(true);
      expect(c).toBe(true);
      // Order must be sequential despite concurrent initiation.
      expect(order).toEqual(['1', '2', '3']);
    });
  });
});
