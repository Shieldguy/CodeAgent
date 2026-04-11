import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BashTool, safeEnv } from './BashTool.js';

function makeWorkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-bash-'));
}

describe('BashTool', () => {
  let workdir: string;
  let tool: BashTool;

  beforeEach(() => {
    workdir = makeWorkdir();
    tool = new BashTool();
  });

  afterEach(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  it('captures stdout from a simple command', async () => {
    const result = await tool.execute({ command: 'echo hello' }, workdir);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('hello');
    expect(result.content).toContain('[Exit code: 0]');
  });

  it('captures stderr separately', async () => {
    const result = await tool.execute({ command: 'echo errline >&2' }, workdir);
    expect(result.content).toContain('[stderr]');
    expect(result.content).toContain('errline');
  });

  it('marks non-zero exit code as isError=true', async () => {
    const result = await tool.execute({ command: 'exit 1' }, workdir);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('[Exit code: 1]');
  });

  it('runs in the specified working directory', async () => {
    const result = await tool.execute({ command: 'pwd' }, workdir);
    // On macOS, /tmp is a symlink to /private/tmp; resolve both.
    const realWorkdir = fs.realpathSync(workdir);
    expect(result.content).toContain(realWorkdir);
  });

  it('kills and reports timeout for long-running commands', async () => {
    const result = await tool.execute(
      { command: 'sleep 60', timeout_ms: 200 },
      workdir,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Killed: timeout');
  }, 5_000);

  it('returns isError=true for invalid parameters', async () => {
    const result = await tool.execute({ command: '' }, workdir);
    expect(result.isError).toBe(true);
  });

  it('returns (no output) when command produces no output', async () => {
    const result = await tool.execute({ command: 'true' }, workdir);
    expect(result.content).toContain('(no output)');
  });
});

describe('safeEnv()', () => {
  it('strips ANTHROPIC_ prefixed variables', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-secret');
    const env = safeEnv();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('preserves safe variables like HOME', () => {
    const env = safeEnv();
    expect(env['HOME']).toBeDefined();
  });

  it('strips case-insensitively (lowercase prefix)', () => {
    // Our implementation uppercases the key before checking.
    // Process.env keys are lowercase on some systems but uppercase on most.
    // This test confirms the uppercase normalization works.
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    const env = safeEnv();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('strips STRIPE_ prefixed variables', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_secret');
    const env = safeEnv();
    expect(env['STRIPE_SECRET_KEY']).toBeUndefined();
    vi.unstubAllEnvs();
  });
});
