# DESIGN_F26 — Session History, Export, and Persistence (F26)

> Covers persistent conversation history across process restarts, crash recovery, session export to Markdown, and integration with ConversationController.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Session History Schema](#2-session-history-schema)
3. [SessionStats Interface](#3-sessionstats-interface)
4. [src/conversation/SessionHistory.ts](#4-srcconversationsessionhistoryts)
5. [Session Export — ExportCommand](#5-session-export--exportcommand)
6. [SessionExporter](#6-sessionexporter)
7. [Integration with ConversationController](#7-integration-with-conversationcontroller)
8. [--resume Flag](#8---resume-flag)
9. [Retention Policy](#9-retention-policy)
10. [Test Cases](#10-test-cases)

---

## 1. Overview

Phase 3 adds persistence at two levels:

1. **Automatic session history** — every conversation is saved to disk after each turn. If the process crashes mid-session, the user can resume from where they left off using `--resume`. On clean exit, the session is finalized with end time and full stats.

2. **Session export** — the `/export` command converts the current session's message history into a human-readable Markdown file. Useful for sharing, archiving, or reviewing conversations outside the CLI.

Both features are additive. A session with no `--resume` flag and no `/export` invocation behaves identically to Phase 2. The auto-save runs silently after each turn; the user never sees it unless they look in `~/.codeagent/history/`.

### Directory layout

```
~/.codeagent/
├── history/
│   ├── session-2026-04-05T10-23-41Z.json   # active or past session files
│   ├── session-2026-04-04T18-11-02Z.json
│   └── ...                                  # at most 50 files kept
└── exports/
    ├── export-2026-04-05T10-30-00Z.md
    └── ...
```

---

## 2. Session History Schema

Each session is serialized as a single JSON file. The schema is intentionally flat for easy inspection with any JSON tool.

```typescript
// src/conversation/SessionHistory.ts

import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js'

/**
 * The complete serialized form of a single session.
 * Written to disk after every turn (partial) and at exit (finalized).
 */
export interface SessionRecord {
  /** UUID v4 generated at session creation. Stable across saves. */
  readonly id: string

  /**
   * ISO 8601 timestamp of when the session was created.
   * Example: "2026-04-05T10:23:41.000Z"
   */
  readonly startedAt: string

  /**
   * The Claude model identifier in use at session end.
   * Reflects the agent model if an agent with model override was active at exit.
   * Example: "claude-sonnet-4-6"
   */
  readonly model: string

  /**
   * The name of the active agent when the session was last saved.
   * May differ from the agent that was active at the start of the session
   * if /agent was used mid-session.
   */
  readonly agent: string

  /**
   * Full conversation history at the time of saving.
   * This is the raw messages[] array from ContextManager — the same array
   * that would be sent to the Anthropic API on the next turn.
   * Compatible with @anthropic-ai/sdk MessageParam[].
   */
  readonly messages: MessageParam[]

  /**
   * Cumulative usage statistics for the session.
   * Populated after every turn and finalized on exit.
   */
  readonly stats: SessionStats
}
```

### File naming

Session files are named using the session's `startedAt` timestamp with colons replaced by hyphens (to satisfy Windows filesystem constraints and avoid quoting in shells):

```
session-<ISO-timestamp>.json
session-2026-04-05T10-23-41Z.json
```

The timestamp-based name ensures lexicographic sort == chronological sort, which `loadLast()` relies on.

---

## 3. SessionStats Interface

```typescript
/**
 * Accumulated statistics for a session.
 *
 * All token counts are cumulative across all turns and all agentic loop
 * iterations within each turn. They are sourced from the usage field of
 * each Anthropic API response.
 */
export interface SessionStats {
  /**
   * ISO 8601 timestamp of when the session started.
   * Duplicated from SessionRecord.startedAt for standalone usability.
   */
  readonly startedAt: string

  /**
   * ISO 8601 timestamp of when the session ended (process exited cleanly).
   * Undefined while the session is still active (intermediate saves).
   * Set to the current time on clean exit or /exit command.
   */
  endedAt?: string

  /**
   * Number of complete user-assistant exchanges.
   * Incremented after each successful handleInput() call.
   */
  readonly turnCount: number

  /**
   * Total input tokens billed across all API calls in this session.
   * Includes system prompt tokens, conversation history tokens, and
   * tool definitions on every call.
   */
  readonly totalInputTokens: number

  /**
   * Total output tokens billed across all API calls in this session.
   * Includes all streamed text and tool call content.
   */
  readonly totalOutputTokens: number

  /**
   * Estimated cost in USD using Anthropic's published per-token pricing.
   * Calculated as:
   *   (totalInputTokens / 1_000_000) * INPUT_PRICE_PER_MTOK
   *   + (totalOutputTokens / 1_000_000) * OUTPUT_PRICE_PER_MTOK
   *
   * Note: this is an estimate. The actual billed amount may differ due to
   * prompt caching, batch API discounts, or pricing changes.
   */
  readonly estimatedCostUsd: number

  /**
   * Ordered list of agent names used during the session.
   * The first entry is always the initial agent.
   * Subsequent entries are added when /agent switches occur.
   * Duplicates are suppressed: consecutive identical entries are not recorded.
   *
   * Example: ["default", "code-reviewer", "default"]
   * Interpretation: started as default, switched to code-reviewer, switched back.
   */
  readonly agentsUsed: string[]
}
```

---

## 4. src/conversation/SessionHistory.ts

`SessionHistory` is the service responsible for reading, writing, and managing session files on disk. It is created once by `ConversationController` and called after every turn.

```typescript
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import type { SessionRecord, SessionStats } from './types.js'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js'

const HISTORY_DIR = path.join(os.homedir(), '.codeagent', 'history')
const MAX_RETAINED_SESSIONS = 50

/**
 * SessionHistory
 *
 * Manages automatic persistence of conversation sessions.
 *
 * Lifecycle:
 *   1. Constructed at ConversationController startup — generates session ID
 *      and opens the history directory (creates it if absent).
 *   2. save() is called after every handleInput() with the current messages[]
 *      and accumulated stats. This ensures crash recovery is always possible.
 *   3. finalize() is called on clean exit — writes endedAt timestamp.
 *   4. cleanup() is called at startup (before the session begins) to enforce
 *      the 50-session retention limit.
 *
 * File writes use an atomic write pattern: write to a .tmp file, then rename.
 * This prevents partially-written files from appearing as valid sessions.
 */
export class SessionHistory {
  private readonly sessionId: string
  private readonly startedAt: string
  private readonly filePath: string

  constructor() {
    this.sessionId = crypto.randomUUID()
    this.startedAt = new Date().toISOString()
    const fileTimestamp = this.startedAt.replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z')
    this.filePath = path.join(HISTORY_DIR, `session-${fileTimestamp}.json`)
  }

  /**
   * Initialize the history directory and run retention cleanup.
   * Must be called once before the first save().
   */
  async init(): Promise<void> {
    await fs.mkdir(HISTORY_DIR, { recursive: true })
    await this.cleanup()
  }

  /**
   * save()
   *
   * Serializes the current session state to disk.
   * Called after every turn for crash recovery.
   *
   * Uses atomic rename to prevent partial writes:
   *   1. Write complete JSON to <filePath>.tmp
   *   2. Rename .tmp → final path (atomic on POSIX filesystems)
   *
   * Write errors are caught and logged as warnings — a persistence failure
   * must never interrupt the active conversation.
   *
   * @param messages  Current messages[] from ContextManager.
   * @param stats     Current accumulated stats from UsageTracker.
   * @param model     The model active at the time of this save.
   * @param agent     The agent name active at the time of this save.
   */
  async save(
    messages: readonly MessageParam[],
    stats: SessionStats,
    model: string,
    agent: string
  ): Promise<void> {
    const record: SessionRecord = {
      id: this.sessionId,
      startedAt: this.startedAt,
      model,
      agent,
      messages: messages as MessageParam[],
      stats,
    }

    const tmpPath = `${this.filePath}.tmp`
    try {
      await fs.writeFile(tmpPath, JSON.stringify(record, null, 2), 'utf-8')
      await fs.rename(tmpPath, this.filePath)
    } catch (error) {
      console.warn(`[SessionHistory] Failed to save session: ${String(error)}`)
      // Attempt to clean up the .tmp file but don't throw if that fails too
      await fs.unlink(tmpPath).catch(() => undefined)
    }
  }

  /**
   * finalize()
   *
   * Writes the final session record with endedAt timestamp.
   * Called on clean exit (Ctrl+D, /exit, /quit).
   */
  async finalize(
    messages: readonly MessageParam[],
    stats: SessionStats,
    model: string,
    agent: string
  ): Promise<void> {
    const finalStats: SessionStats = {
      ...stats,
      endedAt: new Date().toISOString(),
    }
    await this.save(messages, finalStats, model, agent)
  }

  /**
   * loadLast()
   *
   * Returns the most recent session record from the history directory,
   * or undefined if no sessions exist.
   *
   * Used by --resume to restore a previous session's messages[].
   * The most recent session is determined by filename (lexicographic sort
   * == chronological sort because of the ISO timestamp naming convention).
   */
  static async loadLast(): Promise<SessionRecord | undefined> {
    let files: string[]
    try {
      const entries = await fs.readdir(HISTORY_DIR)
      files = entries
        .filter((f) => f.startsWith('session-') && f.endsWith('.json'))
        .sort()
        .reverse()
    } catch {
      return undefined // History directory does not exist
    }

    for (const file of files) {
      try {
        const raw = await fs.readFile(path.join(HISTORY_DIR, file), 'utf-8')
        return JSON.parse(raw) as SessionRecord
      } catch {
        // File is corrupt or partially written — try the next one
        continue
      }
    }

    return undefined
  }

  /**
   * list()
   *
   * Returns all session records sorted from newest to oldest.
   * Unreadable or corrupt files are silently skipped.
   *
   * Suitable for a future /history list command.
   */
  static async list(): Promise<SessionRecord[]> {
    let files: string[]
    try {
      const entries = await fs.readdir(HISTORY_DIR)
      files = entries
        .filter((f) => f.startsWith('session-') && f.endsWith('.json'))
        .sort()
        .reverse()
    } catch {
      return []
    }

    const results: SessionRecord[] = []
    for (const file of files) {
      try {
        const raw = await fs.readFile(path.join(HISTORY_DIR, file), 'utf-8')
        results.push(JSON.parse(raw) as SessionRecord)
      } catch {
        continue
      }
    }
    return results
  }

  /**
   * cleanup()
   *
   * Deletes session files beyond the MAX_RETAINED_SESSIONS limit.
   * Called once at session init, before writing the new session's first save.
   *
   * Deletion order: oldest files first (ascending sort = oldest first).
   * At most MAX_RETAINED_SESSIONS files are kept after cleanup.
   */
  private async cleanup(): Promise<void> {
    let files: string[]
    try {
      const entries = await fs.readdir(HISTORY_DIR)
      files = entries
        .filter((f) => f.startsWith('session-') && f.endsWith('.json'))
        .sort() // ascending = oldest first
    } catch {
      return
    }

    const excess = files.length - MAX_RETAINED_SESSIONS
    if (excess <= 0) {
      return
    }

    const toDelete = files.slice(0, excess)
    for (const file of toDelete) {
      await fs.unlink(path.join(HISTORY_DIR, file)).catch(() => undefined)
    }
  }
}
```

---

## 5. Session Export — ExportCommand

The `/export` slash command converts the current session's message history into a Markdown file. The file is written to `~/.codeagent/exports/` and the path is printed to the terminal.

```typescript
// src/commands/built-in/ExportCommand.ts

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import type { SlashCommand, CommandContext } from '../types.js'
import { SessionExporter } from '../../conversation/SessionExporter.js'

const EXPORTS_DIR = path.join(os.homedir(), '.codeagent', 'exports')

/**
 * ExportCommand
 *
 * Syntax:  /export [--stdout]
 *
 * Without --stdout: writes to ~/.codeagent/exports/export-<timestamp>.md
 *                   and prints the file path.
 * With --stdout:    writes Markdown to stdout. Useful for piping:
 *                     /export --stdout | pbcopy
 *                     /export --stdout > my-session.md
 */
export class ExportCommand implements SlashCommand {
  readonly name = 'export'
  readonly description = 'Export this session as a Markdown file'
  readonly usage = '/export [--stdout]'

  async execute(args: string, ctx: CommandContext): Promise<void> {
    const toStdout = args.trim() === '--stdout'

    const messages = ctx.conversationContext.messages
    const stats = ctx.usageTracker.currentStats()
    const agent = ctx.agentManager.current.name
    const model = ctx.config.model

    const markdown = SessionExporter.toMarkdown(messages, stats, { model, agent })

    if (toStdout) {
      process.stdout.write(markdown)
      return
    }

    await fs.mkdir(EXPORTS_DIR, { recursive: true })

    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z')
    const fileName = `export-${timestamp}.md`
    const filePath = path.join(EXPORTS_DIR, fileName)

    try {
      await fs.writeFile(filePath, markdown, 'utf-8')
      ctx.output.writeLine(`Session exported to: ${filePath}`)
    } catch (error) {
      ctx.output.writeLine(`Export failed: ${String(error)}`)
    }
  }
}
```

---

## 6. SessionExporter

`SessionExporter` is a pure function module — no I/O, no side effects. It converts a `MessageParam[]` array and `SessionStats` into a Markdown string. Keeping it pure makes it trivial to test.

```typescript
// src/conversation/SessionExporter.ts

import type { MessageParam, ContentBlock } from '@anthropic-ai/sdk/resources/messages.js'
import type { SessionStats } from './types.js'

const TOOL_RESULT_MAX_CHARS = 500

export interface ExportOptions {
  readonly model: string
  readonly agent: string
}

/**
 * SessionExporter
 *
 * Converts a message history and session stats into a human-readable
 * Markdown document suitable for sharing and archiving.
 *
 * Output structure:
 *
 *   # Session Export
 *   Date: ...  Model: ...  Agent: ...
 *
 *   ## Stats
 *   | Field | Value |
 *   ...
 *
 *   ## Conversation
 *
 *   **User:** ...
 *
 *   **Assistant:** ...
 *
 *   **Tool:** read_file → (truncated result or error)
 *
 *   **Assistant:** ...
 */
export const SessionExporter = {
  /**
   * toMarkdown
   *
   * Pure function. Produces the complete Markdown export string.
   *
   * Tool results are truncated to TOOL_RESULT_MAX_CHARS (500 chars) to keep
   * exports readable. A "(truncated)" note is appended when truncation occurs.
   *
   * Agent switches (if any) are recorded in the stats section via agentsUsed[].
   */
  toMarkdown(
    messages: readonly MessageParam[],
    stats: SessionStats,
    options: ExportOptions
  ): string {
    const sections: string[] = []

    // Header
    sections.push(
      `# Session Export\n\n` +
      `**Date:** ${stats.startedAt}  \n` +
      `**Model:** ${options.model}  \n` +
      `**Agent:** ${options.agent}  \n`
    )

    // Stats table
    const endedRow = stats.endedAt !== undefined
      ? `| Session ended | ${stats.endedAt} |`
      : ''

    sections.push(
      `## Stats\n\n` +
      `| Metric | Value |\n` +
      `|--------|-------|\n` +
      `| Session started | ${stats.startedAt} |\n` +
      (endedRow.length > 0 ? `${endedRow}\n` : '') +
      `| Turns | ${stats.turnCount} |\n` +
      `| Input tokens | ${stats.totalInputTokens.toLocaleString()} |\n` +
      `| Output tokens | ${stats.totalOutputTokens.toLocaleString()} |\n` +
      `| Estimated cost | $${stats.estimatedCostUsd.toFixed(4)} |\n` +
      `| Agents used | ${stats.agentsUsed.join(' -> ')} |\n`
    )

    // Conversation
    const conversationLines: string[] = ['## Conversation\n']

    for (const message of messages) {
      if (message.role === 'user') {
        const userContent = extractUserContent(message.content)
        conversationLines.push(`**User:** ${userContent}\n`)
      } else if (message.role === 'assistant') {
        const assistantContent = extractAssistantContent(message.content)
        for (const block of assistantContent) {
          conversationLines.push(block)
        }
      }
    }

    sections.push(conversationLines.join('\n'))

    return sections.join('\n---\n\n')
  },
}

/**
 * Extracts printable text from a user message's content.
 * User messages may contain plain strings or ContentBlock arrays
 * (when they include tool_result blocks).
 */
function extractUserContent(
  content: MessageParam['content']
): string {
  if (typeof content === 'string') {
    return content
  }

  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text)
    } else if (block.type === 'tool_result') {
      const toolId = block.tool_use_id
      const resultContent = Array.isArray(block.content)
        ? block.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('')
        : (block.content as string | undefined) ?? ''
      const truncated = truncate(resultContent, TOOL_RESULT_MAX_CHARS)
      const isError = block.is_error === true ? ' [ERROR]' : ''
      parts.push(`**Tool result** (${toolId})${isError}: ${truncated}`)
    }
  }

  return parts.join('\n\n')
}

/**
 * Extracts printable lines from an assistant message's content.
 * Assistant messages may contain text blocks and tool_use blocks.
 */
function extractAssistantContent(content: MessageParam['content']): string[] {
  if (typeof content === 'string') {
    return [`**Assistant:** ${content}\n`]
  }

  const lines: string[] = []
  for (const block of content as ContentBlock[]) {
    if (block.type === 'text' && block.text.trim().length > 0) {
      lines.push(`**Assistant:** ${block.text.trim()}\n`)
    } else if (block.type === 'tool_use') {
      const inputStr = truncate(JSON.stringify(block.input, null, 2), TOOL_RESULT_MAX_CHARS)
      lines.push(`**Tool:** ${block.name} -> \`\`\`\n${inputStr}\n\`\`\`\n`)
    }
  }

  return lines
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text
  }
  return text.slice(0, maxChars) + `\n... (truncated, ${text.length - maxChars} chars omitted)`
}
```

### Export Markdown example

```markdown
# Session Export

**Date:** 2026-04-05T10:23:41.000Z
**Model:** claude-sonnet-4-6
**Agent:** code-reviewer

---

## Stats

| Metric | Value |
|--------|-------|
| Session started | 2026-04-05T10:23:41.000Z |
| Session ended | 2026-04-05T10:45:02.000Z |
| Turns | 4 |
| Input tokens | 24,301 |
| Output tokens | 3,892 |
| Estimated cost | $0.0421 |
| Agents used | default -> code-reviewer |

---

## Conversation

**User:** Review src/agents/AgentLoader.ts

**Tool:** read_file -> ```
{
  "path": "src/agents/AgentLoader.ts"
}
```

**Tool result** (tolu_01abc): import * as fs from 'node:fs/promises'
... (truncated, 4832 chars omitted)

**Assistant:** The `AgentLoader.ts` module is well-structured. Here are my findings:

**MEDIUM** — The `parseFrontmatterLines` function silently skips unrecognized
line formats. Consider logging a warning when a line cannot be parsed, so users
can diagnose typos in their agent files more easily.
```

---

## 7. Integration with ConversationController

`ConversationController` owns the `SessionHistory` instance and drives the save lifecycle.

```typescript
// Relevant additions to src/conversation/ConversationController.ts

export class ConversationController {
  private readonly sessionHistory: SessionHistory
  private readonly usageTracker: UsageTracker
  // ... other fields

  constructor(options: ConversationControllerOptions) {
    // ... existing construction

    this.sessionHistory = new SessionHistory()
    // init() is called once, asynchronously, during the first handleInput()
    // or at REPL startup before the first prompt.
  }

  /**
   * Called once at REPL startup (before showing the first prompt).
   * Initializes the history directory and runs retention cleanup.
   */
  async initialize(): Promise<void> {
    await this.sessionHistory.init()
    // ... other async init (project context loading, etc.)
  }

  /**
   * handleInput — modified to save session after each turn.
   */
  async handleInput(input: string): Promise<void> {
    // ... existing: parse slash commands or route to agentic loop

    // After the turn completes (whether via tool loop or plain response):
    await this.sessionHistory.save(
      this.contextManager.messages,
      this.usageTracker.currentStats(),
      this.resolveCurrentModel(),
      this.agentManager.current.name
    )
  }

  /**
   * shutdown — called on clean exit (Ctrl+D, /exit, /quit).
   * Writes the final session file with endedAt timestamp.
   */
  async shutdown(): Promise<void> {
    await this.sessionHistory.finalize(
      this.contextManager.messages,
      this.usageTracker.currentStats(),
      this.resolveCurrentModel(),
      this.agentManager.current.name
    )
    // ... print usage summary, etc.
  }

  /**
   * Resolves the effective model for the current active agent.
   * Used when saving the session record to capture the model at save time.
   */
  private resolveCurrentModel(): string {
    return this.agentManager.current.model ?? this.config.model
  }
}
```

### Save timing

| Event | Action |
|---|---|
| `initialize()` (startup) | Creates history dir, runs cleanup |
| After each `handleInput()` | `sessionHistory.save()` — intermediate record, no `endedAt` |
| `shutdown()` (clean exit) | `sessionHistory.finalize()` — sets `endedAt` |
| Process crash / SIGKILL | Last successful `save()` record is used for resume |

---

## 8. --resume Flag

The `--resume` CLI flag loads the most recent session file and restores its `messages[]` into the new session's `ContextManager`. This allows the user to continue a previous conversation as if the process had never exited.

```typescript
// src/cli/args.ts

export interface ParsedArgs {
  // ... existing fields
  /** If true, load the most recent session from history before starting the REPL. */
  resume: boolean
}

// src/cli/index.ts — in main()

if (args.resume) {
  const lastSession = await SessionHistory.loadLast()
  if (lastSession === undefined) {
    console.error('No previous session found to resume.')
  } else {
    // Restore messages into ContextManager
    contextManager = ContextManager.fromMessages(lastSession.messages)
    // Print a banner so the user knows they are in a resumed session
    console.log(
      `Resumed session from ${lastSession.startedAt} ` +
      `(${lastSession.stats.turnCount} turns, agent: ${lastSession.agent})`
    )
  }
}
```

The restored `messages[]` is injected into the new session's `ContextManager` via a static factory method:

```typescript
// Addition to src/conversation/ContextManager.ts

/**
 * fromMessages
 *
 * Creates a ContextManager pre-populated with an existing message history.
 * Used exclusively by the --resume flow to restore a previous session.
 *
 * Returns a new ContextManager instance — immutable construction, no mutation.
 */
static fromMessages(messages: readonly MessageParam[]): ContextManager {
  return new ContextManager([...messages])
}
```

### Resume behavior

- The resumed session gets a **new** session ID and a new file in `~/.codeagent/history/`.
- The old session file is not modified.
- The new session's stats start at zero (turn count 0, tokens 0).
- The agent from the previous session is **not** automatically restored — the new session uses the agent specified by `--agent` (or `default`). The user may switch agents after resuming.

---

## 9. Retention Policy

The history directory is kept to at most 50 session files. Cleanup runs once at startup in `SessionHistory.init()`, before the new session's first save.

```
Retention rules:
  - Files are sorted by name (ascending = oldest first)
  - If count > 50, delete the oldest (count - 50) files
  - Deletion failures are silently ignored (e.g., concurrent cleanup)
  - The current session's file is not yet present during cleanup,
    so after cleanup + the new session file, the directory holds at most 51 files
    momentarily, then exactly 50 after the new file is counted at next startup.
```

Users who want to keep more history can move files out of `~/.codeagent/history/` or copy them elsewhere. The export command (`/export`) is the recommended path for long-term archiving.

---

## 10. Test Cases

### 10.1 SessionHistory — save and reload

```typescript
describe('SessionHistory', () => {
  it('saves a valid JSON file to the history directory', async () => {
    const history = new SessionHistory()
    await history.init()
    await history.save([], makeStats(), 'claude-sonnet-4-6', 'default')
    // Assert file exists and is valid JSON
  })

  it('loadLast() returns the most recent session', async () => {
    // Create two sessions with different startedAt values
    // Expect loadLast() to return the later one
  })

  it('loadLast() returns undefined when history directory is empty', async () => {
    const result = await SessionHistory.loadLast()
    expect(result).toBeUndefined()
  })

  it('finalize() writes endedAt to the session record', async () => {
    const history = new SessionHistory()
    await history.init()
    await history.finalize([], makeStats(), 'claude-sonnet-4-6', 'default')
    const loaded = await SessionHistory.loadLast()
    expect(loaded?.stats.endedAt).toBeDefined()
  })

  it('save() does not throw when write fails — logs warning instead', async () => {
    // Mock fs.writeFile to throw EACCES
    // Expect save() to resolve (not reject) and console.warn to be called
  })

  it('uses atomic rename — no partial file visible during write', async () => {
    // Verify that .tmp file is cleaned up after successful save
    // Verify that .tmp file is cleaned up after failed save
  })
})
```

### 10.2 Retention cleanup

```typescript
describe('SessionHistory cleanup', () => {
  it('deletes oldest files when count exceeds 50', async () => {
    // Create 55 fake session files in temp history dir
    const history = new SessionHistory()
    await history.init()
    const remaining = await fs.readdir(HISTORY_DIR)
    // 55 old files - 5 deleted = 50 remaining
    expect(remaining.filter((f) => f.endsWith('.json'))).toHaveLength(50)
  })

  it('does nothing when file count is below 50', async () => {
    // Create 10 fake session files
    // Expect all 10 to remain after cleanup
  })
})
```

### 10.3 SessionExporter — toMarkdown

```typescript
describe('SessionExporter.toMarkdown', () => {
  it('includes header with model, agent, and date', () => {
    const md = SessionExporter.toMarkdown([], makeStats(), { model: 'opus', agent: 'default' })
    expect(md).toContain('**Model:** opus')
    expect(md).toContain('**Agent:** default')
  })

  it('formats user messages with **User:** prefix', () => {
    const messages: MessageParam[] = [{ role: 'user', content: 'Hello' }]
    const md = SessionExporter.toMarkdown(messages, makeStats(), { model: 'x', agent: 'y' })
    expect(md).toContain('**User:** Hello')
  })

  it('truncates tool results longer than 500 chars', () => {
    const longContent = 'x'.repeat(600)
    // Build a message with a tool_result block containing longContent
    const md = SessionExporter.toMarkdown(messages, makeStats(), { model: 'x', agent: 'y' })
    expect(md).toContain('(truncated,')
    expect(md).not.toContain('x'.repeat(501))
  })

  it('includes agentsUsed in stats with arrow separator', () => {
    const stats = { ...makeStats(), agentsUsed: ['default', 'code-reviewer'] }
    const md = SessionExporter.toMarkdown([], stats, { model: 'x', agent: 'y' })
    expect(md).toContain('default -> code-reviewer')
  })

  it('produces valid output for an empty message history', () => {
    const md = SessionExporter.toMarkdown([], makeStats(), { model: 'x', agent: 'y' })
    expect(md).toContain('# Session Export')
    expect(md).toContain('## Stats')
    expect(md).toContain('## Conversation')
  })
})
```

### 10.4 --resume integration

```typescript
describe('--resume flag', () => {
  it('restores messages from last session into ContextManager', async () => {
    // Save a session with 3 messages
    // Call main() with --resume
    // Expect ContextManager.messages to have 3 entries
  })

  it('starts fresh stats even when messages are restored', async () => {
    // After resume, usageTracker.currentStats().turnCount === 0
  })

  it('prints a resume banner with session info', async () => {
    // Expect stdout to contain "Resumed session from ..."
  })
})
```

### 10.5 ExportCommand

```typescript
describe('ExportCommand', () => {
  it('writes a .md file to the exports directory', async () => {
    // Call execute('', ctx) where ctx has messages and stats
    // Expect a file to exist in EXPORTS_DIR
    // Expect ctx.output.writeLine to have been called with the file path
  })

  it('writes to stdout when --stdout flag is passed', async () => {
    // Spy on process.stdout.write
    // Call execute('--stdout', ctx)
    // Expect process.stdout.write to have been called with Markdown content
    // Expect no file to have been written
  })
})
```
