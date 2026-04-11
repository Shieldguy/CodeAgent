import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WriteFileTool } from './WriteFileTool.js';

function makeWorkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-test-'));
}

describe('WriteFileTool', () => {
  let workdir: string;
  let tool: WriteFileTool;

  beforeEach(() => {
    workdir = makeWorkdir();
    tool = new WriteFileTool();
  });

  afterEach(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  it('creates a new file with the given content', async () => {
    const result = await tool.execute({ path: 'new.ts', content: 'hello' }, workdir);
    expect(result.isError).toBe(false);
    expect(fs.readFileSync(path.join(workdir, 'new.ts'), 'utf8')).toBe('hello');
  });

  it('overwrites an existing file', async () => {
    fs.writeFileSync(path.join(workdir, 'existing.ts'), 'old content');
    await tool.execute({ path: 'existing.ts', content: 'new content' }, workdir);
    expect(fs.readFileSync(path.join(workdir, 'existing.ts'), 'utf8')).toBe('new content');
  });

  it('creates parent directories as needed', async () => {
    const result = await tool.execute(
      { path: 'nested/deep/file.ts', content: 'data' },
      workdir,
    );
    expect(result.isError).toBe(false);
    expect(
      fs.existsSync(path.join(workdir, 'nested', 'deep', 'file.ts')),
    ).toBe(true);
  });

  it('returns the line count in the success message', async () => {
    const result = await tool.execute(
      { path: 'f.ts', content: 'line1\nline2\nline3' },
      workdir,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('3 lines');
  });

  it('returns isError=true for path traversal', async () => {
    const result = await tool.execute({ path: '../escape.ts', content: 'x' }, workdir);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('traversal');
  });

  it('returns isError=true for invalid parameters', async () => {
    const result = await tool.execute({ path: '' }, workdir);
    expect(result.isError).toBe(true);
  });

  describe('buildDiffPreview()', () => {
    it('returns a diff when the file exists', async () => {
      fs.writeFileSync(path.join(workdir, 'f.ts'), 'old line\n');
      const diff = await tool.buildDiffPreview(
        { path: 'f.ts', content: 'new line\n' },
        workdir,
      );
      expect(diff).toContain('-old line');
      expect(diff).toContain('+new line');
    });

    it('shows all additions when the file does not exist', async () => {
      const diff = await tool.buildDiffPreview(
        { path: 'brand-new.ts', content: 'const x = 1;\n' },
        workdir,
      );
      expect(diff).toContain('+const x = 1;');
    });

    it('returns empty string for invalid params', async () => {
      const diff = await tool.buildDiffPreview({ path: '' }, workdir);
      expect(diff).toBe('');
    });
  });
});
