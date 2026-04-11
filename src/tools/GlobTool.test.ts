import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GlobTool } from './GlobTool.js';

function makeWorkdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-glob-'));
  // Create a known file structure.
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'main.ts'), '');
  fs.writeFileSync(path.join(dir, 'src', 'util.ts'), '');
  fs.writeFileSync(path.join(dir, 'src', 'main.test.ts'), '');
  fs.writeFileSync(path.join(dir, 'README.md'), '');
  return dir;
}

describe('GlobTool', () => {
  let workdir: string;
  let tool: GlobTool;

  beforeEach(() => {
    workdir = makeWorkdir();
    tool = new GlobTool();
  });

  afterEach(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  it('returns matching files sorted lexicographically', async () => {
    const result = await tool.execute({ pattern: '**/*.ts' }, workdir);
    expect(result.isError).toBe(false);
    const files = result.content.split('\n');
    expect(files).toContain('src/main.ts');
    expect(files).toContain('src/util.ts');
    // Sorted
    expect(files).toEqual([...files].sort());
  });

  it('returns a no-match message when pattern has no results', async () => {
    const result = await tool.execute({ pattern: '**/*.nonexistent' }, workdir);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('No files matched');
  });

  it('filters to the specified subdirectory', async () => {
    const result = await tool.execute({ pattern: '*.ts', path: 'src' }, workdir);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('main.ts');
    expect(result.content).not.toContain('README');
  });

  it('returns isError=true for path traversal in path parameter', async () => {
    const result = await tool.execute({ pattern: '*.ts', path: '../../etc' }, workdir);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('traversal');
  });

  it('returns isError=true for missing required parameter', async () => {
    const result = await tool.execute({}, workdir);
    expect(result.isError).toBe(true);
  });
});
