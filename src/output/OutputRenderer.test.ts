import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OutputRenderer } from './OutputRenderer.js';

describe('OutputRenderer', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── streamChunk ─────────────────────────────────────────────────────────────

  it('streamChunk writes text directly to stdout without adding a newline', () => {
    const r = new OutputRenderer(false, false);
    r.streamChunk('hello');
    expect(stdoutSpy).toHaveBeenCalledWith('hello');
    // Ensure no extra newline call was made for the chunk itself.
    const calls = stdoutSpy.mock.calls.map((c) => c[0] as string);
    expect(calls).toEqual(['hello']);
  });

  it('flush writes a single newline to stdout', () => {
    const r = new OutputRenderer(false, false);
    r.flush();
    expect(stdoutSpy).toHaveBeenCalledWith('\n');
  });

  // ── print ───────────────────────────────────────────────────────────────────

  it('print skips blank/whitespace-only strings', () => {
    const r = new OutputRenderer(false, false);
    r.print('   ');
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('print outputs text when color is disabled (no ANSI codes)', () => {
    const r = new OutputRenderer(false, false);
    r.print('plain text');
    const written = stdoutSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(written).toContain('plain text');
  });

  it('print appends newline if rendered text does not end with one', () => {
    const r = new OutputRenderer(false, false);
    r.print('no newline at end');
    const calls = stdoutSpy.mock.calls.map((c) => c[0] as string);
    const last = calls.at(-1);
    expect(last).toBe('\n');
  });

  // ── printToolCall ────────────────────────────────────────────────────────────

  it('printToolCall writes tool name and input preview to stdout', () => {
    const r = new OutputRenderer(false, false);
    r.printToolCall('read_file', { path: 'src/main.ts' });
    const written = stdoutSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(written).toContain('read_file');
    expect(written).toContain('src/main.ts');
  });

  it('printToolCall truncates input preview beyond 120 chars', () => {
    const r = new OutputRenderer(false, false);
    const bigInput = { data: 'x'.repeat(200) };
    r.printToolCall('tool', bigInput);
    const written = stdoutSpy.mock.calls.map((c) => c[0] as string).join('');
    // The preview portion should not be longer than ~130 chars (120 + label/spaces).
    const previewPart = written.split(']')[1] ?? '';
    expect(previewPart.trim().length).toBeLessThanOrEqual(125);
  });

  // ── printToolResult ──────────────────────────────────────────────────────────

  it('printToolResult writes success prefix for non-error result', () => {
    const r = new OutputRenderer(false, false);
    r.printToolResult('file contents here', false);
    const written = stdoutSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(written).toContain('✓');
  });

  it('printToolResult writes error prefix for error result', () => {
    const r = new OutputRenderer(false, false);
    r.printToolResult('command not found', true);
    const written = stdoutSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(written).toContain('✗');
  });

  it('printToolResult truncates content beyond 200 chars', () => {
    const r = new OutputRenderer(false, false);
    const longContent = 'x'.repeat(300);
    r.printToolResult(longContent, false);
    const written = stdoutSpy.mock.calls.map((c) => c[0] as string).join('');
    // Full output = prefix (✓ ) + truncated content (≤200) + newline
    expect(written.length).toBeLessThanOrEqual(210);
  });

  it('printToolResult collapses newlines in content', () => {
    const r = new OutputRenderer(false, false);
    r.printToolResult('line1\nline2\nline3', false);
    const written = stdoutSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(written).not.toContain('\nline2');
    expect(written).toContain('line1 line2');
  });

  // ── printWelcome ─────────────────────────────────────────────────────────────

  it('printWelcome writes CodeAgent banner and agent name', () => {
    const r = new OutputRenderer(false, false);
    r.printWelcome('default');
    const written = stdoutSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(written).toContain('CodeAgent');
    expect(written).toContain('default');
  });

  // ── printError ───────────────────────────────────────────────────────────────

  it('printError writes to stderr not stdout', () => {
    const r = new OutputRenderer(false, false);
    r.printError('something went wrong');
    expect(stderrSpy).toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('printError includes the message text', () => {
    const r = new OutputRenderer(false, false);
    r.printError('disk full');
    const written = stderrSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(written).toContain('disk full');
  });

  // ── printInfo ────────────────────────────────────────────────────────────────

  it('printInfo writes to stdout', () => {
    const r = new OutputRenderer(false, false);
    r.printInfo('session started');
    const written = stdoutSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(written).toContain('session started');
  });
});
