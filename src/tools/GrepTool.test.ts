import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GrepTool } from './GrepTool.js';

function makeWorkdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-grep-'));
  fs.writeFileSync(
    path.join(dir, 'app.ts'),
    'const apiKey = process.env.API_KEY\nconst host = "localhost"\nexport { apiKey }',
  );
  fs.writeFileSync(
    path.join(dir, 'util.ts'),
    'export function helper() {}\nexport const API_KEY = "test"',
  );
  return dir;
}

describe('GrepTool', () => {
  let workdir: string;
  let tool: GrepTool;

  beforeEach(() => {
    workdir = makeWorkdir();
    tool = new GrepTool();
  });

  afterEach(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  it('finds lines matching a regex pattern (content mode)', async () => {
    const result = await tool.execute({ pattern: 'apiKey' }, workdir);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('apiKey');
  });

  it('returns no-match message when pattern is not found', async () => {
    const result = await tool.execute(
      { pattern: 'THIS_CANNOT_MATCH_ANYTHING_ABCXYZ123' },
      workdir,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe('No matches found.');
  });

  it('returns files_with_matches mode output (file paths only)', async () => {
    const result = await tool.execute(
      { pattern: 'API_KEY', output_mode: 'files_with_matches' },
      workdir,
    );
    expect(result.isError).toBe(false);
    // Should contain file paths, not line content.
    expect(result.content.split('\n').every((l) => !l.includes('process.env'))).toBe(true);
  });

  it('is case-insensitive when case_insensitive is true', async () => {
    const result = await tool.execute(
      { pattern: 'apikey', case_insensitive: true },
      workdir,
    );
    expect(result.isError).toBe(false);
    expect(result.content).not.toBe('No matches found.');
  });

  it('returns isError=true for path traversal', async () => {
    const result = await tool.execute(
      { pattern: 'x', path: '../../etc' },
      workdir,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('traversal');
  });

  it('returns isError=true for missing required parameter', async () => {
    const result = await tool.execute({}, workdir);
    expect(result.isError).toBe(true);
  });
});
