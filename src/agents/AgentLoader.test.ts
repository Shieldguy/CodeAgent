import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseFrontmatter, fromFile } from './AgentLoader.js';

// ── parseFrontmatter ──────────────────────────────────────────────────────────

describe('parseFrontmatter()', () => {
  it('parses scalar fields and body', () => {
    const raw = '---\nname: foo\ndescription: Bar\n---\nBody text.';
    const result = parseFrontmatter(raw);
    expect(result.frontmatter['name']).toBe('foo');
    expect(result.frontmatter['description']).toBe('Bar');
    expect(result.body).toBe('Body text.');
  });

  it('strips surrounding quotes from scalar values', () => {
    const raw = '---\nname: "my-agent"\ndescription: \'A description\'\n---\nBody.';
    const result = parseFrontmatter(raw);
    expect(result.frontmatter['name']).toBe('my-agent');
    expect(result.frontmatter['description']).toBe('A description');
  });

  it('parses a YAML list into a string array', () => {
    const raw = '---\ntools:\n  - read_file\n  - glob\n---\nBody.';
    const result = parseFrontmatter(raw);
    expect(result.frontmatter['tools']).toEqual(['read_file', 'glob']);
  });

  it('trims the body and ignores leading newline after closing ---', () => {
    const raw = '---\nname: x\n---\n\n  Hello world  ';
    const result = parseFrontmatter(raw);
    expect(result.body).toBe('Hello world');
  });

  it('handles empty body', () => {
    const raw = '---\nname: x\n---\n';
    const result = parseFrontmatter(raw);
    expect(result.body).toBe('');
  });

  it('throws when file does not start with ---', () => {
    expect(() => parseFrontmatter('name: foo\n---\nBody.')).toThrow('must start with "---"');
  });

  it('throws when closing --- is missing', () => {
    expect(() => parseFrontmatter('---\nname: foo\nBody.')).toThrow('no closing "---"');
  });

  it('skips comment lines in frontmatter', () => {
    const raw = '---\n# comment\nname: ok\n---\nBody.';
    const result = parseFrontmatter(raw);
    expect(result.frontmatter['name']).toBe('ok');
  });

  it('skips blank lines in frontmatter', () => {
    const raw = '---\n\nname: blank-skipped\n\n---\nBody.';
    const result = parseFrontmatter(raw);
    expect(result.frontmatter['name']).toBe('blank-skipped');
  });
});

// ── fromFile ──────────────────────────────────────────────────────────────────

function writeTempAgent(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
  const filePath = path.join(dir, 'test.md');
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('fromFile()', () => {
  it('loads a valid agent definition', async () => {
    const filePath = writeTempAgent(
      '---\nname: test-agent\ndescription: A test agent\n---\nYou are a test.',
    );
    const def = await fromFile(filePath);
    expect(def.name).toBe('test-agent');
    expect(def.description).toBe('A test agent');
    expect(def.systemPrompt).toBe('You are a test.');
    expect(def.model).toBeUndefined();
    expect(def.tools).toBeUndefined();
  });

  it('loads optional model and tools', async () => {
    const filePath = writeTempAgent(
      '---\nname: r\ndescription: Reviewer\nmodel: claude-opus-4-6\ntools:\n  - read_file\n  - glob\n---\nRead only.',
    );
    const def = await fromFile(filePath);
    expect(def.model).toBe('claude-opus-4-6');
    expect(def.tools).toEqual(['read_file', 'glob']);
  });

  it('throws when file does not exist', async () => {
    await expect(fromFile('/nonexistent/path/agent.md')).rejects.toThrow(
      'Failed to read agent definition file',
    );
  });

  it('throws when frontmatter is missing closing ---', async () => {
    const filePath = writeTempAgent('---\nname: broken\nNo closing delimiter.');
    await expect(fromFile(filePath)).rejects.toThrow('Malformed frontmatter');
  });

  it('throws on invalid name (not kebab-case)', async () => {
    const filePath = writeTempAgent(
      '---\nname: My Agent\ndescription: Bad name\n---\nBody.',
    );
    await expect(fromFile(filePath)).rejects.toThrow('Invalid agent definition');
  });

  it('throws when systemPrompt (body) is empty', async () => {
    const filePath = writeTempAgent('---\nname: empty-body\ndescription: No body\n---\n');
    await expect(fromFile(filePath)).rejects.toThrow('Invalid agent definition');
  });
});
