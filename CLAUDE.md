# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`codeAgent` is a Claude Code-style AI coding assistant CLI built on the Anthropic API.  
Design documents live in `docs/` — start with `docs/DESIGN.md` for the master design, then
`docs/DESIGN_F{N}.md` for each feature's detailed implementation spec.

## Commands

```bash
npm install          # install dependencies
npm run build        # tsc compile → dist/
npm run typecheck    # type-check without emitting
npm test             # vitest run
npm run test:watch   # vitest watch mode
npm run test:coverage # vitest + V8 coverage (80% threshold)
npm run dev          # run CLI directly via tsx (no compile step)
node dist/cli/index.js  # run compiled output
```

Run a single test file:
```bash
npx vitest run src/config/ConfigManager.test.ts
```

## Architecture

```
src/
  cli/           # F1  — CLI entrypoint, REPL, args parser, InputBuffer
  config/        # F6  — ConfigManager (priority chain: env > flags > file > defaults)
  anthropic/     # F2  — AnthropicClient (streaming, retry, abort)
  conversation/  # F4  — ContextManager (immutable), ConversationController
  permissions/   # F5  — PermissionGuard (Promise-queue serialization)
  tools/         # F3,F9 — ReadFile, WriteFile, Bash, Glob, Grep, EditFile
  agents/        # F16 — AgentRegistry (3-tier discovery), AgentManager
  output/        # F7  — OutputRenderer, UsageTracker, Logger
  commands/      # F8  — SlashCommandEngine, built-in commands
  context/       # F11,F14 — ProjectContextLoader (CLAUDE.md), GitContextLoader
  session/       # F26 — SessionHistory, SessionExporter
```

Key invariants:
- `ContextManager` is immutable — `append()` returns a new instance; `ConversationController` reassigns `this.context` each turn.
- `ConversationController` is the session orchestrator — created once per process, never reset between turns (only `/clear` resets context).
- All tools run through `PermissionGuard` before execution.
- `AgentRegistry` discovers agents in 3 tiers: built-ins → `~/.codeagent/agents/` → `.codeagent/agents/` (project-local wins).

## Tech Stack

- **Runtime:** Node 22+, ESM (`"type": "module"`)
- **Language:** TypeScript 5.x — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- **Module resolution:** NodeNext (`.js` extensions on all local imports)
- **Testing:** Vitest + V8 coverage
- **Key deps:** `@anthropic-ai/sdk`, `zod`, `chalk`, `marked`, `marked-terminal`, `diff`

## Implementation Status

| Phase | Status | Contents |
|-------|--------|----------|
| 0 — Project skeleton | **done** | package.json, tsconfig, vitest, stub entrypoint |
| 1 — Working REPL | **done** | ConfigManager, AnthropicClient, ContextManager, ConversationController, OutputRenderer, UsageTracker, Logger, CLI REPL |
| 2 — Tool layer | not started | PermissionGuard, ReadFile/WriteFile/Bash, Glob/Grep/EditFile |
| 3 — UX layer | not started | SlashCommandEngine, ProjectContextLoader, GitContextLoader |
| 4 — Agent system | not started | AgentRegistry, AgentManager, SessionHistory |
