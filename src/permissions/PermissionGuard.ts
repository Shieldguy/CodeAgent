import * as readline from 'node:readline';

/**
 * The three permission modes, matching the --permission-mode CLI flag values.
 *
 * - "auto"    : All tool calls are allowed without prompting.
 * - "default" : Non-destructive tools run freely. Destructive tools prompt the user.
 * - "deny"    : All destructive tool calls are blocked without prompting.
 */
export type PermissionMode = 'auto' | 'default' | 'deny';

/** Describes how risky a tool call is. */
export type RiskLevel = 'destructive' | 'safe';

/**
 * Tools in this set require user approval in "default" mode
 * and are blocked in "deny" mode.
 */
export const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'bash',
]);

/**
 * PermissionGuard gates destructive tool calls behind user approval.
 *
 * Concurrency model: all calls to check() are serialized through a Promise chain.
 * Each check() appends to the chain and waits for the previous to complete
 * before opening readline. This prevents concurrent prompts from corrupting
 * the terminal output.
 *
 * Mode escalation: in "default" mode, if the user answers "a" (always), the guard
 * upgrades the session to "auto" mode. This is a one-way transition.
 */
export class PermissionGuard {
  /** Current permission mode. May be upgraded from "default" to "auto". */
  private mode: PermissionMode;

  /**
   * The serialization queue.
   * Each call to check() chains onto this promise so only one prompt is active at a time.
   */
  private queue: Promise<void>;

  constructor(mode: PermissionMode) {
    this.mode = mode;
    this.queue = Promise.resolve();
  }

  /** Read-only accessor for the current mode. */
  get currentMode(): PermissionMode {
    return this.mode;
  }

  /** Classify a tool as destructive or safe. */
  riskOf(toolName: string): RiskLevel {
    return DESTRUCTIVE_TOOLS.has(toolName) ? 'destructive' : 'safe';
  }

  /**
   * Check whether a tool call is permitted.
   *
   * Fast paths (not queued):
   *   - Safe tools → always returns true
   *   - "auto" mode → always returns true
   *   - "deny" mode → always returns false
   *
   * "default" mode + destructive → queues a readline prompt.
   *
   * @param toolName - The name of the tool being called (e.g., "bash").
   * @param summary  - One-line description shown to the user.
   * @param diffPreview - Optional diff string displayed before the prompt.
   * @returns Promise<boolean> — true if allowed, false if denied.
   */
  async check(toolName: string, summary: string, diffPreview?: string): Promise<boolean> {
    if (this.riskOf(toolName) === 'safe') {
      return true;
    }
    if (this.mode === 'auto') {
      return true;
    }
    if (this.mode === 'deny') {
      process.stdout.write(`\n[Permission denied (deny mode): ${toolName} — ${summary}]\n`);
      return false;
    }

    // "default" mode with a destructive tool: serialize through the queue.
    let result = false;

    this.queue = this.queue.then(async () => {
      result = await this.promptUser(toolName, summary, diffPreview);
    });

    await this.queue;
    return result;
  }

  /**
   * Open a readline prompt and ask the user to approve or deny a tool call.
   *
   * Answers:
   *   y / yes / <enter>  → allow this call
   *   n / no             → deny this call
   *   a / always         → allow AND upgrade session to "auto" mode
   */
  private async promptUser(
    toolName: string,
    summary: string,
    diffPreview?: string,
  ): Promise<boolean> {
    if (diffPreview !== undefined && diffPreview.length > 0) {
      process.stdout.write(`\n${diffPreview}\n`);
    }

    const question =
      `\nAllow ${toolName}? ${summary}\n` +
      `  [y] yes  [n] no  [a] always (upgrade to auto mode)\n` +
      `> `;

    const answer = await this.ask(question);
    const normalized = answer.trim().toLowerCase();

    if (normalized === 'a' || normalized === 'always') {
      this.mode = 'auto';
      process.stdout.write(`[Permission mode upgraded to "auto" for this session.]\n`);
      return true;
    }

    if (normalized === '' || normalized === 'y' || normalized === 'yes') {
      return true;
    }

    process.stdout.write(`[Denied: ${toolName}]\n`);
    return false;
  }

  /**
   * Open a temporary readline interface to ask a single question.
   * Uses a separate interface from the main REPL to avoid event handler conflicts.
   */
  private ask(question: string): Promise<string> {
    return new Promise<string>((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });

      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }
}
