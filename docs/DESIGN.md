# CodeAgent — Master Design Document

> This is the authoritative reference for all developers working on CodeAgent.
> Individual feature implementation details live in the `DESIGN_F#.md` files listed in §11.
> Architecture overview and data flows are in [PLAN.md](./PLAN.md).

---

## Table of Contents

1. [Tech Stack](#1-tech-stack)
2. [Build Strategy](#2-build-strategy)
3. [Development Environment](#3-development-environment)
4. [Test Strategy](#4-test-strategy)
5. [Deployment & Packaging](#5-deployment--packaging)
6. [Environment Configuration](#6-environment-configuration)
7. [CLI Command Reference](#7-cli-command-reference)
8. [Common Interfaces](#8-common-interfaces)
9. [Common Data Structures](#9-common-data-structures)
10. [Error Handling Strategy](#10-error-handling-strategy)
11. [Feature Design Files Index](#11-feature-design-files-index)

---

## 1. Tech Stack

### Runtime

| Component | Choice | Notes |
|-----------|--------|-------|
| Runtime | Node.js 22+ (ESM) | ESM-only output; no CommonJS interop |
| Language | TypeScript 5.5+ | Strict mode; no `any`; no `@ts-nocheck` |
| Package manager | pnpm (primary) | `pnpm-lock.yaml` committed; Bun compatible for scripts |

### Production Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@anthropic-ai/sdk` | latest | Anthropic streaming API client |
| `zod` | ^3 | Schema validation at all external boundaries |
| `chalk` | ^5 | ANSI terminal colors (ESM-only build) |
| `marked` | ^12 | Markdown parser |
| `marked-terminal` | ^7 | Markdown → ANSI renderer for terminal output |
| `commander` | ^12 | CLI argument parsing |
| `diff` | ^5 | Unified diff generation for file change previews |

### Dev Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | ^5.5 | Compiler |
| `tsx` | ^4 | TypeScript execution for dev mode (no compilation step) |
| `vitest` | ^2 | Test framework |
| `@vitest/coverage-v8` | ^2 | V8-based coverage provider |
| `@types/node` | ^22 | Node.js type definitions |
| `oxlint` | latest | Fast Rust-based linter |
| `oxfmt` | latest | Fast Rust-based formatter |
| `@types/diff` | ^5 | Type definitions for the `diff` package |

---

## 2. Build Strategy

### TypeScript Configuration

`tsconfig.json` settings:

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "sourceMap": true,
    "declaration": true,
    "declarationMap": true,
    "esModuleInterop": false,
    "skipLibCheck": false,
    "paths": {}
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

Key decisions:
- `"module": "NodeNext"` + `"moduleResolution": "NodeNext"` enforces ESM import extensions (`.js` in import paths, mapping to `.ts` source files).
- `"noUncheckedIndexedAccess": true` prevents silent `undefined` from array/object index access.
- `"exactOptionalPropertyTypes": true` prevents assigning `undefined` to optional fields explicitly.
- Source maps are always emitted — required for readable stack traces in production bug reports.
- Declaration files are emitted — required if the package is ever consumed as a library.

### Compilation Output

```
src/                    TypeScript source
dist/                   Compiled JavaScript (ESM)
  cli/
    index.js            Binary entrypoint (shebang: #!/usr/bin/env node)
  api/
  conversation/
  tools/
  agents/
  commands/
  permissions/
  config/
  output/
  logger/
```

### Binary Entrypoint

`dist/cli/index.js` must begin with the shebang line:

```
#!/usr/bin/env node
```

This line is added by a `postbuild` script that prepends it and sets the file executable:

```bash
# scripts/postbuild.sh
echo '#!/usr/bin/env node' | cat - dist/cli/index.js > tmp && mv tmp dist/cli/index.js
chmod +x dist/cli/index.js
```

### package.json bin Field

```jsonc
{
  "bin": {
    "codeagent": "dist/cli/index.js"
  }
}
```

---

## 3. Development Environment

### npm Scripts

```jsonc
{
  "scripts": {
    "dev":           "tsx src/cli/index.ts",
    "build":         "tsc && pnpm postbuild",
    "postbuild":     "bash scripts/postbuild.sh",
    "test":          "vitest run",
    "test:watch":    "vitest",
    "test:coverage": "vitest run --coverage",
    "lint":          "oxlint src",
    "format":        "oxfmt --check src",
    "format:fix":    "oxfmt --write src",
    "check":         "pnpm lint && pnpm format && pnpm build",
    "typecheck":     "tsc --noEmit"
  }
}
```

### Environment Variables for Development

All environment variables are described fully in §6. For local development, the minimum required setup is:

```bash
# ~/.zshrc or .env (never commit .env)
export ANTHROPIC_API_KEY="sk-ant-..."
```

Optional dev-time variables:

```bash
export CODEAGENT_DEBUG=1           # enables debug logging to file and stderr
export CODEAGENT_MODEL="claude-sonnet-4-6"  # override model without CLI flag
```

### Dev Mode vs Built Mode

| Mode | Command | Notes |
|------|---------|-------|
| Dev (source) | `pnpm dev [args]` | Uses `tsx`; no compilation; fast iteration |
| Dev (watch) | `pnpm dev -- --debug` | Same; pass CLI args after `--` |
| Built | `node dist/cli/index.js [args]` | Requires `pnpm build` first |
| Global install | `codeagent [args]` | After `npm install -g` from dist |

Dev mode uses `tsx` for direct TypeScript execution. There is no hot-reload — the process is restarted manually. For interactive sessions, `pnpm dev` is the recommended workflow.

---

## 4. Test Strategy

### Framework

- **Vitest** with the **V8 coverage provider** (`@vitest/coverage-v8`).
- All test runs use `vitest run` (non-watch) in CI; `vitest` (watch) for local development.

### Coverage Thresholds

```jsonc
// vitest.config.ts
{
  "coverage": {
    "provider": "v8",
    "thresholds": {
      "lines":      80,
      "branches":   80,
      "functions":  80,
      "statements": 80
    },
    "exclude": [
      "dist/**",
      "**/*.test.ts",
      "src/cli/index.ts"   // REPL entrypoint — tested via e2e
    ]
  }
}
```

### Test File Naming

- Unit and integration tests: co-located with source as `*.test.ts`
  - Example: `src/tools/ReadFileTool.test.ts`
- End-to-end tests: suffix `*.e2e.test.ts`, also co-located
  - Example: `src/cli/repl.e2e.test.ts`

### Test Categories

| Category | Scope | Mocking | Example |
|----------|-------|---------|---------|
| Unit | Pure logic, single function or class | All I/O mocked | `ConfigManager.test.ts` |
| Integration | Multiple modules cooperating; tool execution | `AnthropicClient` mocked, real fs | `ToolDispatcher.test.ts` |
| E2E | Full REPL session from stdin to stdout | Real API (behind `LIVE=1` flag) | `repl.e2e.test.ts` |

### Mocking Strategy

**AnthropicClient** is the central mock boundary. Unit and integration tests never call the real Anthropic API.

```typescript
// Canonical mock pattern
import { vi } from 'vitest'
import { AnthropicClient } from '../api/AnthropicClient.js'

vi.mock('../api/AnthropicClient.js', () => ({
  AnthropicClient: vi.fn().mockImplementation(() => ({
    stream: vi.fn().mockImplementation(async function* () {
      yield { type: 'text_delta', text: 'Hello from mock' }
      yield { type: 'message_stop', usage: { input_tokens: 10, output_tokens: 5 } }
    })
  }))
}))
```

**File system** access is mocked with `vi.mock('node:fs/promises')` for unit tests. Integration tests use a real temporary directory created in `beforeEach` and removed in `afterEach`.

**Live E2E tests** run only when `LIVE=1` is set:

```typescript
const itLive = process.env.LIVE === '1' ? it : it.skip
itLive('full session with real API', async () => { ... })
```

### What NOT to Test

- Third-party API behavior (Anthropic response shapes are mocked, not tested)
- OS-specific bash behavior (Bash tests verify our wrapper logic, not shell semantics)
- Formatting output pixel-perfect (snapshot tests for ANSI sequences are fragile)

### Test Cleanup Rules

Every test file must clean up after itself:
- Restore `vi.spyOn` mocks in `afterEach`
- Remove temp directories in `afterEach`
- Restore modified `process.env` entries
- Clear global state (module-level singletons must expose a `reset()` method for tests)

---

## 5. Deployment & Packaging

### npm Package

- **Package name:** `codeagent`
- **Visibility:** public
- **Registry:** https://registry.npmjs.org
- **Install command:** `npm install -g codeagent`

### package.json Publish Fields

```jsonc
{
  "name": "codeagent",
  "version": "0.1.0",
  "type": "module",
  "bin": { "codeagent": "dist/cli/index.js" },
  "main": "dist/cli/index.js",
  "exports": {
    ".": "./dist/cli/index.js"
  },
  "files": ["dist", "CHANGELOG.md", "README.md"],
  "engines": { "node": ">=22" }
}
```

### Local User Data

All runtime state is stored under `~/.codeagent/`:

```
~/.codeagent/
├── config.json          # user-global configuration
├── agents/              # user-global agent definitions (*.md)
├── history/             # session history files (*.json)
└── logs/                # debug log files (session-<timestamp>.log)
```

Project-local overrides live in `.codeagent/` at the repository root:

```
<project-root>/.codeagent/
├── config.json          # project-local config (overrides user-global)
└── agents/              # project-local agent definitions (*.md)
```

### Version Check on Startup

At startup, CodeAgent asynchronously checks the npm registry for a newer version. The check is fire-and-forget and never blocks the session. If a newer version is found, a one-line notice is printed after the welcome banner:

```
[notice] A new version is available: 0.1.0 → 0.2.0  (npm install -g codeagent)
```

The check respects a 24-hour cache stored in `~/.codeagent/config.json` under the key `_lastVersionCheck` to avoid spamming the registry.

### Changelog

User-facing changes are documented in `CHANGELOG.md` at the repository root. Format follows [Keep a Changelog](https://keepachangelog.com/). New entries are appended to the bottom of the active version block's relevant section (`### Added`, `### Fixed`, `### Changed`).

---

## 6. Environment Configuration

All environment variables are read once at startup by `ConfigManager` and merged into `ResolvedConfig`. An unset required variable causes an immediate startup failure with a clear error message.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Required | — | Anthropic API key. Must begin with `sk-ant-`. Fails fast at startup if absent. |
| `CODEAGENT_MODEL` | Optional | `claude-sonnet-4-6` | Default model for all agents unless overridden by agent definition or `--model` flag. |
| `CODEAGENT_PERMISSION_MODE` | Optional | `default` | Controls tool execution safety. Accepted values: `auto`, `default`, `deny`. |
| `CODEAGENT_DEBUG` | Optional | `""` (disabled) | When set to any non-empty value, enables debug logging to `~/.codeagent/logs/`. |
| `CODEAGENT_MAX_TOOL_CALLS` | Optional | `25` | Maximum number of tool calls allowed per agentic loop turn. Integer ≥ 1. |
| `CODEAGENT_MAX_OUTPUT_CHARS` | Optional | `100000` | Maximum characters returned by any single tool call. Larger outputs are truncated. |

### Validation

All environment variables are validated with a Zod schema in `src/config/ConfigManager.ts`:

```typescript
const envSchema = z.object({
  ANTHROPIC_API_KEY:          z.string().min(1),
  CODEAGENT_MODEL:            z.string().optional(),
  CODEAGENT_PERMISSION_MODE:  z.enum(['auto', 'default', 'deny']).optional(),
  CODEAGENT_DEBUG:            z.string().optional(),
  CODEAGENT_MAX_TOOL_CALLS:   z.coerce.number().int().min(1).optional(),
  CODEAGENT_MAX_OUTPUT_CHARS: z.coerce.number().int().min(1).optional(),
})
```

---

## 7. CLI Command Reference

### Flags

| Short | Long | Type | Default | Description |
|-------|------|------|---------|-------------|
| `-k` | `--api-key` | string | `$ANTHROPIC_API_KEY` | Anthropic API key. Overrides the environment variable. |
| `-m` | `--model` | string | `$CODEAGENT_MODEL` or `claude-sonnet-4-6` | Model to use for all API calls in this session. |
| — | `--permission-mode` | `auto\|default\|deny` | `default` | Tool execution permission mode. `auto` skips all prompts; `deny` blocks all destructive tools. |
| `-a` | `--agent` | string | `default` | Name of the agent to activate at startup. Must match a built-in name or a `.md` file in the agent search path. |
| `-p` | `--print` | string | — | Run a single prompt non-interactively and exit. Enables headless mode. |
| — | `--debug` | boolean | `false` | Enable debug logging to `~/.codeagent/logs/`. Equivalent to setting `CODEAGENT_DEBUG=1`. |
| — | `--no-color` | boolean | `false` | Disable all ANSI color output. Useful for piped output or terminals that do not support color. |
| `-v` | `--version` | boolean | — | Print the package version and exit. |
| `-h` | `--help` | boolean | — | Print usage information and exit. |

### Slash Commands

Slash commands are entered at the REPL prompt. They are dispatched by `SlashCommandEngine` before the input reaches `ConversationController`. All slash commands are case-insensitive.

| Command | Aliases | Syntax | Description |
|---------|---------|--------|-------------|
| `/clear` | — | `/clear` | Reset the conversation history (`messages[]`) to empty. Does not change the active agent or config. |
| `/exit` | `/quit` | `/exit` | Print the session usage summary and exit the process with code 0. |
| `/help` | — | `/help [command]` | List all available slash commands. If a command name is provided, show its detailed description. |
| `/info` | — | `/info` | Show the current turn count, active agent name, active model, and working directory. |
| `/agent` | — | `/agent [name]` | Without arguments, list all available agents. With a name, switch the active agent. History is preserved. |
| `/usage` | — | `/usage` | Show the cumulative input/output token counts and estimated cost for this session. |
| `/export` | — | `/export [filename]` | Save the full session conversation as a Markdown file. Defaults to `session-<timestamp>.md` in the current directory. |
| `/compact` | — | `/compact` | Manually trigger context compaction (summarize old messages). Useful before a long continuation. |

---

## 8. Common Interfaces

These interfaces are exported from their respective `types.ts` files and imported by any module that needs them. They are the shared language of the system.

### ResolvedConfig

The frozen, merged configuration object injected into all modules at startup.

```typescript
/**
 * The fully resolved, validated configuration for a CodeAgent session.
 * Produced by ConfigManager by merging (in priority order):
 *   project-local config → user-global config → env vars → CLI flags.
 * This object is frozen after construction and never mutated.
 */
export interface ResolvedConfig {
  /** Anthropic API key. Never logged or printed. */
  readonly apiKey: string

  /** Model identifier used for API calls (e.g. "claude-sonnet-4-6"). */
  readonly model: string

  /** Tool execution permission mode for this session. */
  readonly permissionMode: 'auto' | 'default' | 'deny'

  /** Maximum tool calls allowed per agentic loop turn. */
  readonly maxToolCalls: number

  /** Maximum characters returned by a single tool call. */
  readonly maxOutputChars: number

  /** Whether debug logging is enabled. */
  readonly debug: boolean

  /** Whether ANSI color output is disabled. */
  readonly noColor: boolean

  /** Absolute path to the working directory for this session. */
  readonly workingDir: string

  /** Absolute path to the user-global data directory (~/.codeagent). */
  readonly userDataDir: string
}
```

### CliArgs

The raw parsed CLI arguments before config resolution.

```typescript
/**
 * Raw CLI arguments parsed by Commander before config merging.
 * All fields are optional — defaults are applied during config resolution.
 */
export interface CliArgs {
  apiKey?: string
  model?: string
  permissionMode?: 'auto' | 'default' | 'deny'
  agent?: string
  /** Headless prompt string. If set, the REPL is not started. */
  print?: string
  debug?: boolean
  noColor?: boolean
}
```

### StreamEvent

A discriminated union representing all events emitted by `AnthropicClient.stream()`.

```typescript
/**
 * All events that can be yielded by AnthropicClient.stream().
 * Consumers must handle every variant via exhaustive switch.
 */
export type StreamEvent =
  | {
      /** A chunk of assistant text content, emitted incrementally. */
      type: 'text_delta'
      text: string
    }
  | {
      /**
       * A complete tool call with fully assembled input JSON.
       * Emitted after the stream ends and finalMessage() is processed.
       */
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
    }
  | {
      /** Token usage for the completed API call. */
      type: 'message_stop'
      usage: {
        input_tokens: number
        output_tokens: number
      }
    }
  | {
      /** A non-retryable API or network error. */
      type: 'error'
      message: string
      retryable: boolean
    }
```

### ToolResult

The return value of every tool execution.

```typescript
/**
 * The result returned by every tool after execution.
 * Tools NEVER throw — all errors are represented as ToolResult with isError: true.
 */
export interface ToolResult {
  /**
   * Text content to be returned to the model as a tool_result message.
   * On error, this contains the error description (not a stack trace).
   * Always capped at ResolvedConfig.maxOutputChars.
   */
  content: string

  /**
   * When true, the model is informed that the tool call failed.
   * The model may retry with corrected arguments or report to the user.
   */
  isError: boolean
}
```

### CodeAgentTool

The interface that all tools must implement.

```typescript
/**
 * The common interface for all CodeAgent tools (both built-in and plugin-provided).
 * Tools are registered in ToolDispatcher and exposed to the model as tool definitions.
 */
export interface CodeAgentTool<TInput = Record<string, unknown>> {
  /**
   * The tool name as passed to the Anthropic API.
   * Must be a valid identifier: lowercase, underscores, no spaces.
   * Example: "read_file", "bash", "glob"
   */
  name: string

  /** One-line description shown to the model in the tool definition. */
  description: string

  /**
   * JSON Schema object describing the tool's input parameters.
   * Used directly in the Anthropic API tools[] array.
   */
  inputSchema: Record<string, unknown>

  /**
   * Execute the tool with the given input.
   * Must never throw — return ToolResult with isError: true on failure.
   *
   * @param input - Validated input matching inputSchema
   * @param config - Session configuration (for maxOutputChars, workingDir, etc.)
   */
  execute(input: TInput, config: ResolvedConfig): Promise<ToolResult>
}
```

### CommandContext

The context object passed to every slash command handler.

```typescript
/**
 * Runtime context injected into every slash command handler.
 * Provides access to session state without requiring direct coupling
 * between commands and the ConversationController.
 */
export interface CommandContext {
  /** The currently active agent definition. */
  agent: AgentDefinition

  /** Current conversation history. Read-only — mutations must go through the controller. */
  readonly messages: ReadonlyArray<MessageParam>

  /** Cumulative token usage for this session. */
  readonly usage: UsageRecord

  /** Session configuration. */
  readonly config: ResolvedConfig

  /** Replace the conversation history (used by /clear). */
  resetMessages(): void

  /** Trigger context compaction (used by /compact). */
  compact(): Promise<void>

  /** Switch the active agent by name. */
  switchAgent(name: string): Promise<void>

  /** Print a line to stdout through the output renderer. */
  print(text: string): void
}
```

### AgentDefinition

The parsed and normalized representation of an agent.

```typescript
/**
 * A fully parsed agent definition.
 * Produced by AgentLoader from a Markdown file with YAML frontmatter,
 * or constructed directly for built-in agents.
 */
export interface AgentDefinition {
  /** Unique identifier used in /agent commands and --agent flag. */
  name: string

  /** Human-readable description shown in /agent listing. */
  description: string

  /**
   * Optional model override. When set, overrides ResolvedConfig.model
   * for all API calls while this agent is active.
   */
  model?: string

  /**
   * Optional tool allowlist. When set, only these tool names are available
   * to the model while this agent is active. When absent, all registered
   * tools are available.
   */
  tools?: string[]

  /**
   * The agent's system prompt (the Markdown body of the .md file,
   * or a plain string for built-in agents).
   */
  systemPrompt: string

  /**
   * Discovery source — used for diagnostics and display in /agent listing.
   * "builtin" | "user-global" | "project-local"
   */
  source: 'builtin' | 'user-global' | 'project-local'
}
```

### SessionStats

A snapshot of session metrics, used by `/usage`, `/info`, and the exit summary.

```typescript
/**
 * Snapshot of accumulated session metrics.
 * Produced by UsageTracker on demand.
 */
export interface SessionStats {
  /** Total input tokens consumed across all API calls in this session. */
  totalInputTokens: number

  /** Total output tokens produced across all API calls in this session. */
  totalOutputTokens: number

  /**
   * Estimated USD cost based on the model's published pricing.
   * This is an approximation — actual billing may differ.
   */
  estimatedCostUsd: number

  /** Number of conversation turns completed. */
  turnCount: number

  /** Total number of tool calls executed across all turns. */
  toolCallCount: number

  /** ISO 8601 timestamp of when the session started. */
  sessionStartedAt: string
}
```

---

## 9. Common Data Structures

### messages[] — Conversation History

The `messages` array is the canonical conversation history passed to every Anthropic API call. It contains `MessageParam` objects as defined by `@anthropic-ai/sdk`.

**Growth pattern per turn (with tool use):**

```
Before turn N:
  messages = [
    { role: 'user',      content: 'Previous question'         },
    { role: 'assistant', content: 'Previous answer'           },
    ...
  ]

After turn N (with one tool call):
  messages = [
    ...previous messages...,
    { role: 'user',      content: 'New question'                             },  // appended at turn start
    { role: 'assistant', content: [{ type: 'tool_use', id, name, input }]   },  // model's tool request
    { role: 'user',      content: [{ type: 'tool_result', tool_use_id, content }] },  // tool output
    { role: 'assistant', content: 'Final answer after seeing tool result'   },  // model's final reply
  ]
```

**Key invariants:**
- The array always alternates: `user`, `assistant`, `user`, `assistant`, ...
- It is never mutated in place — `ContextManager.append()` returns a new array.
- `/clear` replaces the reference with an empty array `[]`.
- Context compaction replaces the oldest entries with a summary message while preserving the last 20 messages verbatim.

### AgentDefinition — Fields and Semantics

| Field | Type | Semantics |
|-------|------|-----------|
| `name` | `string` | Primary key for lookup. Case-insensitive during search; stored as lowercase. |
| `description` | `string` | Shown in `/agent` listing. Should be one line. |
| `model` | `string \| undefined` | When set, this model is used instead of `ResolvedConfig.model`. Agent-level override has higher priority than config but lower than (future) per-request overrides. |
| `tools` | `string[] \| undefined` | Allowlist of tool names. `undefined` means all tools. An empty array `[]` means no tools (read-only mode). |
| `systemPrompt` | `string` | The full system prompt text. Combined with working directory context and CLAUDE.md content by `buildSystemPrompt()`. |
| `source` | `'builtin' \| 'user-global' \| 'project-local'` | Discovery origin. Higher priority sources shadow lower priority ones with the same `name`. |

### ResolvedConfig — All Fields and Defaults

| Field | Type | Default | Source |
|-------|------|---------|--------|
| `apiKey` | `string` | — (required) | `ANTHROPIC_API_KEY` env var or `--api-key` flag |
| `model` | `string` | `claude-sonnet-4-6` | `CODEAGENT_MODEL` → config file → `--model` |
| `permissionMode` | `'auto' \| 'default' \| 'deny'` | `'default'` | `CODEAGENT_PERMISSION_MODE` → config file → `--permission-mode` |
| `maxToolCalls` | `number` | `25` | `CODEAGENT_MAX_TOOL_CALLS` → config file |
| `maxOutputChars` | `number` | `100000` | `CODEAGENT_MAX_OUTPUT_CHARS` → config file |
| `debug` | `boolean` | `false` | `CODEAGENT_DEBUG` → `--debug` |
| `noColor` | `boolean` | `false` | `--no-color` or `NO_COLOR` env var (convention) |
| `workingDir` | `string` | `process.cwd()` at startup | Not configurable after startup |
| `userDataDir` | `string` | `~/.codeagent` | Derived from `os.homedir()` |

### ToolResult — Fields and Error Semantics

| Field | Type | Description |
|-------|------|-------------|
| `content` | `string` | The text content returned to the model. On success: the tool output. On error: an English description of the failure that the model can reason about. Never a raw stack trace. |
| `isError` | `boolean` | When `true`, the Anthropic SDK marks this as a failed tool call. The model typically acknowledges the failure and may retry with different arguments or inform the user. |

**Output truncation:** `content` is always capped at `ResolvedConfig.maxOutputChars`. When truncated, a suffix is appended: `\n[Output truncated at ${maxOutputChars} characters]`.

**Path traversal:** If a file tool is given a path that resolves outside `ResolvedConfig.workingDir`, it immediately returns `{ content: 'Error: Path is outside the working directory', isError: true }` without touching the filesystem.

### UsageRecord — Token Counts and Cumulative Totals

```typescript
/**
 * Accumulated token usage across all API calls in a session.
 * Updated by UsageTracker after every successful API call.
 */
export interface UsageRecord {
  /** Running total of all input tokens sent to the API. */
  totalInputTokens: number

  /** Running total of all output tokens received from the API. */
  totalOutputTokens: number

  /**
   * Per-turn breakdown. Each entry represents one call to AnthropicClient.stream().
   * Multiple calls may occur per user turn (agentic loop).
   */
  turns: Array<{
    inputTokens: number
    outputTokens: number
    /** ISO 8601 timestamp of when this API call completed. */
    completedAt: string
  }>
}
```

The `UsageTracker` is the single source of truth for token counts. It is updated by `ConversationController` after each `message_stop` event from `AnthropicClient.stream()`. It is read by `SessionStats`, the `/usage` command, and the exit summary.

---

## 10. Error Handling Strategy

This section defines the canonical error handling behavior for every failure mode in the system. Deviating from these patterns requires explicit justification.

### Tool Errors — Never Throw

Tools must always return a `ToolResult`. They never throw or propagate exceptions.

```typescript
// CORRECT: Return error as ToolResult
async execute(input, config): Promise<ToolResult> {
  try {
    const content = await fs.readFile(resolvedPath, 'utf-8')
    return { content, isError: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { content: `Error reading file: ${message}`, isError: true }
  }
}

// WRONG: Throwing from a tool
async execute(input, config): Promise<ToolResult> {
  const content = await fs.readFile(resolvedPath, 'utf-8')  // throws on failure!
  return { content, isError: false }
}
```

**Rationale:** The agentic loop must continue executing other pending tool calls even if one fails. A thrown exception would abort the entire turn.

### API Errors — Retryable vs Non-Retryable

`AnthropicClient` classifies HTTP errors into two categories:

| HTTP Status | Classification | Behavior |
|-------------|---------------|----------|
| 429 (rate limit) | Retryable | Exponential backoff: wait `1s × 2^attempt`, max 3 retries |
| 529 (overloaded) | Retryable | Same backoff strategy |
| 401 (unauthorized) | Non-retryable | Emit `StreamEvent { type: 'error', retryable: false }` |
| 400 (bad request) | Non-retryable | Emit error event immediately |
| Network timeout | Retryable | Up to 3 retries |
| All others (5xx) | Retryable up to 3× | Then emit non-retryable error |

After exhausting retries, `ConversationController` receives a `StreamEvent` of type `error` and prints a user-facing error message. The session continues — the user may try again.

### Config Errors — Fail Fast

Configuration validation errors at startup are fatal. The process exits immediately with a clear, actionable error message:

```
Error: ANTHROPIC_API_KEY is required but was not set.
  Set it with: export ANTHROPIC_API_KEY="sk-ant-..."
  Or pass it with: codeagent --api-key "sk-ant-..."
```

No partial config is ever used. Either all required values are present and valid, or the process exits.

### Permission Denial — Return as ToolResult

When the `PermissionGuard` denies a tool call, it returns a `ToolResult` with `isError: false` and a denial message:

```typescript
{ content: 'Permission denied by user.', isError: false }
```

Using `isError: false` is intentional — the denial is not an execution error, it is a user policy decision. The model receives this signal and typically informs the user that it cannot proceed.

### User-Facing Error Format

All errors printed to the terminal follow this format:

```
<bold red>Error:</> <actionable message>
```

Errors never include stack traces in user-facing output. Stack traces go to the debug log only (when `--debug` is set). The actionable message must tell the user what to do, not just what went wrong.

Examples:

```
Error: Model "claude-unknown-99" is not recognized. Use --model to specify a valid model name.
Error: Could not read file "src/app.ts": file not found.
Error: Anthropic API rate limit exceeded. Retrying in 2 seconds...
```

---

## 11. Feature Design Files Index

Each `DESIGN_F#.md` file contains the detailed implementation design for a group of related features. All files live in the `docs/` directory alongside this document.

| File | Features | Description |
|------|----------|-------------|
| [DESIGN_F1.md](./DESIGN_F1.md) | F1, F13, F18 | CLI entrypoint (`src/cli/`), the infinite REPL loop, headless/piped-stdin mode, and multi-line paste input mode. |
| [DESIGN_F2.md](./DESIGN_F2.md) | F2, F19 | Anthropic API streaming client (`src/api/AnthropicClient.ts`), SSE event processing, and exponential-backoff retry logic. |
| [DESIGN_F3.md](./DESIGN_F3.md) | F3, F17, F20, F22 | Core tool system (`ReadFile`, `WriteFile`, `Bash`), output size cap and path traversal guards, per-turn tool call rate limiter, and bash environment isolation with subprocess cleanup. |
| [DESIGN_F4.md](./DESIGN_F4.md) | F4, F12, F27 | `ContextManager` (immutable messages array), multi-turn memory compaction strategy, and smart summarization via a secondary API call. |
| [DESIGN_F5.md](./DESIGN_F5.md) | F5, F21 | `PermissionGuard` with `auto` / `default` / `deny` modes and a serialized readline prompt queue to prevent concurrent terminal conflicts. |
| [DESIGN_F6.md](./DESIGN_F6.md) | F6, F30 | `ConfigManager`: multi-source merge (project-local → user-global → env vars → CLI flags), Zod schema validation, config persistence, and project-local `.codeagent/config.json` support. |
| [DESIGN_F7.md](./DESIGN_F7.md) | F7, F24, F28 | `OutputRenderer` (live streaming + markdown-to-ANSI), `UsageTracker` (token counting and cost estimation), and `Logger` (debug log file). |
| [DESIGN_F8.md](./DESIGN_F8.md) | F8 | `SlashCommandEngine` dispatch table, `CommandContext` injection, registration pattern for new commands, and implementation of all built-in slash commands. |
| [DESIGN_F9.md](./DESIGN_F9.md) | F9, F10, F23 | Extended tools: `GlobTool`, `GrepTool`, `EditFileTool` (surgical patch with exact-string replacement), and unified diff preview before applying file changes. |
| [DESIGN_F11.md](./DESIGN_F11.md) | F11, F25 | `ProjectContextLoader`: discovery and reading of `CLAUDE.md`, size cap, system prompt composition order, and injection scope rules (survives agent switches). |
| [DESIGN_F14.md](./DESIGN_F14.md) | F14 | Git-aware context injection: current branch, `git status` summary, and recent `git diff` appended to the system prompt when a `.git` directory is detected. |
| [DESIGN_F15.md](./DESIGN_F15.md) | F15, F29 | MCP (Model Context Protocol) server support, plugin discovery and loading, tool registration from external packages, and sub-agent delegation pattern (`/delegate`). |
| [DESIGN_F16.md](./DESIGN_F16.md) | F16 | Agent system: `AgentLoader` (YAML frontmatter parsing), `AgentRegistry` (multi-source discovery with priority shadowing), `AgentManager` (session-level active agent), and the six built-in agent definitions. |
| [DESIGN_F26.md](./DESIGN_F26.md) | F26 | Session history persistence to `~/.codeagent/history/`, `/export` Markdown serialization, and history replay. |

---

*For architecture diagrams and data flow sequences, see [PLAN.md](./PLAN.md).*
