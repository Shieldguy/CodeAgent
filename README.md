# codeAgent

An AI coding assistant CLI powered by the Anthropic API, inspired by Claude Code.  
Runs an interactive REPL that lets Claude read, write, and execute code in your project — with full tool permissions and a built-in agent system.

## Features

- **Streaming REPL** — live token-by-token output with Markdown rendering
- **Agentic loop** — Claude automatically calls tools and re-queries until the task is done
- **6 built-in agents** — switch personas mid-session (`/agent code-reviewer`, etc.)
- **Custom agents** — define your own in plain Markdown with YAML frontmatter
- **Tool permission guard** — approve, deny, or auto-allow destructive operations
- **Session history** — conversations are saved and can be resumed with `--resume`
- **Context compaction** — long sessions are automatically summarized to stay within token limits
- **Single binary** — distributable as a self-contained executable via `bun build --compile`

## Quick Start

```bash
# Install dependencies
npm install

# Set your Anthropic API key
export ANTHROPIC_API_KEY="sk-ant-..."

# Run in dev mode (no compile step)
npm run dev

# Or build and run
npm run build
node dist/cli/index.js
```

## Installation as a Global CLI

```bash
npm run build
npm install -g .
codeagent
```

## CLI Flags

| Flag | Description |
|------|-------------|
| `--api-key <key>` | Anthropic API key (overrides `ANTHROPIC_API_KEY`) |
| `--model <name>` | Model to use (default: `claude-sonnet-4-6`) |
| `--agent <name>` | Agent to activate at startup (default: `default`) |
| `--permission-mode auto\|default\|deny` | Tool permission mode (default: `default`) |
| `--prompt / -p <text>` | Run a single prompt non-interactively and exit |
| `--resume` | Load and restore the most recent session |
| `--cwd <path>` | Working directory override |
| `--api-url <url>` | Anthropic API base URL override |
| `--debug` | Enable debug logging to `~/.codeagent/logs/` |
| `--no-color` | Disable ANSI color output |
| `--version / -v` | Print version and exit |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — (required) | Your Anthropic API key |
| `CODEAGENT_MODEL` | `claude-sonnet-4-6` | Default model |
| `CODEAGENT_PERMISSION_MODE` | `default` | Tool permission mode |
| `CODEAGENT_DEBUG` | disabled | Enable debug logging when set |
| `CODEAGENT_MAX_TOOL_CALLS` | `25` | Max tool calls per turn |
| `CODEAGENT_MAX_OUTPUT_CHARS` | `100000` | Max characters per tool output |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/clear` | Reset conversation history |
| `/agent [name]` | List agents or switch to a named agent |
| `/info` | Show active agent, model, turn count, working directory |
| `/usage` | Show cumulative token usage and estimated cost |
| `/export` | Save conversation as a Markdown file |
| `/compact` | Manually trigger context compaction |
| `/help` | List all available commands |
| `/exit` / `/quit` | Print usage summary and exit |

## Built-in Agents

| Agent | Description |
|-------|-------------|
| `default` | General-purpose coding assistant with all tools |
| `code-reviewer` | Read-only code review (no write/bash access) |
| `security-reviewer` | Security-focused read-only analysis |
| `tdd-guide` | Test-driven development coach |
| `architect` | High-level design and architecture guidance |
| `doc-writer` | Documentation writer (read-only) |

## Custom Agents

Place a `.md` file in `.codeagent/agents/` (project-local) or `~/.codeagent/agents/` (user-global):

```markdown
---
name: my-agent
description: My custom agent
tools:
  - read_file
  - grep
  - glob
---

You are a specialized assistant for...
```

Fields `model` and `tools` are optional. Omitting `tools` gives access to all tools.  
Project-local agents take priority over user-global, which take priority over built-ins.

## Tool Permission Modes

| Mode | Behavior |
|------|----------|
| `auto` | All tool calls are allowed without prompting |
| `default` | Safe tools run freely; destructive tools (`write_file`, `edit_file`, `bash`) prompt for approval |
| `deny` | All destructive tool calls are blocked |

In `default` mode, answering `a` at any prompt upgrades the session to `auto` for the remainder.

## Available Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Write or create a file |
| `edit_file` | Surgical string replacement within a file |
| `bash` | Run a shell command |
| `glob` | Find files by glob pattern |
| `grep` | Search file contents by regex |

## Architecture

```
src/
  cli/           # REPL entrypoint, arg parser, InputBuffer
  config/        # ConfigManager — priority merge: env → file → CLI flags
  api/           # AnthropicClient — streaming, retry, abort
  conversation/  # ContextManager (immutable), ConversationController, SessionHistory, SessionExporter
  permissions/   # PermissionGuard — serialized approval queue
  tools/         # ReadFile, WriteFile, Bash, Glob, Grep, EditFile + ToolDispatcher
  agents/        # AgentLoader, AgentRegistry (3-tier discovery), AgentManager
  commands/      # SlashCommandEngine and built-in slash commands
  context/       # ProjectContextLoader (CLAUDE.md), GitContextLoader
  output/        # OutputRenderer (streaming + Markdown→ANSI), UsageTracker, Logger
  session/       # SessionHistory persistence, SessionExporter (Markdown)
```

**Key invariants:**
- `ContextManager` is immutable — `append()` returns a new instance.
- `ConversationController` is the session orchestrator, created once via the static `create()` factory.
- All tool calls pass through `PermissionGuard` before execution.
- Every `tool_use` block in the assistant message is always paired with a `tool_result` — even on dispatch errors.
- `AgentRegistry` discovers agents in three tiers: built-ins → `~/.codeagent/agents/` → `.codeagent/agents/` (project-local wins).

## Development Commands

```bash
npm install           # install dependencies
npm run dev           # run CLI via tsx (no compile step)
npm run build         # tsc compile → dist/
npm run typecheck     # type-check without emitting
npm test              # vitest run (all tests)
npm run test:watch    # vitest watch mode
npm run test:coverage # vitest + V8 coverage

# Run a single test file
npx vitest run src/conversation/ConversationController.test.ts

# Build a single self-contained binary (requires Bun)
npm run bundle                # current platform
npm run bundle:mac-arm        # macOS Apple Silicon
npm run bundle:mac-x64        # macOS Intel
npm run bundle:linux          # Linux x64
```

## Session History

Sessions are saved to `~/.codeagent/history/` after every turn. The last 50 sessions are retained.  
Resume the most recent session:

```bash
codeagent --resume
```

Export the current conversation to Markdown from within the REPL:

```
/export
```

## User Data Directory

```
~/.codeagent/
├── config.json      # user-global configuration
├── agents/          # user-global custom agent definitions (*.md)
├── history/         # session history files (*.json)
├── exports/         # exported Markdown conversations
└── logs/            # debug log files (when --debug is set)
```

Project-local overrides:

```
<project-root>/.codeagent/
├── config.json      # project-local config (highest priority)
└── agents/          # project-local agent definitions
```
