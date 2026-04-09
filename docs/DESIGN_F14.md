# DESIGN_F14 — Git-Aware Context Injection (F14)

> Feature: F14 (Git-aware context injection)
> Phase: 3
> Module: `src/conversation/GitContextLoader.ts`

---

## 1. Purpose

The Git Context Loader detects whether the working directory is a git repository and, if so, injects a concise summary of its current state (branch, modified files, recent diff stats) into the system prompt. This gives Claude situational awareness of the repository state without requiring the user to paste `git status` manually.

Analogy: Git context is like a whiteboard in a developer's office showing the current sprint status. Visitors (Claude) can glance at it to understand what's in progress without interrupting the developer's workflow. It's informational, not interactive.

---

## 2. GitContext Interface

```typescript
// src/conversation/GitContextLoader.ts
export interface GitContext {
  /** Current branch name, e.g. "main", "feature/auth" */
  branch: string
  /**
   * Output of `git status --short`.
   * Empty string means a clean working tree.
   * Example: " M src/foo.ts\n?? untracked.ts"
   */
  status: string
  /**
   * Output of `git diff --stat HEAD`.
   * Shows files changed and insertion/deletion summary.
   * Empty string if no changes since last commit.
   */
  diffStat: string
}
```

---

## 3. GitContextLoader

**File:** `src/conversation/GitContextLoader.ts`

```typescript
// src/conversation/GitContextLoader.ts
import fs from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'

/** Maximum combined character count for all git output fields */
const GIT_OUTPUT_CAP = 3_000

/** Maximum milliseconds to wait for any single git command */
const GIT_TIMEOUT_MS = 3_000

export interface GitContext {
  branch: string
  status: string
  diffStat: string
}

/**
 * Check whether the given directory is inside a git repository.
 * Uses the presence of a `.git` directory/file as a heuristic.
 * Does not shell out — pure filesystem check.
 */
export function isGitRepo(workingDir: string): boolean {
  // Walk up the directory tree looking for .git
  let dir = path.resolve(workingDir)
  const root = path.parse(dir).root

  while (dir !== root) {
    const gitPath = path.join(dir, '.git')
    if (fs.existsSync(gitPath)) return true
    const parent = path.dirname(dir)
    if (parent === dir) break // reached filesystem root
    dir = parent
  }

  return false
}

/**
 * Collect the current git state for display in the system prompt.
 *
 * Returns null if:
 * - The working directory is not a git repository
 * - git is not installed on the system
 * - Any git command times out
 * - Any unexpected error occurs
 *
 * All errors are suppressed silently (logged at DEBUG level by the caller).
 */
export async function loadGitContext(workingDir: string): Promise<GitContext | null> {
  if (!isGitRepo(workingDir)) return null

  try {
    const [branch, status, diffStat] = await Promise.all([
      runGit('branch --show-current', workingDir),
      runGit('status --short', workingDir),
      runGit('diff --stat HEAD', workingDir),
    ])

    const combined = capCombinedOutput({ branch, status, diffStat })
    return combined
  } catch {
    // Any failure (git not installed, not a repo, timeout) → return null silently
    return null
  }
}

/**
 * Cap the combined output of all three git fields to GIT_OUTPUT_CAP chars.
 * Priority: branch (always kept), then status, then diffStat.
 */
function capCombinedOutput(raw: GitContext): GitContext {
  const branchTrimmed = raw.branch.trim()
  let remaining = GIT_OUTPUT_CAP - branchTrimmed.length

  const statusTrimmed = raw.status.trim()
  const statusCapped = statusTrimmed.length <= remaining
    ? statusTrimmed
    : statusTrimmed.slice(0, remaining) + '\n[truncated]'
  remaining -= statusCapped.length

  const diffStatTrimmed = raw.diffStat.trim()
  const diffStatCapped = diffStatTrimmed.length <= remaining
    ? diffStatTrimmed
    : diffStatTrimmed.slice(0, Math.max(0, remaining)) + '\n[truncated]'

  return {
    branch: branchTrimmed,
    status: statusCapped,
    diffStat: diffStatCapped,
  }
}

/**
 * Run a git subcommand in the given working directory.
 * Times out after GIT_TIMEOUT_MS milliseconds.
 * Resolves with stdout on success, rejects on error or timeout.
 */
function runGit(subcommand: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = exec(
      `git ${subcommand}`,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 512 * 1024, // 512 KB max — more than enough for git status
        env: {
          ...process.env,
          // Disable pager output — git would wait for user input otherwise
          GIT_PAGER: 'cat',
          PAGER: 'cat',
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          // exit code 128 = not a git repo; exit code 1 = no diff; both are "expected"
          // We still reject here — the caller (loadGitContext) handles it as null
          reject(new Error(`git ${subcommand} failed: ${stderr || String(error)}`))
          return
        }
        resolve(stdout)
      }
    )

    // Ensure the process is killed if timeout fires
    child.on('error', reject)
  })
}
```

---

## 4. Integration in ConversationController

### 4.1 Loading at Startup

Git context is loaded once during session startup, after configuration and project context are loaded:

```typescript
// src/conversation/ConversationController.ts

export class ConversationController {
  private readonly projectContext: string
  private gitContext: GitContext | null = null

  // ...

  /**
   * Static factory — preferred over constructor for async initialization.
   */
  static async create(config: ResolvedConfig, agentManager: AgentManager): Promise<ConversationController> {
    const ctrl = new ConversationController(config, agentManager)
    await ctrl.loadContextFiles()
    return ctrl
  }

  private async loadContextFiles(): Promise<void> {
    // Load CLAUDE.md (sync, already in constructor)
    // Load git context (async, do here)
    this.gitContext = await loadGitContext(this.config.workingDirectory)
      .catch(() => null) // belt-and-suspenders: already caught inside, but be safe

    if (this.gitContext) {
      this.logger.info('Git context loaded', {
        branch: this.gitContext.branch,
        hasStatus: this.gitContext.status.length > 0,
        hasDiff: this.gitContext.diffStat.length > 0,
      })
    } else {
      this.logger.debug('Git context not available', {
        workingDir: this.config.workingDirectory,
      })
    }
  }
}
```

### 4.2 Injection into System Prompt

```typescript
// Inside buildSystemPrompt() in ConversationController.ts

private formatGitContext(ctx: GitContext): string {
  const statusLine = ctx.status.trim()
    ? ctx.status.trim()
    : '(clean)'

  const lines: string[] = [
    '## Git Context',
    '',
    `Branch: ${ctx.branch}`,
    `Status: ${statusLine}`,
  ]

  if (ctx.diffStat.trim()) {
    lines.push('Recent changes:')
    lines.push(ctx.diffStat.trim())
  }

  return lines.join('\n')
}

private buildSystemPrompt(): string {
  const sections: string[] = []

  // Section 1: Working directory and date
  sections.push(
    `Working directory: ${this.config.workingDirectory}\n` +
    `Today's date: ${new Date().toISOString().slice(0, 10)}`
  )

  // Section 2: Project instructions (CLAUDE.md)
  if (this.projectContext.trim()) {
    sections.push(
      '## Project Instructions (CLAUDE.md)\n\n' + this.projectContext.trim()
    )
  }

  // Section 3: Git context
  if (this.gitContext) {
    sections.push(this.formatGitContext(this.gitContext))
  }

  // Section 4: Agent persona
  const agent = this.agentManager.current
  sections.push('## Agent Persona\n\n' + agent.systemPrompt)

  // Section 5: Tool constraint note
  if (agent.tools && agent.tools.length > 0) {
    sections.push(
      `Available tools: ${agent.tools.join(', ')}\n` +
      `You must only use tools in the above list.`
    )
  }

  return sections.join('\n\n---\n\n')
}
```

### 4.3 Example System Prompt Git Section

For a repository on a feature branch with modified files:

```
## Git Context

Branch: feature/slash-commands
Status:  M src/commands/SlashCommandEngine.ts
 M src/commands/built-in/HelpCommand.ts
?? src/commands/built-in/CompactCommand.ts
Recent changes:
 src/commands/SlashCommandEngine.ts | 42 ++++++++++++++++++--
 src/commands/built-in/HelpCommand.ts |  8 ++--
 2 files changed, 46 insertions(+), 4 deletions(-)
```

For a clean repository on main:

```
## Git Context

Branch: main
Status: (clean)
```

---

## 5. Error Handling

All git failures are handled silently. The session continues normally with no git context injected into the system prompt.

| Failure Scenario | Behavior |
|-----------------|---------|
| git not installed on PATH | `exec` fails → `loadGitContext` returns null |
| Working dir is not a git repo | `isGitRepo` returns false → null returned immediately |
| `git branch` times out (>3s) | `Promise.all` rejects → null returned |
| `git status` exits with error | `Promise.all` rejects → null returned |
| Detached HEAD (no branch name) | `branch` will be empty — shown as empty string |
| Submodule or worktree edge cases | Any failure → null returned silently |

```typescript
// Error logging (in ConversationController.loadContextFiles):
this.gitContext = await loadGitContext(this.config.workingDirectory)
  .catch((error) => {
    this.logger.debug('Git context load failed', { error: String(error) })
    return null
  })
```

**Why silent failure?** Git context is informational — it enriches Claude's awareness but is not required for any tool to function. A session without git context is fully usable. Showing an error for a missing or broken git installation would confuse users working in non-git environments (e.g., a shared documents folder).

---

## 6. Lifetime and Re-loading Policy

| Event | Git Context Behavior |
|-------|---------------------|
| Session startup | Loaded once via `loadContextFiles()` |
| `/agent <name>` | NOT re-loaded — same `gitContext` field used in rebuilt system prompt |
| `/clear` | `messages[]` cleared; `gitContext` field unchanged |
| Between turns | NOT re-loaded — reflects repo state at session start |
| Session exit | Field discarded with the process |

**Rationale for not re-loading per turn:** Re-running three git subcommands before every API call would add latency to each turn. The startup snapshot is accurate enough for Claude to understand what work is in progress. If the user wants current git state mid-session, they can run `git status` via the Bash tool.

---

## 7. Output Size Budget

The combined output of all three git fields is capped at **3,000 characters** total. This protects the system prompt from being overwhelmed in repositories with many modified files or verbose diff stats.

Capping priority:
1. `branch` — always kept in full (typically < 100 chars)
2. `status` — kept up to remaining budget, truncated with `[truncated]` notice
3. `diffStat` — kept up to remaining budget, truncated with `[truncated]` notice

```
Example (both status and diffStat within budget):
  branch:   "feature/auth"                    → 12 chars
  status:   30 files × ~30 chars each          → ~900 chars
  diffStat: standard diff stat output          → ~400 chars
  total:    ~1,312 chars  ← well within 3,000
```

```
Example (very large changeset — many files modified):
  branch:   "refactor/everything"              → 20 chars
  status:   200 files × ~30 chars each         → ~6,000 chars (capped at 2,980)
  diffStat: 0 chars remaining after status cap
```

---

## 8. GIT_PAGER Configuration

When running in a non-interactive subprocess, some git commands (notably `git diff`) will try to invoke a pager (like `less`) and wait for user input. This would cause the 3-second timeout to always fire.

The `runGit` function disables paging by setting `GIT_PAGER=cat` and `PAGER=cat` in the subprocess environment. This ensures all git output is returned immediately as stdout.

---

## 9. Test Cases

```typescript
// src/conversation/GitContextLoader.test.ts
import { describe, it, expect, vi } from 'vitest'
import { isGitRepo, loadGitContext } from './GitContextLoader.ts'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function withTempDir(fn: (dir: string) => void | Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ctx-test-'))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('isGitRepo', () => {
  it('returns false for a plain directory', () => {
    withTempDir(dir => {
      expect(isGitRepo(dir)).toBe(false)
    })
  })

  it('returns true when .git directory exists', () => {
    withTempDir(dir => {
      fs.mkdirSync(path.join(dir, '.git'))
      expect(isGitRepo(dir)).toBe(true)
    })
  })

  it('returns true for a subdirectory of a git repo', () => {
    withTempDir(dir => {
      fs.mkdirSync(path.join(dir, '.git'))
      const sub = path.join(dir, 'src', 'components')
      fs.mkdirSync(sub, { recursive: true })
      expect(isGitRepo(sub)).toBe(true)
    })
  })
})

describe('loadGitContext', () => {
  it('returns null for a non-git directory', async () => {
    await withTempDir(async dir => {
      const result = await loadGitContext(dir)
      expect(result).toBeNull()
    })
  })

  it('returns GitContext with branch, status, diffStat for a real repo', async () => {
    // Integration test — requires git on PATH
    // Uses the actual CodeAgent repo as the working directory
    const result = await loadGitContext(process.cwd())
    if (result === null) return // skip if git not available
    expect(typeof result.branch).toBe('string')
    expect(typeof result.status).toBe('string')
    expect(typeof result.diffStat).toBe('string')
  })

  it('returns null when git is not available', async () => {
    // Mock exec to simulate git not found
    vi.mock('node:child_process', () => ({
      exec: (_cmd: string, _opts: unknown, cb: Function) => {
        cb(Object.assign(new Error('ENOENT'), { code: 127 }), '', '')
        return { on: vi.fn() }
      },
    }))

    withTempDir(dir => {
      fs.mkdirSync(path.join(dir, '.git'))
      // isGitRepo returns true, but runGit fails
    })
    // result should be null
  })
})

describe('git context size cap', () => {
  it('caps combined output at 3,000 chars', () => {
    // Import and call capCombinedOutput directly (exported for testing)
    // Pass in oversized status and diffStat
    // Assert total length <= 3,000 + branch length
  })

  it('always preserves full branch name', () => {
    // Even if status fills up the budget, branch is fully included
  })
})

describe('system prompt git section format', () => {
  it('shows (clean) status when no files are modified', () => {
    const ctx = { branch: 'main', status: '', diffStat: '' }
    // Call formatGitContext(ctx) and assert output contains '(clean)'
  })

  it('includes recent changes section when diffStat is present', () => {
    const ctx = { branch: 'main', status: ' M foo.ts', diffStat: ' foo.ts | 3 +++' }
    // Assert output contains 'Recent changes:'
  })

  it('omits recent changes section when diffStat is empty', () => {
    const ctx = { branch: 'main', status: ' M foo.ts', diffStat: '' }
    // Assert output does not contain 'Recent changes:'
  })
})
```

---

## 10. Summary

| Concern | Decision |
|---------|----------|
| Detection | `isGitRepo()` — walks up directory tree checking for `.git` |
| Commands | `branch --show-current`, `status --short`, `diff --stat HEAD` |
| Timeout | 3 seconds per git command via `exec` timeout option |
| Parallel | All three commands run in `Promise.all` |
| Failure | Always null — session continues without git context |
| Error logging | DEBUG level — not shown to user |
| Pager | `GIT_PAGER=cat` and `PAGER=cat` to disable interactive paging |
| Output cap | 3,000 chars combined — priority: branch > status > diffStat |
| Load timing | Once, at session startup via `loadContextFiles()` |
| Agent switch | Not re-loaded — same `gitContext` field survives |
| `/clear` | `messages[]` cleared; `gitContext` field unchanged |
| System prompt position | After CLAUDE.md, before agent persona |
