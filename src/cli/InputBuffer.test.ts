import { describe, it, expect } from 'vitest';
import { InputBuffer } from './InputBuffer.js';

describe('InputBuffer', () => {
  it('returns the line immediately in normal mode', () => {
    const buf = new InputBuffer();
    const { next, value } = buf.feed('hello');
    expect(value).toBe('hello');
    expect(next.isCollecting).toBe(false);
  });

  it('returns empty string for empty line in normal mode', () => {
    const { value } = new InputBuffer().feed('');
    expect(value).toBe('');
  });

  it('opening delimiter returns null and enters collecting mode', () => {
    const { next, value } = new InputBuffer().feed('"""');
    expect(value).toBeNull();
    expect(next.isCollecting).toBe(true);
  });

  it('lines inside collecting mode return null', () => {
    const { next: collecting } = new InputBuffer().feed('"""');
    const { value } = collecting.feed('some content');
    expect(value).toBeNull();
  });

  it('closing delimiter joins collected lines and exits collecting mode', () => {
    const s1 = new InputBuffer();
    const { next: s2 } = s1.feed('"""');
    const { next: s3 } = s2.feed('line one');
    const { next: s4 } = s3.feed('line two');
    const { next: s5, value } = s4.feed('"""');

    expect(value).toBe('line one\nline two');
    expect(s5.isCollecting).toBe(false);
  });

  it('empty paste block returns empty string', () => {
    const { next: collecting } = new InputBuffer().feed('"""');
    const { value } = collecting.feed('"""');
    expect(value).toBe('');
  });

  it('delimiter is matched after trimming whitespace', () => {
    const { next, value } = new InputBuffer().feed('  """  ');
    expect(value).toBeNull();
    expect(next.isCollecting).toBe(true);
  });

  it('original instance is unchanged after feed (immutability)', () => {
    const original = new InputBuffer();
    original.feed('hello');
    expect(original.isCollecting).toBe(false);
  });

  it('feed always returns a new instance', () => {
    const buf = new InputBuffer();
    const { next } = buf.feed('text');
    expect(next).not.toBe(buf);
  });

  it('multi-step sequence preserves line order', () => {
    let buf = new InputBuffer();
    buf = buf.feed('"""').next;
    buf = buf.feed('alpha').next;
    buf = buf.feed('beta').next;
    buf = buf.feed('gamma').next;
    const { value } = buf.feed('"""');
    expect(value).toBe('alpha\nbeta\ngamma');
  });
});
