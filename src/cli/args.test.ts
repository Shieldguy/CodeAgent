import { describe, it, expect } from 'vitest';
import { parseArgs } from './args.js';

describe('parseArgs', () => {
  it('returns default values for empty argv', () => {
    const args = parseArgs([]);
    expect(args.debug).toBe(false);
    expect(args.noColor).toBe(false);
    expect(args.apiKey).toBeUndefined();
    expect(args.model).toBeUndefined();
    expect(args.prompt).toBeUndefined();
    expect(args.workingDirectory).toBeUndefined();
  });

  it('parses --api-key', () => {
    expect(parseArgs(['--api-key', 'sk-abc']).apiKey).toBe('sk-abc');
  });

  it('parses --model', () => {
    expect(parseArgs(['--model', 'claude-opus-4-6']).model).toBe('claude-opus-4-6');
  });

  it('parses --permission-mode', () => {
    expect(parseArgs(['--permission-mode', 'auto']).permissionMode).toBe('auto');
  });

  it('throws on invalid --permission-mode value', () => {
    expect(() => parseArgs(['--permission-mode', 'yolo'])).toThrow();
  });

  it('parses --prompt', () => {
    expect(parseArgs(['--prompt', 'hello world']).prompt).toBe('hello world');
  });

  it('parses -p as short form of --prompt', () => {
    expect(parseArgs(['-p', 'hello']).prompt).toBe('hello');
  });

  it('parses --debug', () => {
    expect(parseArgs(['--debug']).debug).toBe(true);
  });

  it('parses --no-color', () => {
    expect(parseArgs(['--no-color']).noColor).toBe(true);
  });

  it('parses --cwd into workingDirectory', () => {
    expect(parseArgs(['--cwd', '/tmp/project']).workingDirectory).toBe('/tmp/project');
  });

  it('parses --agent', () => {
    expect(parseArgs(['--agent', 'code-reviewer']).agent).toBe('code-reviewer');
  });

  it('treats first bare positional as prompt shortcut', () => {
    expect(parseArgs(['explain this']).prompt).toBe('explain this');
  });

  it('throws on second bare positional', () => {
    expect(() => parseArgs(['first', 'second'])).toThrow('Unexpected argument');
  });

  it('throws on unknown flag', () => {
    expect(() => parseArgs(['--unknown-flag'])).toThrow('Unknown flag');
  });

  it('parses multiple flags together', () => {
    const args = parseArgs([
      '--model', 'claude-sonnet-4-6',
      '--debug',
      '--no-color',
      '--cwd', '/project',
      '--agent', 'default',
    ]);
    expect(args.model).toBe('claude-sonnet-4-6');
    expect(args.debug).toBe(true);
    expect(args.noColor).toBe(true);
    expect(args.workingDirectory).toBe('/project');
    expect(args.agent).toBe('default');
  });
});
