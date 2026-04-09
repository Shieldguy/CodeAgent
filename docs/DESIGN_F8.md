# DESIGN_F8 — Slash Command Engine (F8)

> Feature: F8 (Slash Command Engine)
> Phase: 2
> Modules: `src/commands/types.ts`, `src/commands/SlashCommandEngine.ts`, `src/commands/built-in/`

---

## 1. Purpose

The Slash Command Engine intercepts user input that begins with `/` and dispatches it to the appropriate handler — bypassing the Anthropic API entirely. Commands operate on session state (conversation history, active agent, usage stats) without consuming API tokens.

Analogy: The command engine is like a restaurant's in-house intercom. When a waiter uses it to call the kitchen (`/compact`, `/clear`), those messages never reach the customer. Only messages addressed to the customer go through the main service channel (the API).

---

## 2. Core Types

**File:** `src/commands/types.ts`

```typescript
// src/commands/types.ts
import type { AgentDefinition } from '../agents/types.ts'
import type { UsageTracker } from '../output/UsageTracker.ts'
import type { OutputRenderer } from '../output/OutputRenderer.ts'
import type { Message } from '../conversation/types.ts'

/**
 * The full context passed to every slash command.
 * Commands can read session state and trigger mutations through
 * the provided methods — direct mutation of internals is not allowed.
 */
export interface CommandContext {
  // --- Read-only state ---
  /** Current conversation history (immutable reference) */
  readonly messages: readonly Message[]
  /** Name of the currently active agent */
  readonly activeAgentName: string
  /** Model currently in use (may differ from config if agent overrides it) */
  readonly currentModel: string
  /** Total agentic loop turns completed this session */
  readonly turnCount: number

  // --- Output ---
  readonly renderer: OutputRenderer
  readonly usageTracker: UsageTracker

  // --- Session mutations (all return void, state changes are internal) ---
  /** Reset conversation history to empty (equivalent to /clear) */
  clearMessages(): void
  /** Switch to a different agent by name. Throws if agent not found. */
  switchAgent(name: string): Promise<void>
  /** List all available agents from the registry */
  listAgents(): AgentDefinition[]
  /** Trigger context compaction immediately */
  compact(): Promise<void>
  /** Export conversation to a Markdown file. Returns the file path. */
  exportSession(): Promise<string>
  /** Exit the process after cleanup */
  exit(code?: number): never
}

/**
 * A single slash command registration.
 * Each command has a primary name and optional aliases.
 */
export interface SlashCommand {
  /** Primary command name (without the leading slash) */
  readonly name: string
  /** Optional aliases — all registered alongside the primary name */
  readonly aliases?: readonly string[]
  /** Short description shown in /help output */
  readonly description: string
  /**
   * Execute the command.
   * @param args - The space-separated arguments after the command name
   * @param ctx  - Session context with read/write access to state
   */
  execute(args: string, ctx: CommandContext): Promise<void>
}
```

---

## 3. SlashCommandEngine

**File:** `src/commands/SlashCommandEngine.ts`

```typescript
// src/commands/SlashCommandEngine.ts
import type { SlashCommand, CommandContext } from './types.ts'

export class SlashCommandEngine {
  private readonly commands: Map<string, SlashCommand> = new Map()

  constructor() {
    // Built-in commands are registered in the constructor.
    // The order of registration does not affect behavior.
    this.registerBuiltIns()
  }

  /**
   * Register a SlashCommand by its primary name and all aliases.
   * If a name is already registered, the existing entry is overwritten.
   */
  register(cmd: SlashCommand): void {
    this.commands.set(cmd.name, cmd)
    for (const alias of cmd.aliases ?? []) {
      this.commands.set(alias, cmd)
    }
  }

  /**
   * Attempt to execute a user input string as a slash command.
   *
   * @param input - Raw user input (should start with '/')
   * @param ctx   - Current session context
   * @returns true if the input was handled (even if it resulted in an error),
   *          false if the input does not start with '/'
   */
  async execute(input: string, ctx: CommandContext): Promise<boolean> {
    const trimmed = input.trim()
    if (!trimmed.startsWith('/')) {
      return false
    }

    // Split on first whitespace: "/agent code-reviewer" → ["agent", "code-reviewer"]
    const withoutSlash = trimmed.slice(1)
    const spaceIndex = withoutSlash.indexOf(' ')
    const name = spaceIndex === -1
      ? withoutSlash
      : withoutSlash.slice(0, spaceIndex)
    const args = spaceIndex === -1
      ? ''
      : withoutSlash.slice(spaceIndex + 1).trim()

    const cmd = this.commands.get(name.toLowerCase())
    if (!cmd) {
      ctx.renderer.printError(
        `Unknown command: /${name}\n` +
        `Type /help to see available commands.`
      )
      return true // handled (with error) — do not send to API
    }

    try {
      await cmd.execute(args, ctx)
    } catch (error) {
      ctx.renderer.printError(
        `Command /${name} failed: ${String(error)}`
      )
    }

    return true
  }

  /**
   * Return all unique registered commands (deduplicated by name,
   * aliases point to the same instance but are not listed separately).
   */
  listCommands(): SlashCommand[] {
    const seen = new Set<SlashCommand>()
    for (const cmd of this.commands.values()) {
      seen.add(cmd)
    }
    return [...seen].sort((a, b) => a.name.localeCompare(b.name))
  }

  private registerBuiltIns(): void {
    // Imported and instantiated here — all built-ins are registered at startup
    const builtIns: SlashCommand[] = [
      new ClearCommand(),
      new ExitCommand(),
      new HelpCommand(this),
      new InfoCommand(),
      new AgentCommand(),
      new UsageCommand(),
      new ExportCommand(),
      new CompactCommand(),
    ]
    for (const cmd of builtIns) {
      this.register(cmd)
    }
  }
}
```

---

## 4. Built-in Commands

### 4.1 ClearCommand

**File:** `src/commands/built-in/ClearCommand.ts`

```typescript
// src/commands/built-in/ClearCommand.ts
import type { SlashCommand, CommandContext } from '../types.ts'

export class ClearCommand implements SlashCommand {
  readonly name = 'clear'
  readonly description = 'Reset conversation history to empty'

  async execute(_args: string, ctx: CommandContext): Promise<void> {
    const count = ctx.messages.length
    ctx.clearMessages()
    ctx.renderer.printInfo(
      `Conversation cleared. (${count} message${count === 1 ? '' : 's'} removed)`
    )
  }
}
```

---

### 4.2 ExitCommand

**File:** `src/commands/built-in/ExitCommand.ts`

```typescript
// src/commands/built-in/ExitCommand.ts
import type { SlashCommand, CommandContext } from '../types.ts'

export class ExitCommand implements SlashCommand {
  readonly name = 'exit'
  readonly aliases = ['quit', 'q'] as const
  readonly description = 'Show usage summary and exit the session'

  async execute(_args: string, ctx: CommandContext): Promise<void> {
    ctx.renderer.print(ctx.usageTracker.summary())
    ctx.exit(0)
  }
}
```

---

### 4.3 HelpCommand

**File:** `src/commands/built-in/HelpCommand.ts`

```typescript
// src/commands/built-in/HelpCommand.ts
import type { SlashCommand, CommandContext } from '../types.ts'
import type { SlashCommandEngine } from '../SlashCommandEngine.ts'

export class HelpCommand implements SlashCommand {
  readonly name = 'help'
  readonly aliases = ['?'] as const
  readonly description = 'List all available commands'

  constructor(private readonly engine: SlashCommandEngine) {}

  async execute(_args: string, ctx: CommandContext): Promise<void> {
    const commands = this.engine.listCommands() // already sorted alphabetically
    const lines: string[] = ['## Available Commands\n']

    for (const cmd of commands) {
      const aliases = cmd.aliases?.length
        ? ` _(also: ${cmd.aliases.map(a => `/${a}`).join(', ')})_`
        : ''
      lines.push(`- **/${cmd.name}**${aliases} — ${cmd.description}`)
    }

    ctx.renderer.print(lines.join('\n'))
  }
}
```

---

### 4.4 InfoCommand

**File:** `src/commands/built-in/InfoCommand.ts`

```typescript
// src/commands/built-in/InfoCommand.ts
import type { SlashCommand, CommandContext } from '../types.ts'

// Rough estimate: 1 token ≈ 4 characters on average
const CHARS_PER_TOKEN = 4

function estimateTokens(messages: readonly { content: unknown }[]): number {
  let total = 0
  for (const msg of messages) {
    const text = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content)
    total += Math.ceil(text.length / CHARS_PER_TOKEN)
  }
  return total
}

export class InfoCommand implements SlashCommand {
  readonly name = 'info'
  readonly description = 'Show turn count, active agent, model, and estimated token count'

  async execute(_args: string, ctx: CommandContext): Promise<void> {
    const estimatedTokens = estimateTokens(ctx.messages as readonly { content: unknown }[])

    const info = [
      '## Session Info',
      '',
      `- **Agent:**    ${ctx.activeAgentName}`,
      `- **Model:**    ${ctx.currentModel}`,
      `- **Turns:**    ${ctx.turnCount}`,
      `- **Messages:** ${ctx.messages.length}`,
      `- **Est. context tokens:** ~${estimatedTokens.toLocaleString()}`,
    ].join('\n')

    ctx.renderer.print(info)
  }
}
```

---

### 4.5 AgentCommand

**File:** `src/commands/built-in/AgentCommand.ts`

```typescript
// src/commands/built-in/AgentCommand.ts
import type { SlashCommand, CommandContext } from '../types.ts'

export class AgentCommand implements SlashCommand {
  readonly name = 'agent'
  readonly description = 'List available agents or switch to a named agent'

  async execute(args: string, ctx: CommandContext): Promise<void> {
    const targetName = args.trim()

    if (!targetName) {
      // No argument: list all available agents with current marked
      const agents = ctx.listAgents()
      const lines = ['## Available Agents\n']

      for (const agent of agents) {
        const isCurrent = agent.name === ctx.activeAgentName
        const marker = isCurrent ? ' ✓' : ''
        const model = agent.model ? ` _(model: ${agent.model})_` : ''
        lines.push(`- **${agent.name}**${marker} — ${agent.description}${model}`)
      }

      ctx.renderer.print(lines.join('\n'))
      return
    }

    // Switch to the named agent
    const prior = ctx.activeAgentName
    try {
      await ctx.switchAgent(targetName)
      ctx.renderer.printInfo(
        `Agent switched: ${prior} → ${targetName}`
      )
    } catch (error) {
      ctx.renderer.printError(
        `Cannot switch to agent "${targetName}": ${String(error)}\n` +
        `Run /agent to see available agents.`
      )
    }
  }
}
```

---

### 4.6 UsageCommand

**File:** `src/commands/built-in/UsageCommand.ts`

```typescript
// src/commands/built-in/UsageCommand.ts
import type { SlashCommand, CommandContext } from '../types.ts'

export class UsageCommand implements SlashCommand {
  readonly name = 'usage'
  readonly description = 'Show cumulative token count and estimated cost for this session'

  async execute(_args: string, ctx: CommandContext): Promise<void> {
    ctx.renderer.print(ctx.usageTracker.summary())
  }
}
```

---

### 4.7 ExportCommand

**File:** `src/commands/built-in/ExportCommand.ts`

```typescript
// src/commands/built-in/ExportCommand.ts
import type { SlashCommand, CommandContext } from '../types.ts'

export class ExportCommand implements SlashCommand {
  readonly name = 'export'
  readonly description = 'Save the current conversation to a Markdown file'

  async execute(_args: string, ctx: CommandContext): Promise<void> {
    ctx.renderer.printInfo('Exporting session...')
    try {
      const filePath = await ctx.exportSession()
      ctx.renderer.printInfo(`Session exported to: ${filePath}`)
    } catch (error) {
      ctx.renderer.printError(`Export failed: ${String(error)}`)
    }
  }
}
```

The `ctx.exportSession()` method (implemented in `ConversationController`) writes the conversation to `~/.codeagent/exports/<ISO-timestamp>.md` in Markdown format, with each message as a section headed by its role.

---

### 4.8 CompactCommand

**File:** `src/commands/built-in/CompactCommand.ts`

```typescript
// src/commands/built-in/CompactCommand.ts
import type { SlashCommand, CommandContext } from '../types.ts'

export class CompactCommand implements SlashCommand {
  readonly name = 'compact'
  readonly description = 'Trigger immediate context compaction regardless of token count'

  async execute(_args: string, ctx: CommandContext): Promise<void> {
    const before = ctx.messages.length
    ctx.renderer.printInfo('Compacting context...')
    try {
      await ctx.compact()
      const after = ctx.messages.length
      ctx.renderer.printInfo(
        `Context compacted. Messages: ${before} → ${after}`
      )
    } catch (error) {
      ctx.renderer.printError(`Compaction failed: ${String(error)}`)
    }
  }
}
```

---

## 5. Engine Integration in REPL Loop

```typescript
// src/cli/index.ts — main REPL loop
const engine = new SlashCommandEngine()
// engine has access to the controller via CommandContext

for await (const line of readlineIterator(rl)) {
  const trimmed = line.trim()
  if (!trimmed) continue

  const handled = await engine.execute(trimmed, ctx)
  if (!handled) {
    // Plain text — send to Anthropic
    await controller.handleTurn(trimmed)
  }
}
```

The engine returns `false` only when the input does not start with `/`. This means the REPL always knows whether to invoke the API.

---

## 6. Unknown Command Behavior

If the user types `/typo` and that command is not registered:

1. The engine returns `true` (it handled the input — with an error)
2. An error message is printed to stderr: `Error: Unknown command: /typo\nType /help to see available commands.`
3. The API is NOT called — unknown commands are never forwarded to Claude

This prevents unintentional API calls for mistyped commands.

---

## 7. Command Lookup (Case Sensitivity)

All command names are lowercased before lookup:

```typescript
const name = withoutSlash.slice(0, spaceIndex).toLowerCase()
```

This means `/HELP`, `/Help`, and `/help` all resolve to the same command. Command names are defined in lowercase in their class implementations.

---

## 8. Test Cases

```typescript
// src/commands/SlashCommandEngine.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SlashCommandEngine } from './SlashCommandEngine.ts'
import type { CommandContext } from './types.ts'

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    messages: [],
    activeAgentName: 'default',
    currentModel: 'claude-sonnet-4-6',
    turnCount: 0,
    renderer: {
      print: vi.fn(),
      printInfo: vi.fn(),
      printError: vi.fn(),
      streamChunk: vi.fn(),
      flush: vi.fn(),
      printToolCall: vi.fn(),
      printToolResult: vi.fn(),
      printWelcome: vi.fn(),
    } as unknown as CommandContext['renderer'],
    usageTracker: {
      summary: vi.fn().mockReturnValue('No API calls recorded this session.'),
    } as unknown as CommandContext['usageTracker'],
    clearMessages: vi.fn(),
    switchAgent: vi.fn(),
    listAgents: vi.fn().mockReturnValue([]),
    compact: vi.fn(),
    exportSession: vi.fn().mockResolvedValue('/tmp/export.md'),
    exit: vi.fn() as unknown as CommandContext['exit'],
    ...overrides,
  }
}

describe('SlashCommandEngine', () => {
  let engine: SlashCommandEngine

  beforeEach(() => {
    engine = new SlashCommandEngine()
  })

  it('returns false for non-slash input', async () => {
    const ctx = makeCtx()
    const handled = await engine.execute('hello', ctx)
    expect(handled).toBe(false)
  })

  it('returns true for known slash command', async () => {
    const ctx = makeCtx()
    const handled = await engine.execute('/help', ctx)
    expect(handled).toBe(true)
  })

  it('returns true and prints error for unknown command', async () => {
    const ctx = makeCtx()
    const handled = await engine.execute('/nonexistent', ctx)
    expect(handled).toBe(true)
    expect(ctx.renderer.printError).toHaveBeenCalledWith(
      expect.stringContaining('Unknown command')
    )
  })

  it('resolves aliases correctly', async () => {
    const ctx = makeCtx()
    // /q and /quit are aliases for /exit
    const handled = await engine.execute('/q', ctx)
    expect(handled).toBe(true)
    expect(ctx.exit).toHaveBeenCalled()
  })

  it('is case-insensitive for command names', async () => {
    const ctx = makeCtx()
    const handled = await engine.execute('/CLEAR', ctx)
    expect(handled).toBe(true)
    expect(ctx.clearMessages).toHaveBeenCalled()
  })

  it('passes arguments correctly to command', async () => {
    const ctx = makeCtx()
    await engine.execute('/agent code-reviewer', ctx)
    expect(ctx.switchAgent).toHaveBeenCalledWith('code-reviewer')
  })

  it('/agent with no args lists agents', async () => {
    const ctx = makeCtx()
    await engine.execute('/agent', ctx)
    expect(ctx.listAgents).toHaveBeenCalled()
    expect(ctx.switchAgent).not.toHaveBeenCalled()
  })

  it('/clear calls clearMessages and prints confirmation', async () => {
    const ctx = makeCtx({ messages: [{} as never, {} as never] })
    await engine.execute('/clear', ctx)
    expect(ctx.clearMessages).toHaveBeenCalled()
    expect(ctx.renderer.printInfo).toHaveBeenCalledWith(
      expect.stringContaining('2 messages removed')
    )
  })

  it('/compact calls compact and shows before/after count', async () => {
    const ctx = makeCtx({ messages: new Array(30) as never[] })
    await engine.execute('/compact', ctx)
    expect(ctx.compact).toHaveBeenCalled()
  })

  it('/export calls exportSession and prints file path', async () => {
    const ctx = makeCtx()
    await engine.execute('/export', ctx)
    expect(ctx.exportSession).toHaveBeenCalled()
    expect(ctx.renderer.printInfo).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/export.md')
    )
  })

  it('/help lists all commands sorted alphabetically', async () => {
    const ctx = makeCtx()
    await engine.execute('/help', ctx)
    expect(ctx.renderer.print).toHaveBeenCalledWith(
      expect.stringContaining('agent')
    )
    expect(ctx.renderer.print).toHaveBeenCalledWith(
      expect.stringContaining('clear')
    )
  })

  it('custom registered command takes priority', async () => {
    const custom = {
      name: 'clear',
      description: 'overridden',
      execute: vi.fn(),
    }
    engine.register(custom)
    const ctx = makeCtx()
    await engine.execute('/clear', ctx)
    expect(custom.execute).toHaveBeenCalled()
    expect(ctx.clearMessages).not.toHaveBeenCalled()
  })
})
```

---

## 9. Summary

| Concern | Decision |
|---------|----------|
| Dispatch | Map lookup on lowercase command name |
| Unknown commands | Error message printed, API never called, returns `true` |
| Aliases | Registered alongside primary name in same Map |
| Arguments | First token after command name; rest passed as `args` string |
| Context | `CommandContext` interface — commands never touch internals directly |
| Extension | `engine.register(cmd)` — any module can register additional commands |
| Sorting | `/help` lists commands sorted alphabetically by primary name |
| Exit | ExitCommand calls `ctx.exit()` — controller decides cleanup order |
