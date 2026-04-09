# DESIGN_F5 — Permission Guard & Prompt Serialization

> Features: F5 (Permission guard: auto / default / deny), F21 (Serialization)

---

## 1. Purpose & Scope

The Permission Guard is the safety gate between the model's tool call intentions and
the actual execution of destructive operations. It prevents the agent from silently
modifying files or running shell commands without the user's awareness.

| Feature | Description |
|---------|-------------|
| F5 | Three permission modes: auto (allow all), default (prompt for destructive), deny (block all) |
| F21 | Serialized prompt queue: prevents concurrent readline conflicts |

### Analogy

Think of the Permission Guard as a bank teller window with a single service queue. Even
if ten customers arrive at once, they are served one at a time. In CodeAgent, if the model
calls three tools in parallel (which `ConversationController` supports), each destructive
call must wait for the previous prompt to be answered before it can show its own prompt.
Without this queue, three readline prompts would appear simultaneously on the terminal,
causing corrupted output and unreadable questions.

### Non-goals

- This module does not execute tools (that is `ToolDispatcher`'s job).
- It does not render the diff preview (that is `WriteFileTool.buildDiffPreview()`).
- It does not handle non-destructive tool calls (e.g., `read_file` always passes through).

---

## 2. File Structure

```
src/permissions/
  PermissionGuard.ts     # PermissionMode type, RiskLevel, PermissionGuard class
```

The module is intentionally a single file. It is small (under 150 lines) and has one
clear responsibility.

---

## 3. Types and Constants

```typescript
// src/permissions/PermissionGuard.ts

import * as readline from 'node:readline';

/**
 * The three permission modes, matching the --permission-mode CLI flag values.
 *
 * - "auto"    : All tool calls are allowed without prompting. Used for scripting
 *               or when the user has expressed full trust in the session.
 * - "default" : Non-destructive tools run freely. Destructive tools (write, edit, bash)
 *               prompt the user for y/n/a before executing.
 * - "deny"    : All destructive tool calls are blocked without prompting.
 *               Non-destructive tools still run freely.
 */
export type PermissionMode = 'auto' | 'default' | 'deny';

/** Describes how risky a tool call is. */
export type RiskLevel = 'destructive' | 'safe';

/**
 * Tools in this set require user approval in "default" mode
 * and are blocked in "deny" mode.
 *
 * "bash" is included because any shell command can be destructive.
 * Phase 2 adds "edit_file" when EditFileTool is introduced.
 */
export const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'bash',
]);
```

---

## 4. `PermissionGuard` Class

```typescript
// src/permissions/PermissionGuard.ts (continued)

/**
 * PermissionGuard gates destructive tool calls behind user approval.
 *
 * Concurrency model:
 *   All calls to check() are serialized through a Promise chain (this.queue).
 *   Each check() appends to the chain and waits for the previous to complete
 *   before opening readline. This prevents concurrent prompts from corrupting
 *   the terminal output.
 *
 * Mode escalation:
 *   In "default" mode, if the user answers "a" (always), the guard upgrades
 *   the session to "auto" mode for the remainder of the session. This is
 *   a one-way transition — the mode never downgrades during a session.
 */
export class PermissionGuard {
  /** Current permission mode. May be upgraded from "default" to "auto" during the session. */
  private mode: PermissionMode;

  /**
   * The serialization queue.
   * Each call to check() chains onto this promise so that only one prompt
   * is active at a time.
   *
   * Initial value: a resolved promise so the first call starts immediately.
   */
  private queue: Promise<void>;

  constructor(mode: PermissionMode) {
    this.mode = mode;
    this.queue = Promise.resolve();
  }

  /** Read-only accessor for the current mode. Used by tests and /info command. */
  get currentMode(): PermissionMode {
    return this.mode;
  }

  /**
   * Classify a tool as destructive or safe.
   * Safe tools are never gated regardless of the mode.
   */
  riskOf(toolName: string): RiskLevel {
    return DESTRUCTIVE_TOOLS.has(toolName) ? 'destructive' : 'safe';
  }

  /**
   * Check whether a tool call is permitted.
   *
   * - Safe tools → always returns true immediately (not queued).
   * - "auto" mode → always returns true immediately (not queued).
   * - "deny" mode → always returns false immediately (not queued).
   * - "default" mode + destructive → queues a readline prompt.
   *
   * @param toolName - The name of the tool being called (e.g., "bash").
   * @param summary - A one-line description of what the tool will do.
   *                  Shown to the user alongside the y/n/a prompt.
   * @param diffPreview - Optional diff preview string (for write_file / edit_file).
   *                      Displayed before the prompt if provided.
   * @returns Promise<boolean> — true if allowed, false if denied.
   */
  async check(
    toolName: string,
    summary: string,
    diffPreview?: string
  ): Promise<boolean> {
    // Fast paths: skip the queue for decisions that don't need readline.
    if (this.riskOf(toolName) === 'safe') {
      return true;
    }
    if (this.mode === 'auto') {
      return true;
    }
    if (this.mode === 'deny') {
      process.stdout.write(
        `\n[Permission denied (deny mode): ${toolName} — ${summary}]\n`
      );
      return false;
    }

    // "default" mode with a destructive tool: serialize through the queue.
    // This is the only code path that touches readline.
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
   *   a / always         → allow this call AND upgrade session to "auto" mode
   *
   * This method is private because callers should always go through check(),
   * which handles mode routing and queue serialization.
   *
   * Exception: WriteFileTool may call a variant of this method directly (see §7)
   * when it needs to display a diff preview alongside the prompt. In that case,
   * the diff is already shown in `diffPreview` passed to check().
   */
  private async promptUser(
    toolName: string,
    summary: string,
    diffPreview?: string
  ): Promise<boolean> {
    // Show the diff preview if provided (write_file / edit_file).
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
      // One-way upgrade: once in auto mode, stay there for the session.
      this.mode = 'auto';
      process.stdout.write(`[Permission mode upgraded to "auto" for this session.]\n`);
      return true;
    }

    if (normalized === '' || normalized === 'y' || normalized === 'yes') {
      return true;
    }

    // Everything else (n, no, or anything unrecognized) is a denial.
    process.stdout.write(`[Denied: ${toolName}]\n`);
    return false;
  }

  /**
   * Open a temporary readline interface to ask a single question.
   * Closes the interface after receiving one line.
   *
   * Using a temporary interface (not the main REPL's readline) ensures we
   * do not interfere with the REPL's event handlers or prompt state.
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
```

---

## 5. Why Serialization Is Necessary (F21)

The Anthropic API can return multiple `tool_use` blocks in a single assistant message.
`ConversationController` processes these in parallel (via `Promise.all()`) to reduce
latency when tools are independent (e.g., reading three files simultaneously).

Without serialization:

```
Tool A (write_file) → promptUser() opens readline
Tool B (bash)       → promptUser() opens readline (concurrent!)

Terminal output:
  Allow write_file? Write src/main.ts
  Allow bash? rm -rf dist/
  [y] yes  [n] no  [a] always
  > [y] yes  [n] no  [a] always
  > 
  (user can't tell which prompt is which)
```

With the serialization queue:

```
Tool A (write_file) → appends to queue → promptUser() runs
  (user sees prompt A, answers "y")
Tool B (bash)       → appended to queue → waits for A to finish
  (user sees prompt B, answers "n")
```

The queue is a `Promise` chain: each `check()` call does:

```typescript
this.queue = this.queue.then(async () => {
  result = await this.promptUser(...);
});
await this.queue;
```

This means even if ten tool calls arrive simultaneously (which is unrealistic but
theoretically possible), they form an orderly queue. Each `check()` awaits the entire
chain before returning, so the caller correctly waits for its own prompt.

### Why not a Mutex?

A traditional mutex requires a `release()` call and risks deadlock if `release()` is
forgotten. The Promise chain is self-releasing: when the `then()` callback completes,
the next item in the chain automatically starts. It is simpler and impossible to deadlock.

---

## 6. Mode Upgrade ("Always") Behavior

When the user answers `a` or `always`:

1. `this.mode` is set to `'auto'`.
2. A confirmation message is printed.
3. All subsequent `check()` calls hit the `mode === 'auto'` fast path and return `true`
   without queuing a prompt.

This is a **one-way transition**. There is no "undo" within a session. The user can start
a new session with `--permission-mode default` to reset.

The mode upgrade is per-session (in-memory only). It is not persisted to config.

---

## 7. Diff Preview Integration

`WriteFileTool` and `EditFileTool` (Phase 2) need to show a diff before the user approves
the write. The diff is produced by `WriteFileTool.buildDiffPreview()` and passed through
to `PermissionGuard.check()` as the `diffPreview` parameter.

The flow in `ConversationController`:

```typescript
// For destructive file tools:
const tool = dispatcher.getTool(toolName) as WriteFileTool; // or EditFileTool
const diffPreview = await tool.buildDiffPreview(input, workingDir);
const allowed = await guard.check(toolName, `Write to "${input.path}"`, diffPreview);

if (!allowed) {
  return { content: 'Operation denied by user.', isError: false };
}

return dispatcher.dispatch(toolName, input, workingDir);
```

The key design point: `PermissionGuard` does **not** know about file diffs. It receives
a string and prints it before the prompt. This keeps the guard decoupled from file system
operations.

`WriteFileTool.execute()` itself does **not** call `promptUser()` — it only executes the
write. The permission decision is made upstream in `ConversationController` before
`dispatch()` is called.

---

## 8. Test Cases

### 8.1 Mode Routing

| Test | Mode | Tool | Expected return |
|------|------|------|----------------|
| Safe tool, any mode | "default" | "read_file" | true (no prompt) |
| Auto mode, destructive | "auto" | "bash" | true (no prompt) |
| Deny mode, destructive | "deny" | "write_file" | false (no prompt) |
| Default mode, safe | "default" | "glob" | true (no prompt) |
| Default mode, destructive | "default" | "bash" | prompts user |

### 8.2 Prompt Responses

| Test | User input | Expected return | Mode after |
|------|-----------|----------------|-----------|
| Empty enter | `""` | true | "default" |
| "y" | `"y"` | true | "default" |
| "yes" | `"yes"` | true | "default" |
| "n" | `"n"` | false | "default" |
| "no" | `"no"` | false | "default" |
| "a" | `"a"` | true | "auto" |
| "always" | `"always"` | true | "auto" |
| Unrecognized | `"maybe"` | false | "default" |

### 8.3 Serialization

```typescript
// Test: concurrent calls are serialized, not interleaved.

const guard = new PermissionGuard('default');
const order: string[] = [];

// Mock promptUser to record order and return true.
// Inject mock via dependency injection or spy.

const callA = guard.check('bash', 'A').then(() => { order.push('A'); });
const callB = guard.check('write_file', 'B').then(() => { order.push('B'); });
const callC = guard.check('bash', 'C').then(() => { order.push('C'); });

await Promise.all([callA, callB, callC]);

// Expected: order = ['A', 'B', 'C'] — strictly sequential.
// If interleaved: order might be ['A', 'C', 'B'] etc.
assert.deepEqual(order, ['A', 'B', 'C']);
```

### 8.4 Mode Upgrade

```typescript
// Test: after "a" answer, subsequent calls skip the prompt.

const guard = new PermissionGuard('default');
// Mock promptUser to return 'a' on first call.

await guard.check('bash', 'first');
assert.equal(guard.currentMode, 'auto');

// Second call should NOT invoke promptUser.
const promptSpy = /* spy on promptUser */;
await guard.check('write_file', 'second');
assert.equal(promptSpy.callCount, 0);
```

### 8.5 Diff Preview Display

```typescript
// Test: diffPreview is printed before the prompt.

const guard = new PermissionGuard('default');
const printed: string[] = [];
// Intercept process.stdout.write.

await guard.check('write_file', 'Write foo.ts', '--- a/foo.ts\n+++ b/foo.ts\n...');

assert.ok(printed.some((s) => s.includes('--- a/foo.ts')));
// Diff appears before the y/n/a prompt.
```

### 8.6 `riskOf()`

| Test | Tool name | Expected RiskLevel |
|------|-----------|-------------------|
| write_file | "write_file" | "destructive" |
| edit_file | "edit_file" | "destructive" |
| bash | "bash" | "destructive" |
| read_file | "read_file" | "safe" |
| glob | "glob" | "safe" |
| grep | "grep" | "safe" |
| unknown | "unknown_tool" | "safe" |
