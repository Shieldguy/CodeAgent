# DESIGN_F16 — Agent System (F16)

> Covers the complete agent system: persona-driven sessions with per-agent system prompts, optional model overrides, and optional tool allowlists.

---

## Table of Contents

1. [Overview](#1-overview)
2. [src/agents/types.ts](#2-srcagentstypests)
3. [Agent Definition File Format](#3-agent-definition-file-format)
4. [src/agents/AgentLoader.ts](#4-srcagentsagentloaderts)
5. [src/agents/AgentRegistry.ts](#5-srcagentsagentregistryts)
6. [src/agents/AgentManager.ts](#6-srcagentsagentmanagerts)
7. [src/agents/built-in/index.ts](#7-srcagentsbuilt-inindexts)
8. [Integration with ConversationController](#8-integration-with-conversationcontroller)
9. [Test Cases](#9-test-cases)

---

## 1. Overview

The agent system enables **persona-driven sessions**. An agent is a named bundle of three things:

1. A **system prompt** that sets the AI's role and behavioral constraints.
2. An optional **model override** that selects a specific Claude model for all turns while this agent is active.
3. An optional **tool allowlist** that restricts which tools the model may call.

Every session has exactly one **active agent** at a time. The active agent is selected at startup (via `--agent` flag or defaulting to `"default"`) and can be switched mid-session with the `/agent <name>` slash command.

Switching agents does **not** reset the conversation history (`messages[]`). The new agent's system prompt, model, and tool allowlist take effect immediately on the next API call while all prior context is preserved.

Agents are discovered from three sources in priority order:

1. `.codeagent/agents/<name>.md` — project-local, checked in to the repo
2. `~/.codeagent/agents/<name>.md` — user-global, personal customizations
3. Built-in registry — six agents bundled with the CLI

If the same name appears in multiple sources, the highest-priority source wins.

---

## 2. src/agents/types.ts

This module defines the data shape for an agent definition and its zod validation schema. It has no runtime dependencies beyond zod.

```typescript
import { z } from 'zod'

/**
 * Zod schema for validating a parsed agent definition.
 *
 * Fields:
 *
 *   name         — Machine identifier. Used in /agent <name> and --agent flag.
 *                  Must be lowercase alphanumeric with hyphens (kebab-case).
 *                  Example: "code-reviewer"
 *
 *   description  — Human-readable one-liner shown in /agent (list view) and /help.
 *                  Should describe the agent's primary purpose in one sentence.
 *
 *   model        — Optional Claude model string. When present, every API call made
 *                  while this agent is active uses this model instead of config.model.
 *                  When absent, config.model is used (the user's configured default).
 *                  Example: "claude-opus-4-6"
 *
 *   tools        — Optional array of tool name strings. When present, only the listed
 *                  tools are offered to the model in the API request. When absent (or
 *                  undefined), all registered tools are available. An empty array []
 *                  means NO tools are available — the agent operates in text-only mode.
 *                  Tool names must exactly match the `name` property on CodeAgentTool.
 *                  Example: ["read_file", "glob", "grep"]
 *
 *   systemPrompt — The full text of the agent's persona. Injected as the last section
 *                  of the system prompt, after working directory, CLAUDE.md content,
 *                  and before the optional tool constraint note.
 *                  Required and must be non-empty.
 */
export const AgentDefinitionSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'Agent name must be kebab-case (lowercase letters, digits, hyphens)'),
  description: z.string().min(1),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  systemPrompt: z.string().min(1),
})

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>

/**
 * Metadata attached to a loaded definition that records where it came from.
 * Used for diagnostics and precedence logging.
 */
export type AgentSource = 'built-in' | 'user-global' | 'project-local'

export interface LoadedAgent {
  readonly definition: AgentDefinition
  readonly source: AgentSource
  /** Absolute path for file-based sources; undefined for built-ins. */
  readonly filePath?: string
}
```

### Field semantics summary

| Field | Required | Default when absent | Effect |
|-------|----------|---------------------|--------|
| `name` | Yes | — | Used for lookup and display |
| `description` | Yes | — | Shown in `/agent` list |
| `model` | No | `config.model` | Overrides model per API call |
| `tools` | No | All tools available | Filters `tools[]` in API request |
| `systemPrompt` | Yes | — | Injected into system prompt |

---

## 3. Agent Definition File Format

Agent definitions are **Markdown files with YAML frontmatter**. The frontmatter block is delimited by `---` on its own line. The body (everything after the closing `---`) becomes the `systemPrompt`.

### 3.1 Frontmatter specification

```
---
name: <kebab-case-string>          # required
description: <one-line string>     # required
model: <claude-model-id>           # optional
tools:                             # optional — omit entirely for all tools
  - <tool_name>
  - <tool_name>
---

<system prompt body — plain text or markdown>
```

Rules:
- The opening `---` must be the very first line of the file (no leading whitespace or BOM).
- The closing `---` terminates the frontmatter. Everything after it is the system prompt.
- `tools` uses standard YAML list syntax: one `- item` per line, indented consistently.
- All string values may be quoted or unquoted per standard YAML rules.
- Unknown frontmatter keys are silently ignored (forward compatibility).

### 3.2 Complete examples for each built-in agent type

**default** — general coding assistant, no restrictions:

```markdown
---
name: default
description: General-purpose coding assistant with full tool access
---

You are an expert software engineer assisting with coding tasks.

Your capabilities include reading and modifying files, searching the codebase,
running shell commands, and providing detailed technical explanations.

Work methodically: understand the problem fully before acting, make targeted
changes, and explain your reasoning. Prefer surgical edits over full rewrites.
```

**code-reviewer** — read-only review persona with restricted tools:

```markdown
---
name: code-reviewer
description: Reviews code for quality, correctness, and maintainability
model: claude-opus-4-6
tools:
  - read_file
  - glob
  - grep
---

You are a senior engineer conducting a thorough code review.

Your role is to analyze code for:
- Correctness: logic errors, edge cases, off-by-one errors
- Readability: naming, structure, comments
- Maintainability: coupling, cohesion, duplication
- Performance: inefficient algorithms, unnecessary allocations
- Safety: mutation, unchecked inputs, missing error handling

Provide specific, actionable feedback. Reference line numbers.
Do not modify files — read and analyze only.
```

**security-reviewer** — STRIDE/CWE focused security analysis:

```markdown
---
name: security-reviewer
description: Performs security analysis using STRIDE and CWE frameworks
model: claude-opus-4-6
tools:
  - read_file
  - glob
  - grep
---

You are an application security engineer performing a security review.

Apply STRIDE threat modeling (Spoofing, Tampering, Repudiation, Information
Disclosure, Denial of Service, Elevation of Privilege) to every component
you examine.

Reference CWE identifiers when reporting vulnerabilities (e.g., CWE-89 for
SQL injection, CWE-79 for XSS, CWE-502 for insecure deserialization).

Structure your findings as:
  SEVERITY: [CRITICAL | HIGH | MEDIUM | LOW | INFO]
  CWE: CWE-XXX
  LOCATION: file:line
  DESCRIPTION: what the vulnerability is
  IMPACT: what an attacker can do
  REMEDIATION: specific fix with code example

Do not modify files. Read and report only.
```

**tdd-guide** — strict RED-GREEN-REFACTOR discipline:

```markdown
---
name: tdd-guide
description: Guides test-driven development with strict RED-GREEN-REFACTOR discipline
model: claude-opus-4-6
---

You are a TDD coach enforcing the RED-GREEN-REFACTOR cycle.

Rules you enforce without exception:
  RED:     Write a failing test first. Never write implementation before a test.
  GREEN:   Write the minimum code to make the test pass. No more.
  REFACTOR: Improve structure only after tests are green. Do not change behavior.

Before writing any implementation code, you must:
1. Write the test
2. Run it and confirm it FAILS (RED)
3. Write minimal implementation
4. Run it and confirm it PASSES (GREEN)
5. Refactor if needed, re-run to confirm still GREEN

If the user asks to implement something without a test, redirect them to write
the test first. Coverage target: 80% lines/branches minimum.
```

**architect** — design-first, no code writing:

```markdown
---
name: architect
description: System design and architecture advisor — design first, code second
model: claude-opus-4-6
tools:
  - read_file
  - glob
  - grep
---

You are a software architect focused on system design and long-term maintainability.

Your primary outputs are:
- Architecture diagrams (as ASCII or Mermaid)
- Module boundary definitions
- Interface contracts (TypeScript types/interfaces)
- Trade-off analyses with explicit pros/cons
- Migration paths for existing code

You do not write implementation code. You design systems, define contracts,
and explain decisions. When asked to implement, respond with a design document
first and obtain approval before any code is written.

Key concerns: scalability, testability, separation of concerns, dependency
direction, and avoiding accidental complexity.
```

**doc-writer** — accuracy-focused documentation:

```markdown
---
name: doc-writer
description: Writes and updates accurate, user-facing documentation
model: claude-sonnet-4-6
tools:
  - read_file
  - write_file
  - glob
  - grep
---

You are a technical writer who produces clear, accurate documentation.

Principles:
- Accuracy over completeness: only document what the code actually does
- Read the source before writing; never infer behavior without verification
- Use concrete examples with real inputs and outputs
- Keep docs close to the code they describe
- Write for the target audience (end users vs. contributors)

Documentation types you produce:
- README sections
- API reference (JSDoc / TSDoc)
- How-to guides with step-by-step examples
- Architecture overviews with diagrams

Always read the relevant source files before writing. If the implementation
contradicts existing docs, flag the discrepancy and update the docs to match.
```

---

## 4. src/agents/AgentLoader.ts

`AgentLoader` is responsible for reading a `.md` file from disk, parsing its YAML frontmatter, and returning a validated `AgentDefinition`. It has no external YAML library dependency — frontmatter parsing is implemented directly.

```typescript
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { AgentDefinitionSchema, type AgentDefinition } from './types.js'

/**
 * Raw parsed result from the frontmatter parser before zod validation.
 * Values are always strings or string arrays at this stage.
 */
interface RawFrontmatter {
  [key: string]: string | string[] | undefined
}

interface ParseResult {
  frontmatter: RawFrontmatter
  body: string
}

/**
 * parseFrontmatter
 *
 * Parses YAML frontmatter from a raw file string without external dependencies.
 *
 * Supported YAML subset:
 *   - Simple scalar:  key: value
 *   - Quoted scalar:  key: "value with spaces"
 *   - List:           key:\n  - item1\n  - item2
 *
 * The function does not support nested objects, multi-line scalars, or anchors.
 * These are intentionally excluded — agent frontmatter is always simple.
 *
 * Algorithm:
 *   1. Verify the file starts with "---\n"
 *   2. Find the closing "---" line
 *   3. Parse lines between the delimiters
 *   4. Return body as the text after the closing delimiter
 *
 * Throws a descriptive Error if:
 *   - The file does not start with "---"
 *   - No closing "---" is found
 */
export function parseFrontmatter(raw: string): ParseResult {
  const lines = raw.split('\n')

  if (lines[0]?.trimEnd() !== '---') {
    throw new Error(
      'Agent definition file must start with "---" on the first line. ' +
      `Got: ${JSON.stringify(lines[0])}`
    )
  }

  // Find the closing --- (must be at the start of a line, index > 0)
  let closingIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trimEnd() === '---') {
      closingIndex = i
      break
    }
  }

  if (closingIndex === -1) {
    throw new Error(
      'Agent definition file has an opening "---" but no closing "---". ' +
      'The frontmatter block was never terminated.'
    )
  }

  const frontmatterLines = lines.slice(1, closingIndex)
  const bodyLines = lines.slice(closingIndex + 1)
  const body = bodyLines.join('\n').trim()

  const frontmatter = parseFrontmatterLines(frontmatterLines)
  return { frontmatter, body }
}

/**
 * Parses an array of lines into a RawFrontmatter object.
 *
 * Handles three patterns:
 *
 *   "key: value"          → { key: "value" }
 *   "key: "quoted value"" → { key: "quoted value" }
 *   "key:\n  - a\n  - b"  → { key: ["a", "b"] }
 *
 * Lines that begin with "  -" or "- " without a preceding key line with no
 * value are treated as list items appended to the most recently seen list key.
 */
function parseFrontmatterLines(lines: string[]): RawFrontmatter {
  const result: RawFrontmatter = {}
  let currentListKey: string | null = null

  for (const line of lines) {
    // Skip blank lines and comment lines
    if (line.trim() === '' || line.trim().startsWith('#')) {
      continue
    }

    // List item: "  - value" or "- value"
    const listItemMatch = line.match(/^\s+-\s+(.+)$/)
    if (listItemMatch !== undefined && listItemMatch !== null && currentListKey !== null) {
      const item = listItemMatch[1]?.trim() ?? ''
      const existing = result[currentListKey]
      if (Array.isArray(existing)) {
        result[currentListKey] = [...existing, item]
      } else {
        result[currentListKey] = [item]
      }
      continue
    }

    // Key-value line: "key: value" or "key:"
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/)
    if (kvMatch === null || kvMatch === undefined) {
      continue // Unknown line format — skip silently
    }

    const key = kvMatch[1] ?? ''
    const rawValue = (kvMatch[2] ?? '').trim()

    if (rawValue === '') {
      // "key:" with no value — start of a list block
      currentListKey = key
      result[key] = []
    } else {
      currentListKey = null
      // Strip optional surrounding quotes
      const value = rawValue.replace(/^["']|["']$/g, '')
      result[key] = value
    }
  }

  return result
}

/**
 * fromFile
 *
 * Reads an agent definition file, parses its frontmatter, validates the result
 * with zod, and returns an AgentDefinition.
 *
 * Throws a descriptive error if:
 *   - The file cannot be read (permissions, not found)
 *   - The frontmatter is malformed
 *   - The parsed values fail zod validation
 *
 * The file path is always included in error messages for quick diagnosis.
 */
export async function fromFile(filePath: string): Promise<AgentDefinition> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    throw new Error(
      `Failed to read agent definition file "${filePath}": ${String(error)}`
    )
  }

  let parsed: ParseResult
  try {
    parsed = parseFrontmatter(raw)
  } catch (error) {
    throw new Error(
      `Malformed frontmatter in agent definition file "${filePath}": ${String(error)}`
    )
  }

  // Merge frontmatter fields with the body as systemPrompt
  const rawDefinition = {
    name: parsed.frontmatter['name'],
    description: parsed.frontmatter['description'],
    model: parsed.frontmatter['model'],
    tools: parsed.frontmatter['tools'],
    systemPrompt: parsed.body,
  }

  const validation = AgentDefinitionSchema.safeParse(rawDefinition)
  if (!validation.success) {
    const issues = validation.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new Error(
      `Invalid agent definition in "${filePath}":\n${issues}`
    )
  }

  return validation.data
}
```

### Error handling contract

| Failure mode | Error message pattern |
|---|---|
| File not found | `Failed to read agent definition file "<path>": ...` |
| Missing opening `---` | `Agent definition file must start with "---" on the first line. Got: ...` |
| Missing closing `---` | `Agent definition file has an opening "---" but no closing "---". ...` |
| Invalid name format | `Invalid agent definition in "<path>": - name: Agent name must be kebab-case ...` |
| Empty system prompt | `Invalid agent definition in "<path>": - systemPrompt: ...` |

---

## 5. src/agents/AgentRegistry.ts

`AgentRegistry` discovers and holds all known agent definitions. It merges definitions from all three sources (built-ins, user-global, project-local) and resolves name conflicts by highest-priority source.

```typescript
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fromFile } from './AgentLoader.js'
import { BUILT_IN_AGENTS } from './built-in/index.js'
import type { AgentDefinition, LoadedAgent } from './types.js'

/**
 * AgentRegistry
 *
 * Responsible for discovering agent definitions from all sources and providing
 * name-based lookup with deterministic priority resolution.
 *
 * Priority order (highest to lowest):
 *   1. Project-local:  <cwd>/.codeagent/agents/*.md
 *   2. User-global:    ~/.codeagent/agents/*.md
 *   3. Built-in:       bundled definitions in built-in/index.ts
 *
 * When the same name appears in multiple sources, the higher-priority source
 * silently wins. This allows users to override built-ins by creating a file
 * with the same name (e.g., ~/.codeagent/agents/code-reviewer.md).
 */
export class AgentRegistry {
  /** Indexed by agent name; stores only the highest-priority definition. */
  private readonly agents: Map<string, LoadedAgent> = new Map()
  private loaded = false

  /**
   * load()
   *
   * Discovers all agents from all three sources. Must be called before
   * resolve() or list(). Safe to call multiple times (idempotent after first
   * successful load).
   *
   * Per-file errors from user/project directories are caught and logged as
   * warnings rather than thrown — a single malformed file should not prevent
   * the session from starting. Built-in loading errors are rethrown because
   * they indicate a code defect, not a user configuration error.
   */
  async load(workingDir: string = process.cwd()): Promise<void> {
    if (this.loaded) {
      return
    }

    // Load in reverse priority order so higher-priority sources overwrite lower.
    // 1. Built-ins (lowest priority)
    for (const definition of BUILT_IN_AGENTS) {
      this.agents.set(definition.name, { definition, source: 'built-in' })
    }

    // 2. User-global
    const userAgentsDir = path.join(os.homedir(), '.codeagent', 'agents')
    await this.loadDirectory(userAgentsDir, 'user-global')

    // 3. Project-local (highest priority)
    const projectAgentsDir = path.join(workingDir, '.codeagent', 'agents')
    await this.loadDirectory(projectAgentsDir, 'project-local')

    this.loaded = true
  }

  /**
   * loadDirectory
   *
   * Reads all *.md files in the given directory and loads each as an agent
   * definition. Directories that do not exist are silently skipped.
   *
   * Per-file parse/validation errors are caught and printed as warnings.
   * This ensures one broken file does not block discovery of other agents.
   */
  private async loadDirectory(
    dir: string,
    source: 'user-global' | 'project-local'
  ): Promise<void> {
    let entries: string[]
    try {
      const dirents = await fs.readdir(dir, { withFileTypes: true })
      entries = dirents
        .filter((d) => d.isFile() && d.name.endsWith('.md'))
        .map((d) => path.join(dir, d.name))
    } catch (error: unknown) {
      // Directory does not exist — not an error
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return
      }
      console.warn(`[AgentRegistry] Cannot read agent directory "${dir}": ${String(error)}`)
      return
    }

    for (const filePath of entries) {
      try {
        const definition = await fromFile(filePath)
        this.agents.set(definition.name, { definition, source, filePath })
      } catch (error) {
        console.warn(`[AgentRegistry] Skipping agent file "${filePath}": ${String(error)}`)
      }
    }
  }

  /**
   * resolve(name)
   *
   * Returns the AgentDefinition for the given name, or undefined if not found.
   * Must be called after load().
   */
  resolve(name: string): AgentDefinition | undefined {
    return this.agents.get(name)?.definition
  }

  /**
   * list()
   *
   * Returns all loaded agent definitions sorted alphabetically by name.
   * The "default" agent is always present (guaranteed by built-ins).
   */
  list(): AgentDefinition[] {
    return Array.from(this.agents.values())
      .map((entry) => entry.definition)
      .sort((a, b) => a.name.localeCompare(b.name))
  }
}
```

### Discovery behavior notes

- `loadDirectory` is called for user-global and project-local sources. If neither directory exists (fresh install), the built-ins are all that is available.
- A file named `.codeagent/agents/default.md` in the project repo will silently override the built-in `default` agent for that project — this is the intended behavior.
- Errors per file are warnings, not fatal. The registry logs `[AgentRegistry] Skipping ...` to stderr so the user can diagnose bad files without the session crashing.

---

## 6. src/agents/AgentManager.ts

`AgentManager` manages the **active agent** for a session. It provides the single source of truth for which agent is currently active and handles agent switches requested by the `/agent` slash command.

```typescript
import type { AgentDefinition } from './types.js'
import type { AgentRegistry } from './AgentRegistry.js'

/**
 * AgentManager
 *
 * Holds the active agent for the current session. Constructed once at startup
 * with the initial agent name. The active agent changes only via switchTo().
 *
 * The messages[] array in ConversationController is NOT owned or modified by
 * AgentManager. History is preserved across all agent switches.
 */
export class AgentManager {
  private activeAgent: AgentDefinition

  /**
   * @param registry  The loaded AgentRegistry to resolve names from.
   * @param initialAgentName  The agent to activate at startup.
   *
   * @throws {Error} If the initial agent name is not found in the registry.
   *   The error lists all available agent names so the user can correct the
   *   --agent flag value immediately.
   */
  constructor(
    private readonly registry: AgentRegistry,
    initialAgentName: string
  ) {
    const resolved = registry.resolve(initialAgentName)
    if (resolved === undefined) {
      const available = registry.list().map((a) => a.name).join(', ')
      throw new Error(
        `Unknown agent "${initialAgentName}". ` +
        `Available agents: ${available}`
      )
    }
    this.activeAgent = resolved
  }

  /**
   * current
   *
   * Returns the currently active AgentDefinition as a readonly reference.
   * Components should read from this getter; they should not cache the result
   * across turns because the agent may have been switched.
   */
  get current(): Readonly<AgentDefinition> {
    return this.activeAgent
  }

  /**
   * switchTo(name)
   *
   * Activates the agent with the given name and returns the new definition.
   * Subsequent calls to current will reflect the new agent.
   *
   * @throws {Error} If no agent with the given name is found.
   *   The error message lists all available agents, including their source
   *   (built-in / user-global / project-local), to help the user diagnose
   *   why a custom agent name is not being found.
   */
  switchTo(name: string): AgentDefinition {
    const resolved = this.registry.resolve(name)
    if (resolved === undefined) {
      const available = this.registry
        .list()
        .map((a) => `  ${a.name}`)
        .join('\n')
      throw new Error(
        `Cannot switch to agent "${name}" — not found.\n` +
        `Available agents:\n${available}\n\n` +
        `To add a custom agent, create a file at:\n` +
        `  .codeagent/agents/${name}.md  (project-local)\n` +
        `  ~/.codeagent/agents/${name}.md  (user-global)`
      )
    }
    this.activeAgent = resolved
    return resolved
  }

  /**
   * listAll()
   *
   * Returns all known agents sorted by name. Delegates to the registry.
   * Used by the /agent command (no arguments) to print the full list.
   */
  listAll(): AgentDefinition[] {
    return this.registry.list()
  }
}
```

### State transition diagram

```
Session start
     │
     ▼
AgentManager(registry, "default")
     │
     │  active = default agent
     ▼
Each turn reads agentManager.current
     │
     ├─ /agent code-reviewer  ──► switchTo("code-reviewer")
     │                              active = code-reviewer
     │                              messages[] unchanged
     │
     ├─ /agent unknown-name   ──► throws Error with available list
     │
     └─ any turn              ──► reads current (possibly code-reviewer)
```

---

## 7. src/agents/built-in/index.ts

Six built-in agents are bundled with the CLI. They are plain `AgentDefinition` objects declared in TypeScript — no file I/O required for the built-in registry path.

```typescript
import type { AgentDefinition } from '../types.js'

export const BUILT_IN_AGENTS: readonly AgentDefinition[] = [
  {
    name: 'default',
    description: 'General-purpose coding assistant with full tool access',
    model: undefined,
    tools: undefined,
    systemPrompt: `You are an expert software engineer assisting with coding tasks.

Your capabilities include reading and modifying files, searching the codebase,
running shell commands, and providing detailed technical explanations.

Work methodically: understand the problem fully before acting, make targeted
changes, and explain your reasoning. Prefer surgical edits over full rewrites.
When modifying existing code, change only what is necessary to fulfill the request.`,
  },

  {
    name: 'code-reviewer',
    description: 'Reviews code for quality, correctness, and maintainability',
    model: 'claude-opus-4-6',
    tools: ['read_file', 'glob', 'grep'],
    systemPrompt: `You are a senior engineer conducting a thorough code review.

Analyze code for:
- Correctness: logic errors, edge cases, off-by-one errors, race conditions
- Readability: clear naming, appropriate comments, consistent structure
- Maintainability: low coupling, high cohesion, no unnecessary duplication
- Performance: inefficient algorithms, unnecessary allocations, blocking operations
- Safety: mutation of shared state, unvalidated inputs, missing error handling

Provide specific, actionable feedback with file and line references.
Group findings by severity: CRITICAL, HIGH, MEDIUM, LOW, INFO.
Do not modify files — read and analyze only.`,
  },

  {
    name: 'security-reviewer',
    description: 'Security analysis using STRIDE threat modeling and CWE identifiers',
    model: 'claude-opus-4-6',
    tools: ['read_file', 'glob', 'grep'],
    systemPrompt: `You are an application security engineer performing a security code review.

Apply STRIDE threat modeling to every component you examine:
  S — Spoofing identity
  T — Tampering with data
  R — Repudiation
  I — Information disclosure
  D — Denial of service
  E — Elevation of privilege

Reference CWE identifiers for all findings (e.g., CWE-89 SQL Injection,
CWE-79 XSS, CWE-502 Insecure Deserialization, CWE-312 Cleartext Storage).

Format each finding as:
  SEVERITY: [CRITICAL | HIGH | MEDIUM | LOW | INFO]
  CWE: CWE-XXX — Name
  LOCATION: <file>:<line>
  DESCRIPTION: what the vulnerability is
  IMPACT: what an attacker can achieve
  REMEDIATION: specific fix with a code example

Do not modify files. Read and report only.`,
  },

  {
    name: 'tdd-guide',
    description: 'Test-driven development coach enforcing RED-GREEN-REFACTOR cycle',
    model: 'claude-opus-4-6',
    tools: undefined,
    systemPrompt: `You are a TDD coach who enforces the RED-GREEN-REFACTOR cycle without exception.

The three phases:
  RED:     Write a failing test first. Run it. Confirm it fails.
           Never write implementation code before a test.
  GREEN:   Write the minimum code that makes the test pass. Nothing more.
           Resist the urge to generalize or abstract at this stage.
  REFACTOR: With all tests green, improve structure without changing behavior.
            Re-run tests after every change to confirm they remain green.

If the user asks to implement something without a test, redirect them:
  "Before implementing this, let's write the test first. What should the
   function do when called with [concrete example]?"

Coverage target: 80% lines, branches, and functions minimum.
Every edge case the user mentions must have a corresponding test.`,
  },

  {
    name: 'architect',
    description: 'System design advisor — produces designs and contracts before code',
    model: 'claude-opus-4-6',
    tools: ['read_file', 'glob', 'grep'],
    systemPrompt: `You are a software architect. You design systems before code is written.

Your outputs include:
- ASCII or Mermaid architecture diagrams
- Module boundary definitions with explicit dependency rules
- TypeScript interface and type contracts
- Trade-off analyses with explicit pros and cons
- Migration paths for existing code

You do not write implementation code. When asked to implement, respond with:
1. A design document (interfaces, diagrams, decision rationale)
2. A request for approval before any implementation proceeds

Key concerns: scalability, testability, separation of concerns, unidirectional
dependency flow, and avoiding accidental complexity. Prefer explicit contracts
over convention-based coupling.`,
  },

  {
    name: 'doc-writer',
    description: 'Technical writer producing accurate user-facing documentation',
    model: 'claude-sonnet-4-6',
    tools: ['read_file', 'write_file', 'glob', 'grep'],
    systemPrompt: `You are a technical writer who produces clear, accurate documentation.

Core principles:
- Accuracy over completeness: only document what the code actually does
- Read the source before writing; never infer behavior without verification
- Use concrete examples with real inputs and expected outputs
- Write for the stated audience (end users vs. contributors)
- Keep docs close to the code they describe

Documentation types:
- README sections and getting-started guides
- API reference (JSDoc / TSDoc with @param, @returns, @throws, @example)
- How-to guides with numbered steps
- Architecture overviews with diagrams

Before writing any documentation, read the relevant source files.
If implementation contradicts existing docs, flag the discrepancy and update
the docs to match the implementation — not the other way around.`,
  },
] as const
```

---

## 8. Integration with ConversationController

`ConversationController` consumes `AgentManager` on every turn. The integration touches three concerns: tool filtering, system prompt composition, and model selection.

### 8.1 activeToolDefinitions()

Returns the subset of tools that the active agent is allowed to use. If `agent.tools` is undefined, all registered tools are returned unchanged.

```typescript
// Inside ConversationController

private activeToolDefinitions(): ToolDefinition[] {
  const all = this.toolDispatcher.allDefinitions()
  const allowlist = this.agentManager.current.tools

  if (allowlist === undefined) {
    return all
  }

  const allowedSet = new Set(allowlist)
  return all.filter((tool) => allowedSet.has(tool.name))
}
```

This filtered list is passed directly as the `tools` array in the Anthropic API request. The model will only see and call tools that appear in this list.

### 8.2 buildSystemPrompt()

Composes the full system prompt from four ordered sections. The agent's `systemPrompt` is always the final behavioral section.

```typescript
private buildSystemPrompt(): string {
  const agent = this.agentManager.current
  const sections: string[] = []

  // 1. Working directory and current date
  sections.push(
    `Working directory: ${this.config.workingDir}\n` +
    `Current date: ${new Date().toISOString().slice(0, 10)}`
  )

  // 2. Project instructions (CLAUDE.md), if present
  if (this.projectContext !== undefined && this.projectContext.length > 0) {
    sections.push(`# Project Instructions\n\n${this.projectContext}`)
  }

  // 3. Active agent persona
  sections.push(agent.systemPrompt)

  // 4. Tool constraint note, if the agent has a restricted allowlist
  if (agent.tools !== undefined) {
    sections.push(
      `Note: In this session you have access only to these tools: ` +
      `${agent.tools.join(', ')}.`
    )
  }

  return sections.join('\n\n---\n\n')
}
```

### 8.3 runAgenticLoop() — model resolution

The model used for the API call is resolved per-turn from the active agent, with fallback to the user's configured default.

```typescript
private async runAgenticLoop(messages: MessageParam[]): Promise<void> {
  const agent = this.agentManager.current
  const model = agent.model ?? this.config.model  // agent override takes precedence

  const tools = this.activeToolDefinitions()
  const systemPrompt = this.buildSystemPrompt()

  // Stream from the Anthropic client using resolved model
  const stream = this.client.stream(messages, tools, systemPrompt, model)

  // ... handle streaming events, tool calls, agentic loop recursion
}
```

### 8.4 Agent switch — /agent command integration

The `AgentCommand` slash command calls `agentManager.switchTo()` and then the next user turn runs with the new agent. The `messages[]` array is never touched by a switch.

```typescript
// src/commands/built-in/AgentCommand.ts

export class AgentCommand implements SlashCommand {
  readonly name = 'agent'
  readonly description = 'List available agents or switch active agent'

  async execute(args: string, ctx: CommandContext): Promise<void> {
    const name = args.trim()

    if (name === '') {
      // List all agents
      const agents = ctx.agentManager.listAll()
      const current = ctx.agentManager.current.name
      const lines = agents.map((a) => {
        const marker = a.name === current ? ' (active)' : ''
        return `  ${a.name}${marker} — ${a.description}`
      })
      ctx.output.writeLine('Available agents:\n' + lines.join('\n'))
      return
    }

    try {
      const next = ctx.agentManager.switchTo(name)
      ctx.output.writeLine(
        `Switched to agent "${next.name}".` +
        (next.model !== undefined ? ` Model: ${next.model}.` : '') +
        (next.tools !== undefined ? ` Tools: ${next.tools.join(', ')}.` : '')
      )
    } catch (error) {
      ctx.output.writeLine(String(error))
    }
  }
}
```

After a switch, the **next call to `buildSystemPrompt()` and `activeToolDefinitions()`** automatically uses the new agent's values because both methods read from `agentManager.current` at call time.

---

## 9. Test Cases

### 9.1 AgentLoader — parseFrontmatter

```typescript
describe('parseFrontmatter', () => {
  it('parses scalar fields', () => {
    const raw = '---\nname: foo\ndescription: Bar\n---\nBody text.'
    const result = parseFrontmatter(raw)
    expect(result.frontmatter['name']).toBe('foo')
    expect(result.frontmatter['description']).toBe('Bar')
    expect(result.body).toBe('Body text.')
  })

  it('parses quoted scalar values', () => {
    const raw = '---\nname: "my-agent"\n---\nBody.'
    const result = parseFrontmatter(raw)
    expect(result.frontmatter['name']).toBe('my-agent')
  })

  it('parses a YAML list', () => {
    const raw = '---\ntools:\n  - read_file\n  - glob\n---\nBody.'
    const result = parseFrontmatter(raw)
    expect(result.frontmatter['tools']).toEqual(['read_file', 'glob'])
  })

  it('throws when file does not start with ---', () => {
    expect(() => parseFrontmatter('name: foo\n---\nBody.')).toThrow(
      'must start with "---"'
    )
  })

  it('throws when closing --- is missing', () => {
    expect(() => parseFrontmatter('---\nname: foo\nBody.')).toThrow(
      'no closing "---"'
    )
  })
})
```

### 9.2 AgentRegistry — priority resolution

```typescript
describe('AgentRegistry priority', () => {
  it('project-local overrides user-global overrides built-in', async () => {
    // Create a project-local default.md with custom systemPrompt
    // Load registry with that workingDir
    // Expect resolve('default').systemPrompt to be the project-local version
  })

  it('user-global overrides built-in', async () => {
    // Create a user-global code-reviewer.md with modified description
    // Load registry
    // Expect resolve('code-reviewer').description to be the user-global version
  })

  it('returns undefined for unknown agent name', async () => {
    const registry = new AgentRegistry()
    await registry.load('/tmp')
    expect(registry.resolve('nonexistent')).toBeUndefined()
  })

  it('skips malformed files and loads the rest', async () => {
    // Create directory with one valid .md and one malformed .md
    // Expect one agent loaded, one warning logged
  })
})
```

### 9.3 AgentManager — switchTo error message

```typescript
describe('AgentManager', () => {
  it('throws with available agent list when initial name is unknown', () => {
    expect(() => new AgentManager(loadedRegistry, 'no-such-agent'))
      .toThrow('Available agents:')
  })

  it('switchTo returns the new definition', () => {
    const manager = new AgentManager(loadedRegistry, 'default')
    const next = manager.switchTo('code-reviewer')
    expect(next.name).toBe('code-reviewer')
    expect(manager.current.name).toBe('code-reviewer')
  })

  it('switchTo throws with helpful message listing available agents', () => {
    const manager = new AgentManager(loadedRegistry, 'default')
    expect(() => manager.switchTo('bad-name')).toThrow('Cannot switch to agent "bad-name"')
    expect(() => manager.switchTo('bad-name')).toThrow('Available agents:')
    expect(() => manager.switchTo('bad-name')).toThrow('.codeagent/agents/bad-name.md')
  })
})
```

### 9.4 Tool filtering — activeToolDefinitions

```typescript
describe('activeToolDefinitions', () => {
  it('returns all tools when agent.tools is undefined', () => {
    // Set active agent to "default" (tools: undefined)
    // Expect activeToolDefinitions() to return all registered tools
  })

  it('filters to allowlist when agent.tools is set', () => {
    // Set active agent to "code-reviewer" (tools: [read_file, glob, grep])
    // Expect activeToolDefinitions() to return only those 3 tools
  })

  it('returns empty array when agent.tools is []', () => {
    // Create a text-only agent with tools: []
    // Expect activeToolDefinitions() to return []
  })
})
```

### 9.5 System prompt composition order

```typescript
describe('buildSystemPrompt', () => {
  it('includes all four sections in order', () => {
    const prompt = controller.buildSystemPrompt()
    const wdIdx = prompt.indexOf('Working directory:')
    const claudeMdIdx = prompt.indexOf('# Project Instructions')
    const personaIdx = prompt.indexOf('You are an expert')
    const toolNoteIdx = prompt.indexOf('Note: In this session')
    expect(wdIdx).toBeLessThan(claudeMdIdx)
    expect(claudeMdIdx).toBeLessThan(personaIdx)
    expect(personaIdx).toBeLessThan(toolNoteIdx)
  })

  it('omits tool note when agent.tools is undefined', () => {
    // Switch to "default" agent
    const prompt = controller.buildSystemPrompt()
    expect(prompt).not.toContain('Note: In this session')
  })
})
```
