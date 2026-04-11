import { describe, it, expect } from 'vitest';
import { capOutput, assertSafePath, MAX_TOOL_OUTPUT_CHARS } from './guards.js';

describe('capOutput()', () => {
  it('returns output unchanged when under the limit', () => {
    const short = 'a'.repeat(100);
    expect(capOutput(short, 'read_file')).toBe(short);
  });

  it('returns output unchanged at exactly the limit', () => {
    const exact = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS);
    expect(capOutput(exact, 'read_file')).toBe(exact);
  });

  it('truncates output and appends a notice when over the limit', () => {
    const over = 'a'.repeat(MAX_TOOL_OUTPUT_CHARS + 1000);
    const result = capOutput(over, 'bash');
    expect(result.length).toBeLessThan(over.length);
    expect(result).toContain('[Output truncated');
    expect(result).toContain('bash');
  });

  it('truncation notice includes the original character count', () => {
    const overBy = 500;
    const over = 'a'.repeat(MAX_TOOL_OUTPUT_CHARS + overBy);
    const result = capOutput(over, 'glob');
    expect(result).toContain((MAX_TOOL_OUTPUT_CHARS + overBy).toLocaleString());
  });
});

describe('assertSafePath()', () => {
  const workingDir = '/app';

  it('passes for a relative path within the working directory', () => {
    expect(() => assertSafePath('src/main.ts', workingDir)).not.toThrow();
  });

  it('passes for an absolute path within the working directory', () => {
    expect(() => assertSafePath('/app/src/main.ts', workingDir)).not.toThrow();
  });

  it('passes for the working directory itself (".")', () => {
    expect(() => assertSafePath('.', workingDir)).not.toThrow();
  });

  it('throws for a dot-dot escape', () => {
    expect(() => assertSafePath('../secret.txt', workingDir)).toThrow('traversal');
  });

  it('throws for a deep dot-dot escape', () => {
    expect(() => assertSafePath('../../etc/passwd', '/app/src')).toThrow('traversal');
  });

  it('throws for a sibling directory with a longer prefix', () => {
    // /app-extra should NOT be considered inside /app
    expect(() => assertSafePath('/app-extra/file.txt', workingDir)).toThrow('traversal');
  });

  it('throws for an absolute path outside the working directory', () => {
    expect(() => assertSafePath('/etc/passwd', workingDir)).toThrow('traversal');
  });
});
