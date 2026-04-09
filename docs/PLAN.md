# CodeAgent — Project Plan

> A Claude Code–style AI coding assistant CLI built on the Anthropic API.
> For detailed implementation, see [DESIGN.md](./DESIGN.md) and individual `DESIGN_F#.md` files.

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [Feature Inventory](#2-feature-inventory)
3. [Data Flow](#3-data-flow)
4. [Module Overview](#4-module-overview)
5. [Project Layout](#5-project-layout)
6. [Phased Delivery](#6-phased-delivery)

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          CLI Layer                              │
│   argument parsing · bootstrap · REPL loop · multi-line input  │
└──────────────────────────────┬──────────────────────────────────┘
                               │ user input
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Input Router                             │
│  starts with "/"  ──►  SlashCommandEngine                       │
│  plain text       ──►  ConversationController                   │
└──────┬───────────────────────┬──────────────────────────────────┘
       │                       │
       ▼                       ▼
┌─────────────┐     ┌──────────────────────────────────────────┐
│ SlashCommand│     │         ConversationController           │
│   Engine    │     │  ContextManager  ◄──►  AnthropicClient   │
│ (local ops) │     │       ▲                streaming SSE      │
└─────────────┘     │       │                      │           │
       │            │  AgentManager         ToolDispatcher      │
       │ /agent cmd │  (active persona)     (filtered by agent) │
       └───────────►│       │                      │           │
                    └──────────────────────────────────────────┘
                                        │
                         ┌──────────────▼──────────────┐
                         │         Tool System          │
                         │  ReadFile · WriteFile · Bash │
                         │  Glob · Grep · Edit  · …     │
                         └──────────────┬──────────────┘
                                        │ before execution
                                        ▼
                         ┌──────────────────────────────┐
                         │       Permission Guard        │
                         │  auto · default · deny        │
                         │  (serialized queue)           │
                         └──────────────────────────────┘

  AgentManager reads from:
  ┌───────────────────────────────────────────────────┐
  │              AgentRegistry                        │
  │  built-in agents  (bundled with CLI)              │
  │  ~/.codeagent/agents/*.md  (user-global)          │
  │  .codeagent/agents/*.md    (project-local)        │
  └───────────────────────────────────────────────────┘

  All layers read from:
  ┌──────────────────────────────┐
  │      Config Manager          │
  │  ~/.codeagent/config.json    │
  │  .codeagent/config.json      │
  │  env vars · CLI flags        │
  └──────────────────────────────┘

  All output passes through:
  ┌──────────────────────────────┐
  │  Output Renderer + Logger    │
  │  markdown → ANSI · debug log │
  └──────────────────────────────┘
```

### Key Design Principles

| Principle | Decision |
|-----------|----------|
| Immutability | State transitions return new objects; no in-place mutation |
| Boundary validation | Schema validation at API responses, config files, and tool inputs |
| Streaming-first | Claude responses are always consumed as SSE streams |
| Agentic loop | Tool call → append result → re-query, until model stops calling tools |
| Permission before action | Every destructive tool invocation passes through the Permission Guard |
| Agent-scoped behavior | System prompt, model, and tool set are derived from the active agent |
| Safety by default | Path traversal prevention, output size cap, tool call rate limit |

---

## 2. Feature Inventory

| #   | Feature                                          | Priority | Phase |
| --- | ------------------------------------------------ | -------- | ----- |
| F1  | Interactive REPL (stdin/stdout, persistent loop) | Critical | 1     |
| F2  | Anthropic API streaming client                   | Critical | 1     |
| F3  | Core tools — ReadFile, WriteFile, Bash           | Critical | 1     |
| F4  | Conversation context manager                     | Critical | 1     |
| F5  | Permission guard (auto / default / deny)         | Critical | 1     |
| F6  | Configuration manager                            | Critical | 1     |
| F7  | Output renderer (markdown → ANSI)                | High     | 1     |
| F8  | Slash command engine                             | High     | 2     |
| F9  | Extended tools — Glob, Grep                      | High     | 2     |
| F10 | Extended tools — Edit (surgical patch)           | High     | 2     |
| F11 | Project context loader (CLAUDE.md)               | High     | 2     |
| F12 | Multi-turn memory compaction                     | Medium   | 3     |
| F13 | Headless / piped stdin mode                      | Medium   | 2     |
| F14 | Git-aware context (branch, status, diff)         | Medium   | 3     |
| F15 | MCP server + plugin support                      | Low      | 4     |
| F16 | Agent system (persona, registry, `/agent`)       | High     | 2     |
| F17 | Tool output size cap + path traversal guard      | Critical | 1     |
| F18 | Multi-line input (paste mode)                    | High     | 1     |
| F19 | API retry with exponential backoff               | High     | 1     |
| F20 | Tool call rate limiter (max calls per turn)      | High     | 1     |
| F21 | Permission guard serialization                   | High     | 1     |
| F22 | Bash env isolation + subprocess cleanup          | High     | 1     |
| F23 | Diff preview before WriteFile / EditFile         | High     | 2     |
| F24 | Token / cost display (`/usage`)                  | Medium   | 2     |
| F25 | CLAUDE.md injection spec (startup, scope)        | High     | 2     |
| F26 | Session export + persistent history              | Medium   | 3     |
| F27 | Smart compaction via summarization API           | Medium   | 3     |
| F28 | Debug logging (`--debug`, log file)              | Medium   | 2     |
| F29 | Sub-agent delegation pattern                     | Low      | 4     |
| F30 | Project-local config (`.codeagent/config.json`)  | Medium   | 3     |

---

## 3. Data Flow

### 3.1 Session Lifecycle (REPL Loop)

The program runs as a **persistent loop** until the user explicitly exits.
`ConversationController` and its `messages[]` array live for the entire session.

```
START
  │
  ▼
Bootstrap: load config → load agents → create controller (messages = [])
  │
  ▼
Print welcome banner + active agent name
  │
  ▼  ◄──────────────────────────────────────────────────────────┐
Show prompt ">"                                                  │
  │                                                             │
  ├─ Ctrl+D / EOF           ──► print usage summary ──► EXIT   │
  ├─ empty / blank line     ──────────────────────────────────► │ (re-prompt)
  ├─ "/exit" or "/quit"     ──► print usage summary ──► EXIT   │
  ├─ "/clear"               ──► messages = [] ────────────────► │
  ├─ "/agent <name>"        ──► switch persona ───────────────► │
  ├─ other slash command    ──► execute locally ───────────────► │
  └─ plain text (or paste)  ──► handleTurn(text)               │
                                     │                          │
                               append user message              │
                               to messages[]                    │
                                     │                          │
                               runAgenticLoop()                 │
                               [see 3.2]                        │
                                     │                          │
                               maybeCompact()                   │
                                     └──────────────────────────┘
```

**Key invariant:** `messages[]` grows every turn and is never reset unless `/clear` is called.
Every API call receives the full accumulated history.

### 3.2 Single Turn — Agentic Loop

```
runAgenticLoop(messages, agentModel, agentTools)
  │
  ▼
Call Anthropic streaming API with full messages[] history
  │
  ├─ text_delta events   ──► stream to terminal live
  │
  ├─ tool_use events     ──► collect into pendingToolCalls[]
  │                          (input assembled from finalMessage())
  │
  └─ message_stop        ──► append assistant message to messages[]
                              │
                              ▼
                         pendingToolCalls empty?
                              │
                    YES ──────┘ (done for this turn)
                              │
                    NO  ──► for each tool call (in parallel):
                              │
                              ├─ PermissionGuard.check(toolName)
                              │    denied? ──► append "denied" result
                              │
                              └─ allowed? ──► ToolDispatcher.run(toolName, input)
                                               │
                                               ├─ cap output size
                                               ├─ guard path traversal
                                               └─ return ToolResult
                              │
                         append all tool results to messages[]
                              │
                         recurse: runAgenticLoop() [max 25 calls/turn]
```

### 3.3 Agent Selection & Activation

```
RESOLVE agent name (from --agent flag or /agent command)
  │
  ├─ search .codeagent/agents/<name>.md      (project-local, highest priority)
  ├─ search ~/.codeagent/agents/<name>.md    (user-global)
  └─ search built-in registry               (bundled fallback)
        │
        ▼
  AgentDefinition { name, description, model?, tools?, systemPrompt }
        │
        ▼
  SET as active agent in AgentManager
        │
        ├─ buildSystemPrompt() uses agent.systemPrompt
        ├─ API call uses agent.model ?? config.model
        └─ ToolDispatcher filters by agent.tools (if set)
        │
  messages[] is NOT reset — history is preserved across agent switches
```

### 3.4 Context Compaction

```
AFTER each turn:
  estimate token count of messages[]
  │
  UNDER threshold? ──► no-op
  │
  OVER threshold?  ──► call summarization API on oldest messages
                         │
                         ▼
                    replace old messages with:
                      [Summary message]
                      [last 20 messages verbatim]
```

### 3.5 Configuration Resolution (Priority Chain)

```
.codeagent/config.json (project-local)   ← highest priority
       ↓ merged with
~/.codeagent/config.json (user-global)
       ↓ merged with
environment variables (ANTHROPIC_API_KEY, etc.)
       ↓ merged with
CLI flags (--model, --agent, --permission-mode, etc.)   ← lowest priority
       ↓
ResolvedConfig (frozen, injected into all modules)
```

---

## 4. Module Overview

### 4.1 CLI Entrypoint & REPL (F1, F13, F18)

Responsibilities:
- Parse CLI arguments (model, api-key, permission-mode, agent, prompt, debug)
- Bootstrap all services in the correct order
- Run an **infinite** readline loop — exits only on Ctrl+D, `/exit`, or `/quit`
- `Ctrl+C` aborts the in-flight API request only; does **not** exit
- Support multi-line paste mode (activated by `"""`)
- Support headless mode (`-p "prompt"`) for scripting and piped stdin

```
FUNCTION main():
  args = parseArgs()
  config = loadConfig(args)
  registry = loadAgentRegistry()
  agentManager = AgentManager(registry, args.agent ?? "default")
  controller = ConversationController(config, agentManager)

  IF args.prompt OR stdin is not a TTY:
    controller.handleInput(args.prompt ?? readStdin())
    EXIT

  printWelcome(agentManager.current.name)
  inputBuffer = InputBuffer()   // handles paste mode

  LOOP forever (readline):
    line = readLine()
    ready = inputBuffer.feed(line)
    IF ready is null: CONTINUE   // still in paste block
    IF ready is blank: CONTINUE
    controller.handleInput(ready)
  END LOOP
```

### 4.2 Anthropic API Client (F2, F19)

Responsibilities:
- Stream API responses as an async event sequence
- Assemble complete tool_use inputs from finalMessage()
- Retry on HTTP 429 / 529 with exponential backoff (max 3 attempts)
- Expose per-turn token usage for cost tracking
- Accept model as a per-call parameter (supports agent model overrides)

```
FUNCTION stream(messages, tools, systemPrompt, model):
  attempt = 0
  REPEAT:
    TRY:
      open SSE stream to Anthropic API
      FOR each event in stream:
        IF text_delta:   YIELD text chunk
        IF message_stop: extract tool_use blocks from finalMessage()
                         YIELD each tool_use with complete input
                         YIELD usage stats
      RETURN
    CATCH retryable error (429, 529):
      IF attempt >= 3: YIELD error; RETURN
      wait 1s * 2^attempt
      attempt++
    CATCH other error:
      YIELD error; RETURN
```

### 4.3 Tool System (F3, F9, F10, F17, F20, F22, F23)

All tools implement a common interface: receive typed params → return ToolResult.

**Safety invariants applied by every tool:**
- Output is capped at 100,000 characters (~25K tokens)
- File paths must resolve within the working directory (path traversal guard)

**Core tools (Phase 1):** ReadFile, WriteFile, Bash
**Extended tools (Phase 2):** Glob, Grep, EditFile

Rate limiter: at most 25 tool calls per agentic loop turn.

**WriteFile / EditFile** additionally show a unified diff and ask for confirmation before applying changes (in `default` permission mode).

**Bash** strips sensitive environment variables (API keys, tokens) before spawning the subprocess, and registers the process for cleanup on session exit.

```
FUNCTION tool.execute(params):
  validate params with schema
  assertSafePath(params.file_path, workingDir)  // file tools only
  result = performOperation()
  RETURN { content: capOutput(result), isError }
```

### 4.4 Conversation Context Manager (F4, F12, F27)

Maintains the ordered `messages[]` array. Each `append()` returns a new instance (immutable transitions). The controller stores the reference and replaces it each turn.

```
messages[] growth per turn (example with tool use):
  Turn N:  [user text]
           [assistant: tool_use block]
           [user: tool_result]
           [assistant: final text reply]

  Turn N+1: all prior messages + new turn appended
```

Compaction (Phase 3): when estimated token count exceeds threshold, call the API to summarize old messages and replace them with a concise summary message, keeping the last 20 messages verbatim.

### 4.5 Slash Command Engine (F8)

Dispatches `/command [args]` strings to registered handlers. All handlers receive a `CommandContext` that provides access to session state.

Built-in commands:

| Command | Action |
|---------|--------|
| `/clear` | Reset `messages[]` to empty |
| `/exit`, `/quit` | Print usage summary, exit process |
| `/help` | List all available commands |
| `/info` | Show turn count, active agent, model |
| `/agent [name]` | List agents or switch active agent |
| `/usage` | Show cumulative token count and estimated cost |
| `/export` | Save session as Markdown file |
| `/compact` | Trigger manual context compaction |

### 4.6 Permission Guard (F5, F21)

Three permission modes:

| Mode | Behavior |
|------|----------|
| `auto` | Allow all tool calls without prompting |
| `default` | Prompt the user before destructive operations (write, bash) |
| `deny` | Block all destructive tool calls |

All permission prompts are serialized through a queue to prevent concurrent readline conflicts. In `default` mode, the user may answer `y`, `n`, or `a` (always — upgrades session to `auto`).

### 4.7 Configuration Manager (F6, F30)

Merges configuration from multiple sources in priority order (see §3.5).
Validates the merged result against a schema. Persists user changes to `~/.codeagent/config.json`.

Project-local config (`.codeagent/config.json`) overrides user-global for repository-specific defaults (e.g., always use a specific model or agent for this repo).

### 4.8 Output Renderer, Usage Tracker & Logger (F7, F24, F28)

- **OutputRenderer:** streams text chunks live; renders final markdown as ANSI on flush
- **UsageTracker:** accumulates `input_tokens` + `output_tokens` across all turns; computes estimated cost; displayed on `/usage` and at session exit
- **Logger:** writes timestamped entries to `~/.codeagent/logs/session-<timestamp>.log` when `--debug` is set; all API calls, tool dispatches, and errors are logged

### 4.9 Agent System (F16)

Agent definitions are Markdown files with YAML frontmatter:

```
---
name: code-reviewer
description: Reviews code for quality and correctness
model: claude-opus-4-6          # optional — falls back to config.model
tools:                           # optional — omit = all tools available
  - read_file
  - glob
  - grep
---

You are an expert code reviewer. Analyze code for...
```

**Discovery order** (highest priority wins):
1. `.codeagent/agents/<name>.md` — project-local
2. `~/.codeagent/agents/<name>.md` — user-global
3. Built-in registry — always available

**Built-in agents:** `default`, `code-reviewer`, `security-reviewer`, `tdd-guide`, `architect`, `doc-writer`

Switching agents preserves `messages[]` — only the system prompt, model, and tool set change.

### 4.10 Project Context Injection (F11, F25)

`CLAUDE.md` is read once at session startup and injected into the static system prompt (not into `messages[]`). It is capped at 20,000 characters to protect the system prompt budget. It survives agent switches.

System prompt composition order:
1. Working directory + date
2. CLAUDE.md project instructions (if present)
3. Active agent's persona (`systemPrompt`)
4. Tool constraint note (if agent has a tool allowlist)

---

## 5. Project Layout

```
CodeAgent/
├── src/
│   ├── cli/
│   │   ├── index.ts            # main() entrypoint, REPL loop
│   │   ├── args.ts             # CLI argument parsing
│   │   └── InputBuffer.ts      # multi-line paste mode
│   ├── api/
│   │   └── AnthropicClient.ts  # streaming client, retry logic
│   ├── conversation/
│   │   ├── ConversationController.ts
│   │   ├── ContextManager.ts
│   │   ├── Compactor.ts        # Phase 3
│   │   └── ProjectContextLoader.ts
│   ├── tools/
│   │   ├── types.ts
│   │   ├── guards.ts           # capOutput, assertSafePath
│   │   ├── ToolDispatcher.ts
│   │   ├── ReadFileTool.ts
│   │   ├── WriteFileTool.ts    # includes diff preview
│   │   ├── BashTool.ts         # includes env isolation
│   │   ├── EditFileTool.ts     # Phase 2
│   │   ├── GlobTool.ts         # Phase 2
│   │   └── GrepTool.ts         # Phase 2
│   ├── agents/
│   │   ├── types.ts
│   │   ├── AgentLoader.ts      # parse .md frontmatter
│   │   ├── AgentRegistry.ts    # discover from all sources
│   │   ├── AgentManager.ts     # session-level active agent
│   │   └── built-in/
│   │       └── index.ts        # 6 bundled agent definitions
│   ├── commands/
│   │   ├── types.ts            # SlashCommand, CommandContext
│   │   ├── SlashCommandEngine.ts
│   │   └── built-in/
│   │       ├── ClearCommand.ts
│   │       ├── ExitCommand.ts
│   │       ├── HelpCommand.ts
│   │       ├── AgentCommand.ts
│   │       ├── UsageCommand.ts
│   │       ├── ExportCommand.ts
│   │       └── CompactCommand.ts
│   ├── permissions/
│   │   └── PermissionGuard.ts  # serialized queue
│   ├── config/
│   │   ├── types.ts
│   │   └── ConfigManager.ts
│   ├── output/
│   │   ├── OutputRenderer.ts
│   │   └── UsageTracker.ts
│   └── logger/
│       └── Logger.ts
├── .codeagent/
│   └── agents/                 # project-local agent definitions
├── docs/
│   ├── PLAN.md                 # this file
│   ├── DESIGN.md               # master design document
│   ├── DESIGN_F1.md            # CLI & REPL (F1, F13, F18)
│   ├── DESIGN_F2.md            # API Client (F2, F19)
│   ├── DESIGN_F3.md            # Core Tool System (F3, F17, F20, F22)
│   ├── DESIGN_F4.md            # Context Manager (F4, F12, F27)
│   ├── DESIGN_F5.md            # Permission Guard (F5, F21)
│   ├── DESIGN_F6.md            # Configuration (F6, F30)
│   ├── DESIGN_F7.md            # Output, Usage, Logging (F7, F24, F28)
│   ├── DESIGN_F8.md            # Slash Command Engine (F8)
│   ├── DESIGN_F9.md            # Extended Tools (F9, F10, F23)
│   ├── DESIGN_F11.md           # Project Context / CLAUDE.md (F11, F25)
│   ├── DESIGN_F14.md           # Git Integration (F14)
│   ├── DESIGN_F15.md           # Extensibility / MCP (F15, F29)
│   ├── DESIGN_F16.md           # Agent System (F16)
│   └── DESIGN_F26.md           # Session & History (F26)
├── package.json
├── tsconfig.json
└── CLAUDE.md
```

---

## 6. Phased Delivery

### Phase 1 — Functional Core (MVP)

Goal: A safe, working REPL that reads/writes files, runs shell commands, and streams Claude responses.

| Feature | Task | Module |
|---------|------|--------|
| F1, F18 | REPL loop + multi-line paste mode | `src/cli/` |
| F2, F19 | Streaming API client + retry | `src/api/` |
| F3 | ReadFile, WriteFile, BashTool | `src/tools/` |
| F4 | ContextManager (append, reset) | `src/conversation/` |
| F5, F21 | PermissionGuard (serialized) | `src/permissions/` |
| F6 | ConfigManager (env + file + flags) | `src/config/` |
| F7 | OutputRenderer (streaming + ANSI) | `src/output/` |
| F17 | Tool guards (size cap, path traversal) | `src/tools/` |
| F20 | Tool call rate limiter | `src/conversation/` |
| F22 | Bash env isolation + cleanup | `src/tools/` |
| — | ConversationController agentic loop | `src/conversation/` |
| — | Project scaffolding (tsconfig, package.json) | — |

### Phase 2 — Productivity & Safety

Goal: Agents, extended tools, safe file editing, user visibility.

| Feature | Task | Module |
|---------|------|--------|
| F8 | SlashCommandEngine + core commands | `src/commands/` |
| F9 | GlobTool, GrepTool | `src/tools/` |
| F10, F23 | EditFileTool + diff preview | `src/tools/` |
| F11, F25 | CLAUDE.md injection | `src/conversation/` |
| F13 | Headless + piped stdin | `src/cli/` |
| F16 | Agent system (Loader, Registry, Manager, built-ins) | `src/agents/` |
| F24 | UsageTracker + `/usage` command | `src/output/` |
| F28 | Logger + `--debug` flag | `src/logger/` |

### Phase 3 — Resilience & Scale

Goal: Long-session stability, git awareness, persistent history.

| Feature | Task | Module |
|---------|------|--------|
| F12, F27 | Smart compaction via summarization API | `src/conversation/` |
| F14 | Git context injection (branch, status, diff) | `src/conversation/` |
| F26 | Persistent history + `/export` command | `src/conversation/` |
| F30 | Project-local config (`.codeagent/config.json`) | `src/config/` |

### Phase 4 — Extensibility

Goal: Open the platform for external tools and orchestration.

| Feature | Task | Module |
|---------|------|--------|
| F15 | MCP server support | `src/mcp/` |
| F15 | Plugin system (external tool packages) | `src/plugins/` |
| F29 | Sub-agent delegation (`/delegate`) | `src/agents/` |

---

*For implementation details, see [DESIGN.md](./DESIGN.md).*
