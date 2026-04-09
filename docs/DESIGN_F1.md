# DESIGN_F1 — CLI Entrypoint, Interactive REPL, Headless Mode, Multi-line Input

> Features: F1 (Interactive REPL), F13 (Headless/Piped mode), F18 (Multi-line input)

---

## 1. Purpose & Scope

This document covers the CLI layer of CodeAgent: the entrypoint that wires together every
downstream module and exposes the agent to the user as an interactive terminal session.

The three features share one concern — **how the user sends text to the agent** — so they
are implemented together in a small, cohesive module:

| Feature | Description |
|---------|-------------|
| F1 | Persistent readline REPL: runs until Ctrl+D or `/exit` |
| F13 | Headless/piped mode: single prompt in, single response out, then exit |
| F18 | Multi-line paste mode: `"""` delimiter collects a block before sending |

### Non-goals

- This module does **not** parse or execute slash commands (see `DESIGN_F8.md`).
- It does **not** render markdown (see `src/output/OutputRenderer.ts`).
- It does **not** implement the agentic loop (see `src/conversation/ConversationController.ts`).

---

## 2. File Structure

```
src/cli/
  index.ts        # main() — top-level bootstrap and REPL loop
  args.ts         # parseArgs() — CLI argument parsing and validation
  InputBuffer.ts  # InputBuffer — multi-line paste mode state machine
```

All three files are small and focused. The total combined line count should stay under 400.

---

## 3. `src/cli/args.ts` — Argument Parsing

### 3.1 CliArgs Interface

```typescript
// src/cli/args.ts

export interface CliArgs {
  /** API key override. Falls back to ANTHROPIC_API_KEY env var. */
  apiKey: string | undefined;
  /** Model override (e.g. "claude-sonnet-4-6"). Falls back to config or built-in default. */
  model: string | undefined;
  /** Permission mode override. Default: "default". */
  permissionMode: 'auto' | 'default' | 'deny' | undefined;
  /** Agent name to activate at startup. Default: "default". */
  agent: string | undefined;
  /** Headless prompt: if set, run this prompt once then exit. Enables F13. */
  prompt: string | undefined;
  /** Enable verbose debug logging to file. */
  debug: boolean;
  /** Disable ANSI color output. */
  noColor: boolean;
  /** Working directory override. Default: process.cwd(). */
  workingDirectory: string | undefined;
}
```

### 3.2 `parseArgs()` Implementation

```typescript
// src/cli/args.ts (continued)

import { z } from 'zod';

const PERMISSION_MODES = ['auto', 'default', 'deny'] as const;

const RawArgsSchema = z.object({
  apiKey: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  agent: z.string().optional(),
  prompt: z.string().optional(),
  debug: z.boolean(),
  noColor: z.boolean(),
  workingDirectory: z.string().optional(),
});

/**
 * Parses process.argv into a validated CliArgs object.
 * Throws with a user-friendly message on invalid input.
 *
 * Supported flags:
 *   --api-key <key>
 *   --model <name>
 *   --permission-mode auto|default|deny
 *   --agent <name>
 *   --prompt <text>   (or -p <text>)
 *   --debug
 *   --no-color
 *   --cwd <path>           (stored as workingDirectory in CliArgs)
 *   --version | -v         (prints version and exits)
 */
export function parseArgs(argv: string[] = process.argv.slice(2)): CliArgs {
  const raw: Record<string, unknown> = {
    debug: false,
    noColor: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case '--api-key':
        raw['apiKey'] = argv[++i];
        break;
      case '--model':
        raw['model'] = argv[++i];
        break;
      case '--permission-mode':
        raw['permissionMode'] = argv[++i];
        break;
      case '--agent':
        raw['agent'] = argv[++i];
        break;
      case '--prompt':
      case '-p':
        raw['prompt'] = argv[++i];
        break;
      case '--debug':
        raw['debug'] = true;
        break;
      case '--no-color':
        raw['noColor'] = true;
        break;
      case '--cwd':
        raw['workingDirectory'] = argv[++i];
        break;
      case '--version':
      case '-v': {
        // Read version from package.json at runtime to avoid hardcoding.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { version } = require('../../package.json') as { version: string };
        process.stdout.write(`codeagent ${version}\n`);
        process.exit(0);
        break;
      }
      default:
        // Treat the first bare positional argument as the prompt (headless shortcut).
        if (!arg.startsWith('-') && raw['prompt'] === undefined) {
          raw['prompt'] = arg;
        } else if (!arg.startsWith('-')) {
          // Second positional — ambiguous, reject loudly.
          throw new Error(`Unexpected argument: ${JSON.stringify(arg)}\nRun with --help for usage.`);
        } else {
          throw new Error(`Unknown flag: ${JSON.stringify(arg)}\nRun with --help for usage.`);
        }
    }
  }

  try {
    return RawArgsSchema.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid arguments: ${error instanceof Error ? error.message : String(error)}\n` +
        `Run with --help for usage.`
    );
  }
}
```

**Design notes:**
- `z.enum(PERMISSION_MODES)` catches typos like `--permission-mode yolo` at startup.
- No `--help` flag is implemented here; it is a slash command (`/help`) inside the REPL.
- The parser is intentionally simple — no third-party arg parser — to keep the dependency
  tree minimal and the code readable.

---

## 4. `src/cli/InputBuffer.ts` — Multi-line Paste Mode (F18)

### 4.1 Motivation

The readline module delivers input one line at a time. When a user pastes a multi-line code
block, each line fires as a separate event. The `InputBuffer` state machine collects lines
and only returns a completed message when the paste block is closed.

Trigger: typing `"""` on a line by itself opens paste mode. Typing `"""` again closes it
and returns the accumulated content as a single string.

### 4.2 State Machine

```
IDLE
  │  feed("some text")         → returns "some text" immediately
  │  feed('"""')               → transitions to COLLECTING, returns null
  │
  ▼
COLLECTING
  │  feed("any line")          → appends to buffer, returns null
  │  feed('"""')               → transitions back to IDLE, returns joined buffer
```

### 4.3 Full Implementation

```typescript
// src/cli/InputBuffer.ts

/**
 * InputBuffer implements the multi-line paste mode for F18.
 *
 * Usage:
 *   const buf = new InputBuffer();
 *   const result = buf.feed(line);
 *   if (result !== null) sendToAgent(result);
 *
 * The caller should display a visual indicator (e.g. "... ") when isCollecting is true.
 */
export class InputBuffer {
  private readonly DELIMITER = '"""';

  // Accumulated lines while in paste mode (immutable: we push to a new array each time).
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
   * Feed a single line of input.
   *
   * Returns:
   *   - null    → still collecting; the REPL should show a continuation prompt
   *   - string  → complete message ready to send (may be empty string)
   */
  feed(line: string): { next: InputBuffer; value: string | null } {
    const trimmed = line.trim();

    if (!this.collecting) {
      if (trimmed === this.DELIMITER) {
        // Open paste mode.
        return {
          next: new InputBuffer([], true),
          value: null,
        };
      }
      // Normal single-line input — return immediately.
      return {
        next: new InputBuffer([], false),
        value: line,
      };
    }

    // Currently collecting.
    if (trimmed === this.DELIMITER) {
      // Close paste mode — join accumulated lines.
      const combined = [...this.lines].join('\n');
      return {
        next: new InputBuffer([], false),
        value: combined,
      };
    }

    // Still inside the paste block — accumulate.
    return {
      next: new InputBuffer([...this.lines, line], true),
      value: null,
    };
  }
}
```

**Design notes:**
- `InputBuffer` is **immutable**: `feed()` always returns a new instance plus an optional
  value. The REPL loop replaces `buffer` with `result.next` each iteration.
- No mutation of `this.lines` — the spread `[...this.lines, line]` creates a new array.
- The delimiter is `"""` (three double-quotes) because it is rare in conversational text
  and easy to type. It matches Python's docstring convention, which users recognize.

---

## 5. `src/cli/index.ts` — `main()` Function

### 5.1 Bootstrap Sequence

```
1. parseArgs()
2. ConfigManager.load(args)  → ResolvedConfig (frozen)
3. new AgentRegistry(config) → instance
   registry.load()           → all agent definitions discovered (3-tier)
4. new AgentManager(registry, agentName) → sets active agent
5. new PermissionGuard(config.permissionMode)
6. new OutputRenderer(config.debug, config.noColor)
7. new ConversationController(config, agentManager, guard, renderer)
```

All of these must succeed before the REPL starts. Any failure is a fatal startup error and
is reported to stderr then the process exits with code 1.

> **Note on constructor injection (step 7):** `PermissionGuard` and `OutputRenderer` are
> created in `main()` and injected into `ConversationController`. This explicit dependency
> injection makes the controller testable without real I/O. DESIGN_F4.md reflects this
> 4-argument constructor signature.

### 5.2 Full `main()` Implementation

```typescript
// src/cli/index.ts

import * as readline from 'node:readline';
import { parseArgs } from './args.js';
import { InputBuffer } from './InputBuffer.js';
import { ConfigManager } from '../config/ConfigManager.js';
import { AgentRegistry } from '../agents/AgentRegistry.js';
import { AgentManager } from '../agents/AgentManager.js';
import { ConversationController } from '../conversation/ConversationController.js';
import { PermissionGuard } from '../permissions/PermissionGuard.js';
import { OutputRenderer } from '../output/OutputRenderer.js';
import { UsageTracker } from '../output/UsageTracker.js';

/**
 * Summary printed on Ctrl+D or /exit.
 * Keeps it concise: just the facts, no marketing copy.
 *
 * UsageTracker is injected directly rather than accessed through ConversationController
 * because ConversationController does not expose a sessionStats() method — UsageTracker
 * is the authoritative source of token/turn data (see DESIGN_F7.md).
 */
function printUsageSummary(usage: UsageTracker): void {
  const stats = usage.summary();
  process.stdout.write(
    `\nSession ended.\n` +
      `  Turns: ${stats.turnCount}\n` +
      `  Tokens used: ${stats.totalInputTokens} in / ${stats.totalOutputTokens} out\n`
  );
}

/**
 * Reads all of stdin synchronously (used for piped mode, F13).
 * Throws if reading fails.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

export async function main(): Promise<void> {
  // ── 1. Parse & validate CLI arguments ─────────────────────────────────────
  let args;
  try {
    args = parseArgs();
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  // ── 2. Bootstrap services ──────────────────────────────────────────────────
  let config;
  let registry;
  let agentManager;
  let usage;
  let controller;
  let guard;
  let renderer;

  try {
    config = await ConfigManager.load(args);
    registry = new AgentRegistry(config);
    await registry.load();
    agentManager = new AgentManager(registry, args.agent ?? 'default');
    guard = new PermissionGuard(config.permissionMode);
    usage = new UsageTracker();
    renderer = new OutputRenderer(config.debug, config.noColor);
    controller = new ConversationController(config, agentManager, guard, renderer, usage);
  } catch (error) {
    process.stderr.write(
      `Startup failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }

  // ── 3. Headless / piped mode (F13) ────────────────────────────────────────
  // Triggered by: --prompt / -p flag, OR when stdin is not a terminal (piped).
  let headlessPrompt: string | undefined;

  if (args.prompt !== undefined) {
    headlessPrompt = args.prompt;
  } else if (!process.stdin.isTTY) {
    try {
      headlessPrompt = await readStdin();
    } catch (err) {
      process.stderr.write(`Failed to read stdin: ${String(err)}\n`);
      process.exit(1);
    }
  }

  if (headlessPrompt !== undefined) {
    try {
      await controller.handleInput(headlessPrompt);
    } catch (error) {
      process.stderr.write(
        `Error: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exit(1);
    }
    process.exit(0);
  }

  // ── 4. Interactive REPL mode (F1) ─────────────────────────────────────────
  const agentName = agentManager.current.name;
  process.stdout.write(`CodeAgent — active agent: ${agentName}\n`);
  process.stdout.write(`Type """ to start/end a multi-line block. Ctrl+D to exit.\n\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  let buffer = new InputBuffer();

  // ── 4a. SIGINT handler — abort in-flight request, do NOT exit (F1) ────────
  // readline swallows SIGINT by default (it just clears the line).
  // We intercept it to abort the current API request if one is running.
  rl.on('SIGINT', () => {
    controller.abort();
    // Print a newline so the next prompt appears on a fresh line.
    process.stdout.write('\n(aborted)\n');
  });

  // ── 4b. Ctrl+D / EOF handler — print summary then exit (F1) ──────────────
  rl.on('close', () => {
    printUsageSummary(usage);
    process.exit(0);
  });

  // ── 4c. readline error handler ────────────────────────────────────────────
  rl.on('error', (err: Error) => {
    process.stderr.write(`Readline error: ${err.message}\n`);
    process.exit(1);
  });

  // ── 4d. Main input loop ───────────────────────────────────────────────────
  const prompt = () => {
    const indicator = buffer.isCollecting ? '... ' : '> ';
    rl.setPrompt(indicator);
    rl.prompt();
  };

  rl.on('line', async (line: string) => {
    // Pause readline while we process input to prevent interleaved prompts.
    rl.pause();

    const result = buffer.feed(line);
    buffer = result.next;

    if (result.value === null) {
      // Still in paste mode — show continuation prompt.
      rl.resume();
      prompt();
      return;
    }

    const input = result.value.trim();

    if (input.length === 0) {
      // Blank line — re-prompt silently.
      rl.resume();
      prompt();
      return;
    }

    // All slash commands (including /exit and /quit) are handled by SlashCommandEngine
    // inside controller.handleInput(). Do NOT intercept them here — ExitCommand triggers
    // session save (DESIGN_F26) and cleanup before calling process.exit(0).
    try {
      await controller.handleInput(input);
    } catch (error) {
      // Report error but stay alive — the session is still usable.
      process.stderr.write(
        `Turn error: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }

    rl.resume();
    prompt();
  });

  // Start the loop.
  prompt();
}

// Entrypoint guard — only run when executed directly.
main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${String(err)}\n`);
  process.exit(1);
});
```

### 5.3 SIGINT Semantics

`Ctrl+C` must **not** exit the process. It should only abort the current in-flight
Anthropic API stream. The reasoning:

- Users habitually hit `Ctrl+C` when a response is taking too long.
- Killing the process would destroy the conversation history.
- The correct behavior (as in Claude Code itself) is: abort the stream, stay in the REPL,
  let the user send another message.

`controller.abort()` calls `AnthropicClient.abort()`, which calls `abortController.abort()`.
The stream generator catches `AbortError` and exits silently (no error event is emitted).

### 5.4 Ctrl+D (EOF) Semantics

When the user presses `Ctrl+D`, readline emits a `close` event. We:
1. Print the usage summary (turn count + token usage).
2. Call `process.exit(0)`.

This is the only clean exit path other than `/exit` and `/quit`.

### 5.5 Piped Stdin Handling (F13)

When `process.stdin.isTTY` is `false`, the process is receiving piped input. The entire
stdin stream is read into memory with `readStdin()`, then passed as the prompt to
`controller.handleInput()`. After the response is streamed to stdout, the process exits.

This allows shell integration patterns like:

```bash
echo "What does main() do?" | codeagent
cat error.log | codeagent "Explain this stack trace"
codeagent --prompt "List all exported functions in src/"
```

The `--prompt` flag takes precedence over piped stdin when both are present (flags are
checked first).

---

## 6. Error Handling

| Location | Error | Behavior |
|----------|-------|----------|
| `parseArgs()` | Invalid flag value | stderr + exit 1 |
| Bootstrap | Config load fails | stderr + exit 1 |
| Bootstrap | API key missing | stderr + exit 1 |
| `readStdin()` | Stream error | stderr + exit 1 |
| `controller.handleInput()` | API error, tool error | stderr message, REPL continues |
| `rl` error event | readline internal error | stderr + exit 1 |

The REPL deliberately **does not exit** on per-turn errors. An API timeout or tool failure
should not destroy the session — the user can retry.

---

## 7. Test Cases

### 7.1 `parseArgs()`

| Test | Input | Expected |
|------|-------|----------|
| Default values | `[]` | `{ debug: false, noColor: false, all others undefined }` |
| Short prompt flag | `['-p', 'hello']` | `{ prompt: 'hello' }` |
| Long prompt flag | `['--prompt', 'hello']` | `{ prompt: 'hello' }` |
| Positional prompt | `['hello world']` | `{ prompt: 'hello world' }` |
| Second positional | `['hello', 'extra']` | throws "Unexpected argument" |
| Unknown flag | `['--typo']` | throws "Unknown flag" |
| Permission mode | `['--permission-mode', 'auto']` | `{ permissionMode: 'auto' }` |
| Invalid permission mode | `['--permission-mode', 'bad']` | throws |
| Debug flag | `['--debug']` | `{ debug: true }` |
| No-color flag | `['--no-color']` | `{ noColor: true }` |
| Version flag | `['--version']` | prints version, exits 0 |
| Short version flag | `['-v']` | prints version, exits 0 |
| Working dir flag | `['--cwd', '/tmp']` | `{ workingDirectory: '/tmp' }` |
| All flags together | full argv | all fields populated |

### 7.2 `InputBuffer`

| Test | Sequence | Expected returns |
|------|----------|-----------------|
| Single line | `feed("hello")` | `value: "hello"` |
| Empty line | `feed("")` | `value: ""` |
| Open paste mode | `feed('"""')` | `value: null, isCollecting: true` |
| Line in paste mode | open + `feed("a")` | `value: null` |
| Close paste mode | open + `feed("a")` + `feed("b")` + `feed('"""')` | `value: "a\nb"` |
| Empty paste block | open + `feed('"""')` | `value: ""` |
| Immutability | feed returns new instance | original buffer unchanged |

### 7.3 `main()` — Integration

| Test | Scenario | Expected |
|------|----------|----------|
| Headless flag | `--prompt "hi"` with mocked controller | `handleInput("hi")` called, then exit 0 |
| Piped stdin | `process.stdin.isTTY = false`, pipe "hello" | reads stdin, calls `handleInput` |
| SIGINT | emit SIGINT during in-flight request | `controller.abort()` called, no exit |
| Ctrl+D | emit `rl.close` | `printUsageSummary(usage)` called, exit 0 |
| Blank line | feed empty string | re-prompts, no `handleInput` call |
| `/exit` command | feed `/exit` | routed to ExitCommand via SlashCommandEngine, exit 0 |
| Startup failure | `ConfigManager.load` throws | stderr message, exit 1 |
| Stdin read error | piped mode, stdin emits error | stderr message, exit 1 |
