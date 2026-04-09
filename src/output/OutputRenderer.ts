import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import chalk from 'chalk';

/** Max chars shown inline for tool results before truncation. */
const OUTPUT_CAP = 200;

/**
 * All user-facing terminal output flows through this class.
 *
 * Responsibilities:
 *   - Stream text chunks live (no buffering)
 *   - Render completed markdown as ANSI-colored output
 *   - Format tool call / tool result lines
 *   - Print welcome banner, errors, info messages
 */
export class OutputRenderer {
  private readonly color: boolean;
  private readonly marked: Marked;

  constructor(debug = false, color = true) {
    void debug; // Reserved for future debug-mode output changes.
    this.color = color;
    this.marked = new Marked();
    this.marked.use(
      markedTerminal({
        reflowText: true,
        width: Math.min(process.stdout.columns ?? 100, 120),
      }),
    );
  }

  /**
   * Write a raw text chunk directly to stdout.
   * Called for every text_delta event during streaming — no buffering.
   */
  streamChunk(text: string): void {
    process.stdout.write(text);
  }

  /**
   * Write a newline after streaming completes.
   * Moves the cursor to a fresh line before the next prompt appears.
   */
  flush(): void {
    process.stdout.write('\n');
  }

  /**
   * Render a completed markdown string as ANSI to stdout.
   * Used for non-streamed output (slash command responses, help text).
   */
  print(text: string): void {
    if (!text.trim()) return;
    const rendered = this.color ? (this.marked.parse(text) as string) : text;
    process.stdout.write(rendered);
    if (!rendered.endsWith('\n')) process.stdout.write('\n');
  }

  /**
   * Print a tool invocation line before execution.
   * Format: cyan label + gray JSON preview (first 120 chars).
   */
  printToolCall(name: string, input: Record<string, unknown>): void {
    const label = this.color ? chalk.cyan(`[tool: ${name}]`) : `[tool: ${name}]`;
    const preview = JSON.stringify(input);
    const truncated = preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
    const inputStr = this.color ? chalk.gray(truncated) : truncated;
    process.stdout.write(`${label} ${inputStr}\n`);
  }

  /**
   * Print the result of a tool execution.
   * Success: green ✓ prefix. Error: red ✗ prefix.
   * Content is truncated to OUTPUT_CAP chars for terminal readability.
   */
  printToolResult(content: string, isError: boolean): void {
    const raw = content.length > OUTPUT_CAP ? `${content.slice(0, OUTPUT_CAP - 3)}...` : content;
    // Collapse newlines to keep the line compact.
    const text = raw.replace(/\n/g, ' ');

    if (isError) {
      const prefix = this.color ? chalk.red('✗') : '✗';
      process.stdout.write(`${prefix} ${text}\n`);
    } else {
      const prefix = this.color ? chalk.green('✓') : '✓';
      process.stdout.write(`${prefix} ${text}\n`);
    }
  }

  /**
   * Print the session welcome banner.
   * Called once at REPL startup.
   */
  printWelcome(agentName: string): void {
    const banner = this.color ? chalk.bold.blue('CodeAgent') : 'CodeAgent';
    const agent = this.color ? chalk.cyan(agentName) : agentName;
    process.stdout.write(`\n${banner}  —  active agent: ${agent}\n`);
    process.stdout.write('Type /help for commands, Ctrl+D to exit.\n\n');
  }

  /**
   * Print an error message in bold red to stderr.
   */
  printError(message: string): void {
    const formatted = this.color ? chalk.bold.red(`Error: ${message}`) : `Error: ${message}`;
    process.stderr.write(`${formatted}\n`);
  }

  /**
   * Print a plain informational line (no markdown rendering).
   */
  printInfo(message: string): void {
    const formatted = this.color ? chalk.gray(message) : message;
    process.stdout.write(`${formatted}\n`);
  }
}
