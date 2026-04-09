# DESIGN_F11 — Project Context Loader & CLAUDE.md Injection (F11, F25)

> Features: F11 (Project context loader), F25 (CLAUDE.md injection spec)
> Phase: 2
> Module: `src/conversation/ProjectContextLoader.ts`

---

## 1. Purpose

The Project Context Loader reads `CLAUDE.md` from the working directory once at session startup and injects its content into the **system prompt**. This allows repository maintainers to give Claude project-specific instructions — coding conventions, architecture notes, forbidden patterns — that apply for the entire session without consuming `messages[]` context.

Analogy: CLAUDE.md is like the employee handbook given to a contractor on their first day. It stays on the desk (system prompt) the whole time, not in every email exchange. Switching to a different task (agent switch) doesn't require handing back the handbook — it remains available throughout.

---

## 2. ProjectContextLoader

**File:** `src/conversation/ProjectContextLoader.ts`

```typescript
// src/conversation/ProjectContextLoader.ts
import fs from 'node:fs'
import path from 'node:path'

const CLAUDE_MD_FILENAME = 'CLAUDE.md'
const MAX_CONTEXT_CHARS = 20_000
const TRUNCATION_NOTICE =
  '\n\n[CLAUDE.md truncated: content exceeded 20,000 characters. ' +
  'Only the first 20,000 characters are included.]'

export interface ProjectContextResult {
  /** The content to inject into the system prompt. Empty string if not found. */
  content: string
  /** Whether CLAUDE.md was found */
  found: boolean
  /** Full path to the CLAUDE.md file that was read */
  filePath: string
  /** Whether the content was truncated */
  truncated: boolean
}

/**
 * Load the CLAUDE.md project context file from the working directory.
 *
 * Behavior:
 * - If the file does not exist: returns empty content, no error
 * - If the file exists but is unreadable: returns empty content, no error
 * - If the file content exceeds 20,000 chars: truncates with notice
 *
 * @param workingDir - The working directory to search for CLAUDE.md
 */
export async function loadProjectContext(workingDir: string): Promise<ProjectContextResult> {
  const filePath = path.join(workingDir, CLAUDE_MD_FILENAME)

  if (!fs.existsSync(filePath)) {
    return {
      content: '',
      found: false,
      filePath,
      truncated: false,
    }
  }

  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    // Unreadable file — proceed without project context
    return {
      content: '',
      found: false,
      filePath,
      truncated: false,
    }
  }

  if (raw.length <= MAX_CONTEXT_CHARS) {
    return {
      content: raw,
      found: true,
      filePath,
      truncated: false,
    }
  }

  return {
    content: raw.slice(0, MAX_CONTEXT_CHARS) + TRUNCATION_NOTICE,
    found: true,
    filePath,
    truncated: true,
  }
}
```

---

## 3. When and How It Is Loaded

### 3.1 Loading Timing

`loadProjectContext` is called once in the `ConversationController` constructor, before the REPL loop starts. This is the only time the file is read — subsequent turns do not re-read it.

```typescript
// src/conversation/ConversationController.ts
export class ConversationController {
  private readonly projectContext: string
  private readonly logger: Logger

  // Note: constructor must be called with await at the call site
  // OR projectContext is loaded synchronously — we use sync readFileSync above
  // to keep the constructor synchronous.

  constructor(config: ResolvedConfig, agentManager: AgentManager) {
    // ...other initialization...

    // Load project context synchronously at startup.
    // Async version available via a static factory if preferred.
    const result = loadProjectContextSync(config.workingDirectory)
    this.projectContext = result.content

    if (result.found) {
      this.logger.info('Project context loaded', {
        path: result.filePath,
        chars: result.content.length,
        truncated: result.truncated,
      })
      if (result.truncated) {
        this.logger.warn('CLAUDE.md truncated', {
          path: result.filePath,
          originalSize: 'unknown (> 20,000 chars)',
        })
      }
    } else {
      this.logger.debug('No CLAUDE.md found', { path: result.filePath })
    }
  }
}
```

For callers that prefer an async constructor pattern, a static factory is provided:

```typescript
static async create(config: ResolvedConfig, agentManager: AgentManager): Promise<ConversationController> {
  const context = await loadProjectContext(config.workingDirectory)
  return new ConversationController(config, agentManager, context.content)
}
```

### 3.2 Storage

The project context is stored as a `private readonly string` field on `ConversationController`. It is never added to `messages[]`.

---

## 4. System Prompt Composition

### 4.1 Composition Order

The system prompt is built by `buildSystemPrompt()` inside `ConversationController` each time the API is called. It has a fixed structure with five sections:

```
Section 1: Working directory + today's date
Section 2: Project instructions (CLAUDE.md) — if present
Section 3: Git context — if available (see DESIGN_F14.md)
Section 4: Agent persona (active agent's systemPrompt)
Section 5: Tool constraint note — if agent has a tool allowlist
```

### 4.2 Implementation

```typescript
// src/conversation/ConversationController.ts

private buildSystemPrompt(): string {
  const sections: string[] = []

  // --- Section 1: Working directory and date ---
  sections.push(
    `Working directory: ${this.config.workingDirectory}\n` +
    `Today's date: ${new Date().toISOString().slice(0, 10)}`
  )

  // --- Section 2: Project instructions from CLAUDE.md ---
  if (this.projectContext.trim()) {
    sections.push(
      '## Project Instructions (CLAUDE.md)\n\n' +
      this.projectContext.trim()
    )
  }

  // --- Section 3: Git context (loaded separately, see DESIGN_F14.md) ---
  if (this.gitContext) {
    sections.push(this.formatGitContext(this.gitContext))
  }

  // --- Section 4: Agent persona ---
  const agent = this.agentManager.current
  sections.push(
    '## Agent Persona\n\n' +
    agent.systemPrompt
  )

  // --- Section 5: Tool constraint note ---
  if (agent.tools && agent.tools.length > 0) {
    sections.push(
      `Available tools: ${agent.tools.join(', ')}\n` +
      `You must only use tools in the above list. Do not invoke any other tools.`
    )
  }

  return sections.join('\n\n---\n\n')
}
```

### 4.3 Section Separators

Sections are separated by `\n\n---\n\n` (a horizontal rule with surrounding blank lines). This makes the system prompt readable in debug mode and clearly delineates each concern for the model.

### 4.4 Full System Prompt Example

For a session with:
- Working directory: `/home/user/my-project`
- CLAUDE.md present with project instructions
- Default agent (no tool allowlist)

```
Working directory: /home/user/my-project
Today's date: 2026-04-05

---

## Project Instructions (CLAUDE.md)

# My Project

Always use TypeScript strict mode.
Never import from 'lodash' — use native equivalents.
Tests must be colocated with source files.

---

## Agent Persona

You are CodeAgent, an AI coding assistant. You help developers read, understand,
and modify code. You have access to tools for reading files, writing files,
running shell commands, searching code, and editing files.

Always explain what you're about to do before using a tool.
When editing files, prefer surgical edits over full rewrites.
```

---

## 5. CLAUDE.md Format Specification (F25)

### 5.1 File Format

`CLAUDE.md` is **free-form Markdown** with no required schema or frontmatter. Any Markdown content is accepted. The file is injected verbatim (after truncation if needed) — it is not parsed, structured, or validated.

### 5.2 Recommended Content

While not required, effective `CLAUDE.md` files typically include:

```markdown
# Project Name

## Tech Stack
- Language: TypeScript (strict)
- Runtime: Node 22
- Package manager: pnpm

## Coding Conventions
- Use immutable patterns — never mutate objects
- Prefer `zod` for validation at system boundaries
- Files max 800 lines; functions max 50 lines

## Forbidden Patterns
- No `any` types
- No `console.log` in production code
- No hardcoded secrets

## Testing
- Colocated *.test.ts files
- Run: pnpm test
- 80%+ coverage required

## Architecture Notes
- Source: src/
- Config: src/config/
- Tools: src/tools/
```

### 5.3 Scope and Lifetime

| Property | Behavior |
|----------|---------|
| Loaded | Once, at session startup |
| Stored in | `ConversationController.projectContext` (private field) |
| Injected into | System prompt only (not `messages[]`) |
| Survives agent switch | Yes — system prompt is rebuilt with same `projectContext` |
| Re-loaded on `/clear` | No — messages are cleared but `projectContext` remains |
| Max size | 20,000 characters (truncated with notice if exceeded) |
| If not found | Empty string — no error, session continues normally |
| Encoding | UTF-8 |

### 5.4 Why System Prompt, Not Messages

Injecting CLAUDE.md into `messages[]` would have two problems:

1. **Context window cost:** It would count against the conversation history budget and be re-sent on every turn as part of `messages[]`.
2. **Compaction risk:** If the context manager compacts old messages, CLAUDE.md instructions could be summarized or dropped.

Placing it in the **system prompt** ensures:
- It is always present on every API call
- It is outside the compaction window
- It does not grow the `messages[]` array

### 5.5 CLAUDE.md Is NOT Re-Injected on Agent Switch

When the user runs `/agent code-reviewer`, `buildSystemPrompt()` is called again with the new agent's `systemPrompt`. The `projectContext` field is unchanged, so CLAUDE.md content appears in the rebuilt system prompt automatically.

This is the correct behavior: the project's coding conventions apply regardless of which agent is active.

---

## 6. Synchronous vs Async Loading

The loader provides both sync and async variants for flexibility:

```typescript
// Async version (preferred for startup factories)
export async function loadProjectContext(workingDir: string): Promise<ProjectContextResult>

// Sync version (used inside synchronous constructor)
export function loadProjectContextSync(workingDir: string): ProjectContextResult {
  const filePath = path.join(workingDir, CLAUDE_MD_FILENAME)
  if (!fs.existsSync(filePath)) return { content: '', found: false, filePath, truncated: false }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    if (raw.length <= MAX_CONTEXT_CHARS) {
      return { content: raw, found: true, filePath, truncated: false }
    }
    return {
      content: raw.slice(0, MAX_CONTEXT_CHARS) + TRUNCATION_NOTICE,
      found: true,
      filePath,
      truncated: true,
    }
  } catch {
    return { content: '', found: false, filePath, truncated: false }
  }
}
```

---

## 7. Test Cases

```typescript
// src/conversation/ProjectContextLoader.test.ts
import { describe, it, expect } from 'vitest'
import { loadProjectContext, loadProjectContextSync } from './ProjectContextLoader.ts'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function withTempDir(fn: (dir: string) => void | Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-test-'))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('loadProjectContext', () => {
  it('returns empty content when CLAUDE.md does not exist', async () => {
    await withTempDir(async dir => {
      const result = await loadProjectContext(dir)
      expect(result.found).toBe(false)
      expect(result.content).toBe('')
      expect(result.truncated).toBe(false)
    })
  })

  it('returns file content when CLAUDE.md exists', async () => {
    await withTempDir(async dir => {
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Hello\nWorld')
      const result = await loadProjectContext(dir)
      expect(result.found).toBe(true)
      expect(result.content).toBe('# Hello\nWorld')
    })
  })

  it('truncates content exceeding 20,000 characters', async () => {
    await withTempDir(async dir => {
      const longContent = 'x'.repeat(25_000)
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), longContent)
      const result = await loadProjectContext(dir)
      expect(result.truncated).toBe(true)
      expect(result.content.length).toBeLessThan(25_000)
      expect(result.content).toContain('[CLAUDE.md truncated')
    })
  })

  it('returns empty content when file is unreadable', async () => {
    await withTempDir(async dir => {
      const filePath = path.join(dir, 'CLAUDE.md')
      fs.writeFileSync(filePath, 'content')
      fs.chmodSync(filePath, 0o000) // unreadable
      const result = await loadProjectContext(dir)
      expect(result.found).toBe(false)
      expect(result.content).toBe('')
      fs.chmodSync(filePath, 0o644) // restore for cleanup
    })
  })

  it('includes full content when exactly at 20,000 chars', async () => {
    await withTempDir(async dir => {
      const exactContent = 'a'.repeat(20_000)
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), exactContent)
      const result = await loadProjectContext(dir)
      expect(result.truncated).toBe(false)
      expect(result.content).toBe(exactContent)
    })
  })
})

describe('buildSystemPrompt composition', () => {
  it('includes CLAUDE.md section header when content is present', () => {
    // Uses ConversationController with mock projectContext
    // Checks that '## Project Instructions (CLAUDE.md)' appears in system prompt
  })

  it('omits CLAUDE.md section when content is empty', () => {
    // Checks that no CLAUDE.md section appears for repos without CLAUDE.md
  })

  it('includes agent persona section always', () => {
    // Checks that '## Agent Persona' is always present
  })

  it('includes tool constraint note only when agent has tool allowlist', () => {
    // Agent with tools: ['read_file'] → note appears
    // Agent with tools: undefined → note absent
  })

  it('sections are separated by horizontal rules', () => {
    // Checks that '---' appears between sections
  })
})
```

---

## 8. Summary

| Concern | Decision |
|---------|----------|
| Load timing | Once, at session startup (constructor) |
| Storage | `private readonly projectContext: string` in `ConversationController` |
| Injection target | System prompt only — never `messages[]` |
| Max size | 20,000 characters — truncated with notice |
| Agent switch | CLAUDE.md survives — system prompt rebuilt with same field |
| `/clear` | `messages[]` cleared; `projectContext` unchanged |
| File not found | Empty string — silent, no error, session continues |
| System prompt order | Dir/date → CLAUDE.md → Git context → Agent persona → Tool note |
| CLAUDE.md format | Free-form Markdown — no required schema or frontmatter |
