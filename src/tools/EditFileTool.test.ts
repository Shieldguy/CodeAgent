import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EditFileTool } from './EditFileTool.js';

function makeWorkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-edit-'));
}

describe('EditFileTool', () => {
  let workdir: string;
  let tool: EditFileTool;

  beforeEach(() => {
    workdir = makeWorkdir();
    tool = new EditFileTool();
  });

  afterEach(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  it('replaces a unique occurrence of old_string', async () => {
    fs.writeFileSync(path.join(workdir, 'f.ts'), 'const x = 1;\nconst y = 2;\n');
    const result = await tool.execute(
      { file_path: 'f.ts', old_string: 'const x = 1;', new_string: 'const x = 99;' },
      workdir,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Replaced 1 occurrence');
    expect(fs.readFileSync(path.join(workdir, 'f.ts'), 'utf8')).toContain('const x = 99;');
  });

  it('returns isError=true when old_string is not found', async () => {
    fs.writeFileSync(path.join(workdir, 'f.ts'), 'hello world');
    const result = await tool.execute(
      { file_path: 'f.ts', old_string: 'DOES_NOT_EXIST', new_string: 'x' },
      workdir,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('String not found');
  });

  it('returns isError=true when old_string appears multiple times and replace_all is false', async () => {
    fs.writeFileSync(path.join(workdir, 'f.ts'), 'foo\nfoo\nfoo\n');
    const result = await tool.execute(
      { file_path: 'f.ts', old_string: 'foo', new_string: 'bar', replace_all: false },
      workdir,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('3 times');
  });

  it('replaces all occurrences when replace_all is true', async () => {
    fs.writeFileSync(path.join(workdir, 'f.ts'), 'foo\nfoo\nfoo\n');
    const result = await tool.execute(
      { file_path: 'f.ts', old_string: 'foo', new_string: 'bar', replace_all: true },
      workdir,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Replaced 3 occurrences');
    expect(fs.readFileSync(path.join(workdir, 'f.ts'), 'utf8')).toBe('bar\nbar\nbar\n');
  });

  it('returns isError=true for file not found', async () => {
    const result = await tool.execute(
      { file_path: 'missing.ts', old_string: 'x', new_string: 'y' },
      workdir,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  it('returns isError=true for path traversal', async () => {
    const result = await tool.execute(
      { file_path: '../../etc/passwd', old_string: 'root', new_string: 'hacked' },
      workdir,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('traversal');
  });

  it('returns no-op message when old_string and new_string produce identical content', async () => {
    fs.writeFileSync(path.join(workdir, 'f.ts'), 'hello world');
    const result = await tool.execute(
      { file_path: 'f.ts', old_string: 'hello', new_string: 'hello' },
      workdir,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('No changes made');
  });

  it('returns isError=true for invalid parameters', async () => {
    const result = await tool.execute({ file_path: '' }, workdir);
    expect(result.isError).toBe(true);
  });

  describe('buildDiffPreview()', () => {
    it('returns a unified diff showing the change', async () => {
      fs.writeFileSync(path.join(workdir, 'f.ts'), 'const x = 1;\n');
      const diff = await tool.buildDiffPreview(
        { file_path: 'f.ts', old_string: 'const x = 1;', new_string: 'const x = 99;' },
        workdir,
      );
      expect(diff).toContain('-const x = 1;');
      expect(diff).toContain('+const x = 99;');
    });

    it('returns empty string when file does not exist', async () => {
      const diff = await tool.buildDiffPreview(
        { file_path: 'missing.ts', old_string: 'x', new_string: 'y' },
        workdir,
      );
      expect(diff).toBe('');
    });

    it('returns empty string for invalid params', async () => {
      const diff = await tool.buildDiffPreview({ file_path: '' }, workdir);
      expect(diff).toBe('');
    });
  });
});
