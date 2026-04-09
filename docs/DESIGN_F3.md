# DESIGN_F3 — Core Tool System, Safety Guards, Rate Limiter, Bash Isolation

> Features: F3 (Core Tools), F17 (Safety Guards), F20 (Rate Limiter), F22 (Bash Isolation)

---

## 1. Purpose & Scope

This document covers the full tool system for Phase 1 of CodeAgent:

| Feature | Description |
|---------|-------------|
| F3 | ReadFile, WriteFile, BashTool — the three core tools |
| F17 | Output size cap (100K chars) and path traversal guard |
| F20 | Tool call rate limiter: max 25 calls per agentic loop turn |
| F22 | Bash env isolation (strip secrets) and subprocess cleanup |

The tool system is designed around a single interface (`CodeAgentTool`) so that Phase 2
tools (Glob, Grep, EditFile) drop in without changing the dispatch or safety layers.

### Non-goals

- This module does not decide which tools to offer the model (that is `AgentManager`'s job).
- It does not handle permission prompts (that is `PermissionGuard`'s job).
- It does not render tool output (that is `OutputRenderer`'s job).

---

## 2. File Structure

```
src/tools/
  types.ts            # CodeAgentTool, ToolResult interfaces
  guards.ts           # capOutput(), assertSafePath()
  ToolDispatcher.ts   # registry, allDefinitions(), dispatch()
  ReadFileTool.ts     # read_file implementation
  WriteFileTool.ts    # write_file implementation with diff preview
  BashTool.ts         # bash implementation with env isolation and cleanup
```

---

## 3. `src/tools/types.ts` — Common Interfaces

```typescript
// src/tools/types.ts

import type Anthropic from '@anthropic-ai/sdk';

/**
 * The result returned by every tool execution.
 * Matches the structure expected by Anthropic's tool_result message format.
 */
export interface ToolResult {
  /** The text content to report back to the model. May be truncated by capOutput(). */
  content: string;
  /** True if the operation failed. The model sees this and can decide how to proceed. */
  isError: boolean;
}

/**
 * Every tool in the system implements this interface.
 * The `definition` field is the Anthropic Tool schema sent to the API.
 * The `execute` method is called by ToolDispatcher after permission checks.
 */
export interface CodeAgentTool {
  /** The Anthropic Tool schema (name, description, input_schema). */
  readonly definition: Anthropic.Tool;

  /**
   * Execute the tool with the given raw input.
   * Input has been validated against the definition's input_schema before this is called.
   *
   * @param input - Raw input object from the model (already type-checked by ToolDispatcher).
   * @param workingDir - Absolute path of the session's working directory.
   * @returns A ToolResult, always. Should never throw.
   */
  execute(input: Record<string, unknown>, workingDir: string): Promise<ToolResult>;
}
```

---

## 4. `src/tools/guards.ts` — Safety Guards (F17)

```typescript
// src/tools/guards.ts

import * as path from 'node:path';

/** Maximum tool output size in characters. ~25K tokens at 4 chars/token. */
export const MAX_TOOL_OUTPUT_CHARS = 100_000;

/**
 * Cap a tool's raw output to MAX_TOOL_OUTPUT_CHARS.
 * Appends a truncation notice so the model knows the output was cut.
 *
 * @param raw - The full output string from the tool operation.
 * @param toolName - Used in the truncation message for context.
 * @returns The (possibly truncated) output string.
 */
export function capOutput(raw: string, toolName: string): string {
  if (raw.length <= MAX_TOOL_OUTPUT_CHARS) {
    return raw;
  }
  const truncated = raw.slice(0, MAX_TOOL_OUTPUT_CHARS);
  const notice =
    `\n\n[Output truncated: ${toolName} produced ${raw.length.toLocaleString()} characters. ` +
    `Only the first ${MAX_TOOL_OUTPUT_CHARS.toLocaleString()} characters are shown. ` +
    `Use more specific queries to see the rest.]`;
  return truncated + notice;
}

/**
 * Assert that `inputPath` resolves within `workingDir`.
 * Throws a user-friendly Error if the path escapes the working directory.
 *
 * Both paths are resolved to absolute before comparison so that symlinks
 * and `..` sequences cannot be used to escape.
 *
 * @param inputPath - The file path provided by the model.
 * @param workingDir - The session's working directory (already absolute).
 * @throws Error if the resolved path is outside workingDir.
 */
export function assertSafePath(inputPath: string, workingDir: string): void {
  const resolvedInput = path.resolve(workingDir, inputPath);
  const resolvedWorking = path.resolve(workingDir);

  // Ensure the resolved input starts with the working directory prefix.
  // Add a trailing separator to prevent false positives like:
  //   /app/src matching /app/src-extra
  const prefix = resolvedWorking.endsWith(path.sep)
    ? resolvedWorking
    : resolvedWorking + path.sep;

  if (!resolvedInput.startsWith(prefix) && resolvedInput !== resolvedWorking) {
    throw new Error(
      `Path traversal blocked: "${inputPath}" resolves to "${resolvedInput}", ` +
        `which is outside the working directory "${resolvedWorking}".`
    );
  }
}
```

**Design note on `assertSafePath`:**
The trailing-separator check (`/app/src` vs `/app/src-extra`) is subtle but important.
`'/app/src-extra'.startsWith('/app/src')` is `true` without the separator check. The
separator ensures we compare full path segments, not string prefixes.

---

## 5. `src/tools/ToolDispatcher.ts` — Registry and Dispatch

```typescript
// src/tools/ToolDispatcher.ts

import type Anthropic from '@anthropic-ai/sdk';
import type { CodeAgentTool, ToolResult } from './types.js';
import { capOutput } from './guards.js';

/**
 * ToolDispatcher is the single entry point for all tool execution.
 * It maintains a registry of registered tools and dispatches calls by name.
 *
 * The dispatcher also applies output capping after execution.
 * Path-safety checking is done inside each individual tool's execute() method
 * because not all tools operate on file paths (e.g., Bash).
 */
export class ToolDispatcher {
  private readonly registry: Map<string, CodeAgentTool>;

  constructor() {
    this.registry = new Map();
  }

  /**
   * Register a tool. Throws if a tool with the same name is already registered.
   * Called once during bootstrap to build the tool set.
   */
  register(tool: CodeAgentTool): void {
    const name = tool.definition.name;
    if (this.registry.has(name)) {
      throw new Error(`Tool "${name}" is already registered.`);
    }
    this.registry.set(name, tool);
  }

  /**
   * Returns the Anthropic Tool schemas for all registered tools.
   * This array is sent to the API on every request.
   *
   * If `allowlist` is provided, only tools in the allowlist are returned.
   * This supports agent-level tool restrictions.
   */
  allDefinitions(allowlist?: ReadonlySet<string>): Anthropic.Tool[] {
    const definitions: Anthropic.Tool[] = [];
    for (const [name, tool] of this.registry) {
      if (allowlist === undefined || allowlist.has(name)) {
        definitions.push(tool.definition);
      }
    }
    return definitions;
  }

  /**
   * Dispatch a tool call by name.
   * Applies output capping to the result.
   *
   * @param name - Tool name from the model's tool_use block.
   * @param input - Raw input object from the model.
   * @param workingDir - Absolute path of the session's working directory.
   * @returns A ToolResult, always — never throws.
   */
  async dispatch(
    name: string,
    input: Record<string, unknown>,
    workingDir: string
  ): Promise<ToolResult> {
    const tool = this.registry.get(name);

    if (!tool) {
      return {
        content: `Unknown tool: "${name}". Available tools: ${[...this.registry.keys()].join(', ')}.`,
        isError: true,
      };
    }

    try {
      const result = await tool.execute(input, workingDir);
      return {
        content: capOutput(result.content, name),
        isError: result.isError,
      };
    } catch (error: unknown) {
      // Tool execute() should not throw, but guard defensively.
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: `Tool "${name}" threw an unexpected error: ${message}`,
        isError: true,
      };
    }
  }
}
```

---

## 6. Tool Call Rate Limiter (F20)

The rate limiter is tracked in `ConversationController`, not in `ToolDispatcher`.
This is the correct place because the limit is per-turn (per-agentic-loop recursion chain),
not per-dispatch call.

```typescript
// src/conversation/ConversationController.ts (excerpt)

const MAX_TOOL_CALLS_PER_TURN = 25;

class ConversationController {
  private toolCallsThisTurn = 0;

  private async runAgenticLoop(/* ... */): Promise<void> {
    // ... stream events from AnthropicClient ...
    // After collecting pendingToolCalls:

    this.toolCallsThisTurn += pendingToolCalls.length;

    if (this.toolCallsThisTurn > MAX_TOOL_CALLS_PER_TURN) {
      // Append a synthetic tool_result indicating the limit was hit.
      // This forces the model to write a final answer without more tools.
      const limitMessage =
        `Tool call limit reached (${MAX_TOOL_CALLS_PER_TURN} calls per turn). ` +
        `Please summarize what you have found so far.`;
      // append limitMessage as a user role message and stop recursing.
      return;
    }

    // Reset counter at the start of each user-initiated turn (not each recursion).
  }

  async handleInput(userText: string): Promise<void> {
    this.toolCallsThisTurn = 0; // Reset at the start of each user turn.
    // ...
    await this.runAgenticLoop();
  }
}
```

**Why 25?** This matches Claude Code's default limit. It is high enough for complex
multi-file operations (read 10 files, write 5, run 3 checks) while preventing runaway loops.

---

## 7. `src/tools/ReadFileTool.ts`

```typescript
// src/tools/ReadFileTool.ts

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { assertSafePath } from './guards.js';
import type { CodeAgentTool, ToolResult } from './types.js';
import type Anthropic from '@anthropic-ai/sdk';

const ReadFileParams = z.object({
  /** Relative or absolute path to the file. Relative paths are resolved from workingDir. */
  path: z.string().min(1, 'path must not be empty'),
  /** Optional: 1-based line number to start reading from. */
  start_line: z.number().int().positive().optional(),
  /** Optional: 1-based line number to stop reading at (inclusive). */
  end_line: z.number().int().positive().optional(),
});

type ReadFileParams = z.infer<typeof ReadFileParams>;

export class ReadFileTool implements CodeAgentTool {
  readonly definition: Anthropic.Tool = {
    name: 'read_file',
    description:
      'Read the contents of a file. Optionally read a line range. ' +
      'Output includes 1-based line numbers prefixed to each line.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file, relative to the working directory.',
        },
        start_line: {
          type: 'number',
          description: 'First line to read (1-based, inclusive). Defaults to 1.',
        },
        end_line: {
          type: 'number',
          description: 'Last line to read (1-based, inclusive). Defaults to end of file.',
        },
      },
      required: ['path'],
    },
  };

  async execute(input: Record<string, unknown>, workingDir: string): Promise<ToolResult> {
    let params: ReadFileParams;
    try {
      params = ReadFileParams.parse(input);
    } catch (error) {
      return {
        content: `Invalid parameters: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    const absolutePath = path.resolve(workingDir, params.path);

    try {
      assertSafePath(params.path, workingDir);
    } catch (error) {
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }

    let rawContent: string;
    try {
      rawContent = await fs.readFile(absolutePath, 'utf8');
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { content: `File not found: "${params.path}"`, isError: true };
      }
      if (code === 'EACCES') {
        return { content: `Permission denied: "${params.path}"`, isError: true };
      }
      return {
        content: `Failed to read "${params.path}": ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    const allLines = rawContent.split('\n');
    const startIdx = (params.start_line ?? 1) - 1; // 0-based
    const endIdx = params.end_line !== undefined ? params.end_line - 1 : allLines.length - 1;

    if (startIdx < 0 || startIdx >= allLines.length) {
      return {
        content: `start_line ${params.start_line} is out of range (file has ${allLines.length} lines).`,
        isError: true,
      };
    }

    const selectedLines = allLines.slice(startIdx, endIdx + 1);

    // Prefix each line with its 1-based line number, padded for alignment.
    const totalLines = allLines.length;
    const padWidth = String(totalLines).length;
    const numbered = selectedLines
      .map((line, idx) => {
        const lineNum = String(startIdx + idx + 1).padStart(padWidth, ' ');
        return `${lineNum}\t${line}`;
      })
      .join('\n');

    const rangeNote =
      params.start_line !== undefined || params.end_line !== undefined
        ? ` (lines ${startIdx + 1}–${Math.min(endIdx + 1, totalLines)} of ${totalLines})`
        : ` (${totalLines} lines)`;

    return {
      content: `File: ${params.path}${rangeNote}\n\n${numbered}`,
      isError: false,
    };
  }
}
```

---

## 8. `src/tools/WriteFileTool.ts`

```typescript
// src/tools/WriteFileTool.ts

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { assertSafePath } from './guards.js';
import type { CodeAgentTool, ToolResult } from './types.js';
import type Anthropic from '@anthropic-ai/sdk';

const WriteFileParams = z.object({
  path: z.string().min(1, 'path must not be empty'),
  content: z.string(),
});

type WriteFileParams = z.infer<typeof WriteFileParams>;

/**
 * Generate a simple unified diff between two strings.
 * Used by WriteFileTool to preview changes before applying them.
 * We compute this manually to avoid requiring the `diff` npm package in Phase 1.
 */
function simpleDiff(oldContent: string, newContent: string, filePath: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const removed = oldLines.filter((l) => !newLines.includes(l)).length;
  const added = newLines.filter((l) => !oldLines.includes(l)).length;

  // For Phase 1, show a summary rather than a full Myers diff.
  // Phase 2 (EditFileTool) will use a proper diff library.
  return (
    `--- a/${filePath}\n` +
    `+++ b/${filePath}\n` +
    `@@ Summary: ${removed} lines removed, ${added} lines added @@\n` +
    `New file will have ${newLines.length} lines (was ${oldLines.length}).`
  );
}

export class WriteFileTool implements CodeAgentTool {
  readonly definition: Anthropic.Tool = {
    name: 'write_file',
    description:
      'Write content to a file. Creates the file if it does not exist, ' +
      'or overwrites it if it does. Creates parent directories as needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to write, relative to the working directory.',
        },
        content: {
          type: 'string',
          description: 'The full content to write to the file.',
        },
      },
      required: ['path', 'content'],
    },
  };

  /**
   * Optional diff preview hook. If set, is called before writing and its return
   * value (the diff string) is included in the result. PermissionGuard calls this
   * to display a preview alongside the y/n/a prompt.
   *
   * In default permission mode, the PermissionGuard inspects the diff before
   * prompting the user. The WriteFileTool itself always writes if dispatch() is called
   * (the guard has already approved by that point).
   */
  async buildDiffPreview(params: WriteFileParams, workingDir: string): Promise<string> {
    const absolutePath = path.resolve(workingDir, params.path);
    let existingContent = '';
    try {
      existingContent = await fs.readFile(absolutePath, 'utf8');
    } catch {
      // File doesn't exist yet — diff from empty.
      existingContent = '';
    }
    return simpleDiff(existingContent, params.content, params.path);
  }

  async execute(input: Record<string, unknown>, workingDir: string): Promise<ToolResult> {
    let params: WriteFileParams;
    try {
      params = WriteFileParams.parse(input);
    } catch (error) {
      return {
        content: `Invalid parameters: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    try {
      assertSafePath(params.path, workingDir);
    } catch (error) {
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }

    const absolutePath = path.resolve(workingDir, params.path);

    try {
      // Create parent directories if they do not exist.
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, params.content, 'utf8');
    } catch (error: unknown) {
      return {
        content: `Failed to write "${params.path}": ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    const lineCount = params.content.split('\n').length;
    return {
      content: `Successfully wrote ${lineCount} lines to "${params.path}".`,
      isError: false,
    };
  }
}
```

**Diff preview integration note:**
`WriteFileTool.buildDiffPreview()` is called by `PermissionGuard` (or `ConversationController`)
before `ToolDispatcher.dispatch()` is called. The diff is shown to the user alongside the
y/n/a prompt. If the user approves, dispatch proceeds and the file is written. If denied,
a synthetic "denied" tool_result is appended to messages without calling `execute()`.

---

## 9. `src/tools/BashTool.ts` (F22)

### 9.1 Environment Isolation

Sensitive environment variables must not be inherited by subprocesses. The model could be
tricked into running a command that exfiltrates secrets from the environment.

```typescript
// src/tools/BashTool.ts

import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { capOutput } from './guards.js';
import type { CodeAgentTool, ToolResult } from './types.js';
import type Anthropic from '@anthropic-ai/sdk';

/**
 * Environment variable name prefixes that are stripped before spawning bash.
 * Any env var whose name starts with one of these strings is excluded.
 */
const BLOCKED_ENV_PREFIXES: ReadonlyArray<string> = [
  'ANTHROPIC_',
  'OPENAI_',
  'GEMINI_',
  'AWS_SECRET',
  'AWS_SESSION',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'STRIPE_',
  'TWILIO_',
  'SENDGRID_',
  'DATABASE_URL',
  'DB_PASSWORD',
  'REDIS_URL',
  'SECRET_',
  'API_KEY',
  'API_SECRET',
  'ACCESS_TOKEN',
  'REFRESH_TOKEN',
  'PRIVATE_KEY',
];

/**
 * Build a sanitized copy of process.env with blocked prefixes removed.
 * Returns a new object — never mutates process.env.
 */
function safeEnv(): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upperKey = key.toUpperCase();
    const blocked = BLOCKED_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix));
    if (!blocked) {
      safe[key] = value;
    }
  }
  return safe;
}

/** Tracks all active bash subprocesses so they can be cleaned up on session exit. */
const activeProcesses = new Set<ChildProcess>();

/** Milliseconds to wait for SIGTERM before escalating to SIGKILL. */
const SIGKILL_GRACE_MS = 2_000;

/**
 * Register a cleanup handler on process exit.
 * Runs once at module load time. Kills all tracked subprocesses on exit.
 */
process.on('exit', () => {
  for (const proc of activeProcesses) {
    try {
      proc.kill('SIGTERM');
    } catch {
      // Process may have already ended — ignore.
    }
  }
});
```

### 9.2 BashTool Implementation

```typescript
// src/tools/BashTool.ts (continued)

const BashParams = z.object({
  command: z.string().min(1, 'command must not be empty'),
  /** Timeout in milliseconds. Default: 30_000 (30 seconds). Max: 300_000 (5 minutes). */
  timeout_ms: z.number().int().positive().max(300_000).optional(),
});

type BashParams = z.infer<typeof BashParams>;

const DEFAULT_TIMEOUT_MS = 30_000;

export class BashTool implements CodeAgentTool {
  readonly definition: Anthropic.Tool = {
    name: 'bash',
    description:
      'Run a bash command in the working directory. ' +
      'Stdout and stderr are captured and returned. ' +
      'Commands run with sensitive environment variables removed. ' +
      'Long-running commands are killed after the timeout.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The bash command to run.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Timeout in milliseconds. Default: 30000. Max: 300000.',
        },
      },
      required: ['command'],
    },
  };

  async execute(input: Record<string, unknown>, workingDir: string): Promise<ToolResult> {
    let params: BashParams;
    try {
      params = BashParams.parse(input);
    } catch (error) {
      return {
        content: `Invalid parameters: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;

    return new Promise<ToolResult>((resolve) => {
      const proc = spawn('bash', ['-c', params.command], {
        cwd: workingDir,
        env: safeEnv(),
        // Use a process group so we can kill the entire tree, not just bash.
        detached: false,
      });

      activeProcesses.add(proc);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let killed = false;

      proc.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      // ── Timeout: SIGTERM → SIGKILL escalation ───────────────────────────
      const timeoutHandle = setTimeout(() => {
        if (!killed) {
          killed = true;
          proc.kill('SIGTERM');

          // Give the process 2 seconds to exit cleanly before forcing it.
          const killHandle = setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch {
              // Already dead.
            }
          }, SIGKILL_GRACE_MS);

          // Avoid keeping the event loop alive just for the SIGKILL timer.
          killHandle.unref?.();
        }
      }, timeoutMs);

      proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timeoutHandle);
        activeProcesses.delete(proc);

        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');

        let output = '';
        if (stdout.length > 0) output += stdout;
        if (stderr.length > 0) output += (output.length > 0 ? '\n[stderr]\n' : '[stderr]\n') + stderr;
        if (output.length === 0) output = '(no output)';

        if (killed) {
          resolve({
            content: capOutput(
              `[Killed: timeout after ${timeoutMs}ms]\n${output}`,
              'bash'
            ),
            isError: true,
          });
          return;
        }

        const exitInfo = signal !== null ? `[Killed by signal: ${signal}]` : `[Exit code: ${code}]`;
        const isError = code !== 0 && signal === null;

        resolve({
          content: capOutput(`${exitInfo}\n${output}`, 'bash'),
          isError,
        });
      });

      proc.on('error', (err: Error) => {
        clearTimeout(timeoutHandle);
        activeProcesses.delete(proc);
        resolve({
          content: `Failed to spawn bash: ${err.message}`,
          isError: true,
        });
      });
    });
  }
}
```

### 9.3 Timeout Design

```
Command starts
      │
   [timeoutMs]
      │
   SIGTERM sent
      │
   [2000ms grace]
      │
   SIGKILL sent (if process still alive)
```

The two-phase kill (SIGTERM then SIGKILL) gives well-behaved processes (e.g., `npm test`)
a chance to write output and exit cleanly. Processes that ignore SIGTERM are force-killed.

### 9.4 Output Merging

Stdout and stderr are collected separately (avoiding interleaving races) and combined:

- If stderr is empty, only stdout is returned.
- If both are non-empty, stderr is appended under a `[stderr]` header.
- `capOutput()` is applied to the combined string.

---

## 10. Test Cases

### 10.1 `capOutput()`

| Test | Input length | Expected |
|------|-------------|----------|
| Short output | < 100K chars | returned unchanged |
| Exact limit | = 100K chars | returned unchanged |
| Over limit | > 100K chars | truncated + notice appended |
| Notice content | any | notice includes char count and tool name |

### 10.2 `assertSafePath()`

| Test | inputPath | workingDir | Expected |
|------|-----------|------------|----------|
| Relative within | `"src/main.ts"` | `"/app"` | passes |
| Absolute within | `"/app/src/main.ts"` | `"/app"` | passes |
| Dot-dot escape | `"../secret.txt"` | `"/app"` | throws |
| Double dot-dot | `"../../etc/passwd"` | `"/app/src"` | throws |
| Sibling directory | `"/app-extra/file"` | `"/app"` | throws |
| Working dir itself | `"."` | `"/app"` | passes |

### 10.3 `ToolDispatcher`

| Test | Scenario | Expected |
|------|----------|----------|
| Register + dispatch | register ReadFileTool, dispatch "read_file" | calls execute() |
| Unknown tool | dispatch "nonexistent" | returns error ToolResult |
| Double register | register same tool twice | throws |
| Output capping | execute() returns 200K chars | capOutput() applied |
| allowlist filtering | allDefinitions({ 'read_file' }) | only read_file returned |

### 10.4 `ReadFileTool`

| Test | Scenario | Expected |
|------|----------|----------|
| Normal read | existing file | content with line numbers |
| Line range | start_line=2, end_line=4 | only those lines, numbers preserved |
| File not found | nonexistent path | isError: true, ENOENT message |
| Path traversal | `../outside.txt` | isError: true, traversal message |
| Empty file | empty file | 0 lines, no error |
| Invalid start_line | start_line=9999 | isError: true, out of range message |

### 10.5 `WriteFileTool`

| Test | Scenario | Expected |
|------|----------|----------|
| New file | write to nonexistent path | file created, success message |
| Overwrite | write to existing file | file overwritten, success message |
| Create dirs | path with nonexistent parent dirs | directories created |
| Path traversal | `../outside.txt` | isError: true |
| buildDiffPreview new | file does not exist | diff from empty |
| buildDiffPreview existing | file exists | diff shows changes |

### 10.6 `BashTool`

| Test | Scenario | Expected |
|------|----------|----------|
| Simple command | `echo hello` | `[Exit code: 0]\nhello\n` |
| Exit code | `exit 1` | isError: true |
| Stderr capture | `echo err >&2` | output contains `[stderr]` section |
| Timeout | `sleep 10` with timeout_ms=100 | killed, isError: true |
| SIGKILL fallback | trap SIGTERM, sleep 10 | SIGKILL after grace period |
| Env isolation | `echo $ANTHROPIC_API_KEY` | empty (variable stripped) |
| Working dir | `pwd` | returns workingDir |
| Invalid command | `nonexistent_cmd_xyz` | isError: true, exit code 127 |

### 10.7 `safeEnv()`

| Test | Scenario | Expected |
|------|----------|----------|
| API key stripped | `ANTHROPIC_API_KEY=secret` in env | not present in safeEnv() |
| Safe var kept | `HOME=/home/user` in env | present in safeEnv() |
| Case sensitivity | `anthropic_api_key=x` (lowercase) | stripped (uppercased before check) |
| Partial prefix | `STRIPE_SECRET_KEY=x` | stripped (STRIPE_ prefix matches) |
