/**
 * InputBuffer — multi-line paste mode state machine (F18).
 *
 * Trigger: type `"""` on a line by itself to open paste mode.
 *          Type `"""` again to close it and flush the block as a single message.
 *
 * Immutable: feed() always returns a new instance. The REPL loop replaces
 * `buffer` with `result.next` each iteration.
 *
 * Usage:
 *   let buffer = new InputBuffer();
 *   const { next, value } = buffer.feed(line);
 *   buffer = next;
 *   if (value !== null) sendToAgent(value);
 */
export class InputBuffer {
  private readonly DELIMITER = '"""';
  private readonly lines: ReadonlyArray<string>;
  private readonly collecting: boolean;

  constructor(lines: ReadonlyArray<string> = [], collecting = false) {
    this.lines = lines;
    this.collecting = collecting;
  }

  /** True while waiting for the closing delimiter. */
  get isCollecting(): boolean {
    return this.collecting;
  }

  /**
   * Feed one line of input.
   *
   * Returns:
   *   value: null   — still collecting; show a continuation prompt.
   *   value: string — complete message ready to send (may be empty string).
   */
  feed(line: string): { next: InputBuffer; value: string | null } {
    const trimmed = line.trim();

    if (!this.collecting) {
      if (trimmed === this.DELIMITER) {
        return { next: new InputBuffer([], true), value: null };
      }
      return { next: new InputBuffer([], false), value: line };
    }

    // Currently collecting.
    if (trimmed === this.DELIMITER) {
      const combined = [...this.lines].join('\n');
      return { next: new InputBuffer([], false), value: combined };
    }

    return { next: new InputBuffer([...this.lines, line], true), value: null };
  }
}
