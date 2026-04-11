import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReadFileTool } from './ReadFileTool.js';

function makeWorkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-test-'));
}

describe('ReadFileTool', () => {
  let workdir: string;
  let tool: ReadFileTool;

  beforeEach(() => {
    workdir = makeWorkdir();
    tool = new ReadFileTool();
  });

  afterEach(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  it('reads a file and prefixes lines with 1-based numbers', async () => {
    fs.writeFileSync(path.join(workdir, 'hello.ts'), 'line one\nline two\nline three');
    const result = await tool.execute({ path: 'hello.ts' }, workdir);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('1\tline one');
    expect(result.content).toContain('2\tline two');
    expect(result.content).toContain('3\tline three');
  });

  it('reads a specific line range', async () => {
    fs.writeFileSync(path.join(workdir, 'f.ts'), 'a\nb\nc\nd\ne');
    const result = await tool.execute({ path: 'f.ts', start_line: 2, end_line: 4 }, workdir);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('2\tb');
    expect(result.content).toContain('4\td');
    expect(result.content).not.toContain('\ta\n');
    expect(result.content).not.toContain('\te');
  });

  it('includes a range note in the output header', async () => {
    fs.writeFileSync(path.join(workdir, 'f.ts'), 'a\nb\nc');
    const result = await tool.execute({ path: 'f.ts', start_line: 1, end_line: 2 }, workdir);
    expect(result.content).toContain('lines 1');
  });

  it('returns isError=true for a non-existent file', async () => {
    const result = await tool.execute({ path: 'missing.ts' }, workdir);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  it('returns isError=true for path traversal', async () => {
    const result = await tool.execute({ path: '../etc/passwd' }, workdir);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('traversal');
  });

  it('returns isError=true for an out-of-range start_line', async () => {
    fs.writeFileSync(path.join(workdir, 'f.ts'), 'one\ntwo');
    const result = await tool.execute({ path: 'f.ts', start_line: 999 }, workdir);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('out of range');
  });

  it('reads an empty file without error', async () => {
    fs.writeFileSync(path.join(workdir, 'empty.ts'), '');
    const result = await tool.execute({ path: 'empty.ts' }, workdir);
    expect(result.isError).toBe(false);
  });

  it('returns isError=true for invalid parameters', async () => {
    const result = await tool.execute({ path: 123 }, workdir);
    expect(result.isError).toBe(true);
  });
});
