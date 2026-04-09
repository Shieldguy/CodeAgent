# DESIGN_F7 — Output Renderer, Usage Tracker & Debug Logger (F7, F24, F28)

> Features: F7 (Output Renderer), F24 (Usage Tracker / Cost), F28 (Debug Logger)
> Phase: 1 (F7), 2 (F24, F28)
> Modules: `src/output/OutputRenderer.ts`, `src/output/UsageTracker.ts`, `src/logger/Logger.ts`

---

## 1. Purpose

Three distinct concerns are covered in this design file:

1. **OutputRenderer** — all user-facing terminal output (streaming, markdown rendering, tool call display, errors)
2. **UsageTracker** — accumulates token counts per turn and computes estimated costs per model
3. **Logger** — writes timestamped debug entries to a log file, with session rotation

Analogy for the triad: OutputRenderer is the front-of-house server (what customers see), UsageTracker is the accountant (tracking what was consumed), and Logger is the kitchen log (internal record of every step, never shown to customers unless they ask).

---

## 2. OutputRenderer

**File:** `src/output/OutputRenderer.ts`

### 2.1 Responsibilities

- Stream text chunks live to `process.stdout` (no buffering, no delay)
- Render completed markdown replies as ANSI-colored terminal output
- Format tool call display (name + input preview)
- Format tool result display (success or error prefix)
- Print the welcome banner and session info
- Print errors with bold red styling

### 2.2 Dependencies

```
npm install marked marked-terminal chalk
```

- `marked` — Markdown parser
- `marked-terminal` — Marked renderer that outputs ANSI escape codes
- `chalk` — Typed ANSI color utilities

### 2.3 Implementation

```typescript
// src/output/OutputRenderer.ts
import process from 'node:process'
import { Marked } from 'marked'
import { markedTerminal } from 'marked-terminal'
import chalk from 'chalk'

const OUTPUT_CAP = 200 // chars shown inline for tool results

export class OutputRenderer {
  private readonly color: boolean
  private readonly marked: Marked

  constructor(color = true) {
    this.color = color
    this.marked = new Marked()
    // markedTerminal renders markdown as ANSI escape sequences
    this.marked.use(markedTerminal({
      reflowText: true,
      width: Math.min(process.stdout.columns ?? 100, 120),
    }))
  }

  /**
   * Write a raw text chunk directly to stdout.
   * Called for every text_delta event during streaming.
   * No buffering — chunks appear as they arrive.
   */
  streamChunk(text: string): void {
    process.stdout.write(text)
  }

  /**
   * Write a newline after the streaming response completes.
   * Ensures the terminal cursor moves to a fresh line before the next prompt.
   */
  flush(): void {
    process.stdout.write('\n')
  }

  /**
   * Render a completed markdown string as ANSI to stdout.
   * Used for non-streamed output (slash command responses, help text).
   */
  print(text: string): void {
    if (!text.trim()) return
    const rendered = this.color
      ? (this.marked.parse(text) as string)
      : text
    process.stdout.write(rendered)
    if (!rendered.endsWith('\n')) process.stdout.write('\n')
  }

  /**
   * Print a tool invocation before execution.
   * Format: cyan label + gray JSON preview (first 120 chars of input)
   */
  printToolCall(name: string, input: Record<string, unknown>): void {
    const label = this.color ? chalk.cyan(`[tool: ${name}]`) : `[tool: ${name}]`
    const preview = JSON.stringify(input)
    const truncated = preview.length > 120 ? preview.slice(0, 117) + '...' : preview
    const inputStr = this.color ? chalk.gray(truncated) : truncated
    process.stdout.write(`${label} ${inputStr}\n`)
  }

  /**
   * Print the result of a tool execution.
   * Success: green check mark prefix
   * Error:   red X prefix
   * Content is truncated to OUTPUT_CAP chars to keep the terminal readable.
   */
  printToolResult(content: string, isError: boolean): void {
    const raw = content.length > OUTPUT_CAP
      ? content.slice(0, OUTPUT_CAP - 3) + '...'
      : content
    const text = raw.replace(/\n/g, ' ')

    if (isError) {
      const prefix = this.color ? chalk.red('✗') : '✗'
      process.stdout.write(`${prefix} ${text}\n`)
    } else {
      const prefix = this.color ? chalk.green('✓') : '✓'
      process.stdout.write(`${prefix} ${text}\n`)
    }
  }

  /**
   * Print the session welcome banner and active agent name.
   * Called once at REPL startup.
   */
  printWelcome(agentName: string): void {
    const banner = this.color
      ? chalk.bold.blue('CodeAgent')
      : 'CodeAgent'
    const agent = this.color
      ? chalk.cyan(agentName)
      : agentName
    process.stdout.write(`\n${banner}  —  active agent: ${agent}\n`)
    process.stdout.write('Type /help for commands, Ctrl+D to exit.\n\n')
  }

  /**
   * Print an error message with bold red formatting.
   * Used for user-visible errors (not debug logs).
   */
  printError(message: string): void {
    const formatted = this.color
      ? chalk.bold.red(`Error: ${message}`)
      : `Error: ${message}`
    process.stderr.write(`${formatted}\n`)
  }

  /**
   * Print a plain informational line (no markdown rendering).
   * Used for status messages, confirmations, etc.
   */
  printInfo(message: string): void {
    const formatted = this.color ? chalk.gray(message) : message
    process.stdout.write(`${formatted}\n`)
  }
}
```

### 2.4 Streaming Protocol

During an agentic turn, the caller drives the renderer:

```typescript
// In ConversationController.runAgenticLoop()
for await (const event of client.stream(messages, tools, systemPrompt, model)) {
  if (event.type === 'text_delta') {
    renderer.streamChunk(event.text)
  }
  if (event.type === 'tool_use') {
    renderer.flush()                        // newline after streamed text
    renderer.printToolCall(event.name, event.input)
    const result = await dispatcher.run(event.name, event.input)
    renderer.printToolResult(result.content, result.isError)
  }
  if (event.type === 'message_stop') {
    renderer.flush()
  }
}
```

---

## 3. UsageTracker

**File:** `src/output/UsageTracker.ts`

### 3.1 Responsibilities

- Accumulate `input_tokens` and `output_tokens` across all turns
- Track usage separately per model (to handle agent switches mid-session)
- Compute estimated cost using a static pricing table
- Provide a formatted summary string for `/usage` and session exit

### 3.2 Per-Model Pricing Table

Prices are in USD per 1 million tokens. The table is a static constant and should be updated when Anthropic changes pricing.

```typescript
// src/output/pricing.ts
export interface ModelPricing {
  inputPer1M: number   // USD per 1M input tokens
  outputPer1M: number  // USD per 1M output tokens
}

// Pricing as of April 2026 — update this table when Anthropic changes rates
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6':    { inputPer1M: 15.00, outputPer1M: 75.00 },
  'claude-sonnet-4-6':  { inputPer1M: 3.00,  outputPer1M: 15.00 },
  'claude-haiku-3-5':   { inputPer1M: 0.80,  outputPer1M: 4.00  },
  // Fallback for unknown models
  'unknown':            { inputPer1M: 3.00,  outputPer1M: 15.00 },
}

export function getPricing(model: string): ModelPricing {
  return MODEL_PRICING[model] ?? MODEL_PRICING['unknown']!
}
```

### 3.3 Implementation

```typescript
// src/output/UsageTracker.ts
import { getPricing } from './pricing.ts'

interface ModelUsage {
  inputTokens: number
  outputTokens: number
}

export class UsageTracker {
  // Map from model name to accumulated token counts
  private usage: Map<string, ModelUsage> = new Map()

  /**
   * Record token usage for a single API response.
   * Accumulates on top of any prior usage for this model.
   */
  record(model: string, inputTokens: number, outputTokens: number): void {
    const prior = this.usage.get(model) ?? { inputTokens: 0, outputTokens: 0 }
    this.usage.set(model, {
      inputTokens: prior.inputTokens + inputTokens,
      outputTokens: prior.outputTokens + outputTokens,
    })
  }

  /**
   * Return total accumulated input and output tokens across all models.
   */
  totals(): { inputTokens: number; outputTokens: number } {
    let input = 0
    let output = 0
    for (const usage of this.usage.values()) {
      input += usage.inputTokens
      output += usage.outputTokens
    }
    return { inputTokens: input, outputTokens: output }
  }

  /**
   * Compute total estimated cost in USD across all models.
   * Each model's usage is priced independently using its own rate.
   */
  estimatedCostUsd(): number {
    let total = 0
    for (const [model, usage] of this.usage.entries()) {
      const pricing = getPricing(model)
      total += (usage.inputTokens / 1_000_000) * pricing.inputPer1M
      total += (usage.outputTokens / 1_000_000) * pricing.outputPer1M
    }
    return total
  }

  /**
   * Return a formatted multi-line summary string.
   * Used by /usage command and session exit.
   */
  summary(): string {
    if (this.usage.size === 0) {
      return 'No API calls recorded this session.'
    }

    const lines: string[] = ['Token usage this session:']

    for (const [model, usage] of this.usage.entries()) {
      const pricing = getPricing(model)
      const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPer1M
      const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPer1M
      const modelCost = inputCost + outputCost

      lines.push(`  ${model}:`)
      lines.push(`    Input:  ${usage.inputTokens.toLocaleString()} tokens  ($${inputCost.toFixed(4)})`)
      lines.push(`    Output: ${usage.outputTokens.toLocaleString()} tokens  ($${outputCost.toFixed(4)})`)
      lines.push(`    Model subtotal: $${modelCost.toFixed(4)}`)
    }

    const { inputTokens, outputTokens } = this.totals()
    const totalCost = this.estimatedCostUsd()

    lines.push('')
    lines.push(`  Total input:  ${inputTokens.toLocaleString()} tokens`)
    lines.push(`  Total output: ${outputTokens.toLocaleString()} tokens`)
    lines.push(`  Estimated cost: $${totalCost.toFixed(4)} USD`)
    lines.push('')
    lines.push('  Note: Costs are estimates. Actual billing may differ.')

    return lines.join('\n')
  }
}
```

### 3.4 Model Switching Mid-Session

When the user runs `/agent code-reviewer` and that agent uses a different model (e.g., `claude-opus-4-6` instead of the default `claude-sonnet-4-6`), subsequent API calls are attributed to the new model. The `UsageTracker` maintains separate counters per model so costs are computed at the correct rate for each.

```
Session example:
  Turns 1–5:  claude-sonnet-4-6  → 12,000 input tokens, 3,000 output tokens
  /agent code-reviewer  (model: claude-opus-4-6)
  Turns 6–8:  claude-opus-4-6   → 8,000 input tokens, 2,000 output tokens

/usage output:
  claude-sonnet-4-6:
    Input:  12,000 tokens  ($0.0360)
    Output:  3,000 tokens  ($0.0450)
    Model subtotal: $0.0810
  claude-opus-4-6:
    Input:   8,000 tokens  ($0.1200)
    Output:  2,000 tokens  ($0.1500)
    Model subtotal: $0.2700

  Estimated cost: $0.3510 USD
```

---

## 4. Logger

**File:** `src/logger/Logger.ts`

### 4.1 Responsibilities

- Singleton instance — one logger per process
- Write structured log entries to `~/.codeagent/logs/session-<ISO>.log`
- Always log ERROR level, even when debug mode is disabled
- Rotate logs: keep the 10 most recent session files, delete older ones on startup
- Non-blocking writes (fire-and-forget with `fs.appendFile`)

### 4.2 Log Format

Each line is a JSON object on a single line (NDJSON), making it machine-parseable.

```
[2026-04-05T14:23:01.123Z] [INFO]  Loading configuration {"path":"~/.codeagent/config.json"}
[2026-04-05T14:23:01.456Z] [DEBUG] API request {"model":"claude-sonnet-4-6","messageCount":3}
[2026-04-05T14:23:03.789Z] [DEBUG] Tool dispatch {"name":"read_file","path":"/src/main.ts"}
[2026-04-05T14:23:03.800Z] [ERROR] Tool failed {"name":"bash","error":"command not found: npx"}
```

Format: `[ISO_TIMESTAMP] [LEVEL]  message {optional_json_data}`

### 4.3 Implementation

```typescript
// src/logger/Logger.ts
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

const LOG_DIR = path.join(os.homedir(), '.codeagent', 'logs')
const MAX_LOG_FILES = 10

export class Logger {
  private static instance: Logger | null = null

  private readonly enabled: boolean
  private readonly logPath: string

  private constructor(enabled: boolean) {
    this.enabled = enabled
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    this.logPath = path.join(LOG_DIR, `session-${timestamp}.log`)

    // Create log dir and rotate old files synchronously at startup
    // (acceptable once-per-session cost)
    this.initLogDir()
  }

  /**
   * Get or create the singleton Logger instance.
   * Must be called once at startup with the debug flag.
   */
  static getInstance(enabled = false): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger(enabled)
    }
    return Logger.instance
  }

  /**
   * Reset the singleton (for test isolation only).
   */
  static resetForTest(): void {
    Logger.instance = null
  }

  /**
   * Log a message at the given level.
   * DEBUG/INFO/WARN are suppressed when debug mode is disabled.
   * ERROR always logs regardless of debug mode.
   */
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (!this.enabled && level !== 'ERROR') return

    const entry = this.formatEntry(level, message, data)
    // Fire-and-forget — never await, never block the main loop
    fs.appendFile(this.logPath, entry + '\n', 'utf-8', () => {
      // Silently ignore write errors to avoid cascading failures
    })
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('DEBUG', message, data)
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('INFO', message, data)
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('WARN', message, data)
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('ERROR', message, data)
  }

  /**
   * Return the path to the current session log file.
   * Useful for the /info command to display log location.
   */
  getLogPath(): string {
    return this.logPath
  }

  private formatEntry(level: LogLevel, message: string, data?: Record<string, unknown>): string {
    const ts = new Date().toISOString()
    const levelPadded = level.padEnd(5)
    const dataPart = data ? ` ${JSON.stringify(data)}` : ''
    return `[${ts}] [${levelPadded}] ${message}${dataPart}`
  }

  private initLogDir(): void {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 })
      this.rotateOldLogs()
    } catch {
      // If we can't create the log dir, continue without logging
    }
  }

  /**
   * Delete log files beyond the MAX_LOG_FILES limit.
   * Files are sorted by name (ISO timestamp prefix = lexicographic = chronological).
   * Oldest files are deleted first.
   */
  private rotateOldLogs(): void {
    try {
      const files = fs.readdirSync(LOG_DIR)
        .filter(f => f.startsWith('session-') && f.endsWith('.log'))
        .sort() // ascending = oldest first

      const toDelete = files.slice(0, Math.max(0, files.length - MAX_LOG_FILES + 1))
      for (const file of toDelete) {
        try {
          fs.unlinkSync(path.join(LOG_DIR, file))
        } catch {
          // Ignore individual delete failures
        }
      }
    } catch {
      // Ignore rotation failures
    }
  }
}
```

### 4.4 Log Rotation Policy

| Rule | Value |
|------|-------|
| Max session files retained | 10 |
| Rotation trigger | On `Logger` instantiation (session startup) |
| Sort order | Lexicographic on filename (ISO timestamp prefix = chronological) |
| Deletion order | Oldest files first |
| Failure behavior | Silent — rotation errors never crash the session |

Example: after 12 sessions, the 2 oldest files are deleted, leaving the 10 most recent.

### 4.5 Log Levels Reference

| Level | When to use | Logged when debug disabled? |
|-------|------------|----------------------------|
| `DEBUG` | API request/response details, tool inputs | No |
| `INFO` | Session start, agent switch, compaction | No |
| `WARN` | Retry attempts, truncated output, missing CLAUDE.md | No |
| `ERROR` | Tool failures, API errors, invalid config | **Yes** |

### 4.6 What Gets Logged

Each module logs at the appropriate level:

```typescript
// API Client
logger.debug('API request', { model, messageCount: messages.length })
logger.debug('API response', { inputTokens, outputTokens, toolCallCount })
logger.warn('Retrying API request', { attempt, statusCode })
logger.error('API request failed', { error: String(error) })

// Tool Dispatcher
logger.debug('Tool dispatch', { name: toolName, input })
logger.debug('Tool result', { name: toolName, isError, chars: result.content.length })
logger.error('Tool execution failed', { name: toolName, error: String(error) })

// Config Manager
logger.info('Configuration loaded', { model: config.model, agent: config.agent, debug: config.debug })
logger.warn('Project config not found', { path: PROJECT_CONFIG_PATH })

// Agent Manager
logger.info('Agent switched', { from: previousAgent, to: newAgent })

// Context Compaction
logger.info('Context compacted', { messagesBefore, messagesAfter, summaryTokens })
```

---

## 5. Integration Points

### 5.1 ConversationController wires all three

```typescript
// src/conversation/ConversationController.ts
import { OutputRenderer } from '../output/OutputRenderer.ts'
import { UsageTracker } from '../output/UsageTracker.ts'
import { Logger } from '../logger/Logger.ts'

export class ConversationController {
  private readonly renderer: OutputRenderer
  private readonly usageTracker: UsageTracker
  private readonly logger: Logger

  constructor(config: ResolvedConfig, agentManager: AgentManager) {
    this.renderer = new OutputRenderer(config.color)
    this.usageTracker = new UsageTracker()
    this.logger = Logger.getInstance(config.debug)
    // ...
  }
}
```

### 5.2 UsageTracker is updated after every API response

```typescript
// In runAgenticLoop():
for await (const event of client.stream(...)) {
  if (event.type === 'usage') {
    this.usageTracker.record(model, event.inputTokens, event.outputTokens)
    this.logger.debug('Token usage recorded', {
      model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
    })
  }
}
```

### 5.3 Session exit prints usage summary

```typescript
// In ExitCommand or Ctrl+D handler:
renderer.print(usageTracker.summary())
process.exit(0)
```

---

## 6. Test Cases

### OutputRenderer tests

```typescript
describe('OutputRenderer', () => {
  it('streamChunk writes directly to stdout without newline', () => {
    const spy = vi.spyOn(process.stdout, 'write')
    const renderer = new OutputRenderer(false)
    renderer.streamChunk('hello')
    expect(spy).toHaveBeenCalledWith('hello')
  })

  it('printToolResult truncates content to 200 chars', () => {
    const spy = vi.spyOn(process.stdout, 'write')
    const renderer = new OutputRenderer(false)
    const long = 'x'.repeat(300)
    renderer.printToolResult(long, false)
    const written = (spy.mock.calls[0]?.[0] as string) ?? ''
    expect(written.length).toBeLessThanOrEqual(210) // 200 + prefix + newline
  })

  it('printError writes to stderr', () => {
    const spy = vi.spyOn(process.stderr, 'write')
    const renderer = new OutputRenderer(false)
    renderer.printError('something went wrong')
    expect(spy).toHaveBeenCalled()
  })
})
```

### UsageTracker tests

```typescript
describe('UsageTracker', () => {
  it('accumulates tokens across multiple calls', () => {
    const tracker = new UsageTracker()
    tracker.record('claude-sonnet-4-6', 1000, 200)
    tracker.record('claude-sonnet-4-6', 500, 100)
    const { inputTokens, outputTokens } = tracker.totals()
    expect(inputTokens).toBe(1500)
    expect(outputTokens).toBe(300)
  })

  it('tracks usage separately per model', () => {
    const tracker = new UsageTracker()
    tracker.record('claude-sonnet-4-6', 1000, 0)
    tracker.record('claude-opus-4-6', 2000, 0)
    const summary = tracker.summary()
    expect(summary).toContain('claude-sonnet-4-6')
    expect(summary).toContain('claude-opus-4-6')
  })

  it('computes cost using correct per-model pricing', () => {
    const tracker = new UsageTracker()
    // claude-sonnet-4-6: $3.00/1M input, $15.00/1M output
    tracker.record('claude-sonnet-4-6', 1_000_000, 0)
    expect(tracker.estimatedCostUsd()).toBeCloseTo(3.00)
  })

  it('returns friendly message when no calls recorded', () => {
    const tracker = new UsageTracker()
    expect(tracker.summary()).toBe('No API calls recorded this session.')
  })
})
```

### Logger tests

```typescript
describe('Logger', () => {
  beforeEach(() => Logger.resetForTest())

  it('does not log DEBUG when debug is disabled', () => {
    const logger = Logger.getInstance(false)
    const spy = vi.spyOn(fs, 'appendFile')
    logger.debug('test message')
    expect(spy).not.toHaveBeenCalled()
  })

  it('always logs ERROR even when debug is disabled', () => {
    const logger = Logger.getInstance(false)
    const spy = vi.spyOn(fs, 'appendFile')
    logger.error('critical failure')
    expect(spy).toHaveBeenCalled()
  })

  it('includes timestamp and level in log format', () => {
    const logger = Logger.getInstance(true)
    const spy = vi.spyOn(fs, 'appendFile')
    logger.info('startup')
    const written = (spy.mock.calls[0]?.[1] as string) ?? ''
    expect(written).toMatch(/\[\d{4}-\d{2}-\d{2}T/)
    expect(written).toContain('[INFO ]')
    expect(written).toContain('startup')
  })
})
```

---

## 7. Summary

| Component | Key Design Decision |
|-----------|-------------------|
| OutputRenderer | Writes directly to `process.stdout` — no buffering layer |
| OutputRenderer | Uses `marked` + `marked-terminal` for full markdown ANSI rendering |
| OutputRenderer | Tool results truncated to 200 chars for terminal readability |
| UsageTracker | Per-model accounting to handle mid-session agent switches |
| UsageTracker | Pricing table as static constant — easy to update |
| Logger | Singleton — one instance per process, shared across all modules |
| Logger | Fire-and-forget writes — never blocks the agentic loop |
| Logger | ERROR always logged, other levels gated behind debug flag |
| Logger | Rotate to keep last 10 session files — no unbounded disk growth |
