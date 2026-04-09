# DESIGN_F9 — Extended Tools: Glob, Grep, EditFile & Diff Preview (F9, F10, F23)

> Features: F9 (Glob, Grep tools), F10 (EditFile tool), F23 (Diff preview)
> Phase: 2
> Modules: `src/tools/GlobTool.ts`, `src/tools/GrepTool.ts`, `src/tools/EditFileTool.ts`, `src/tools/diffPreview.ts`

---

## 1. Purpose

The extended tool set adds file discovery and surgical editing capabilities that Claude needs to navigate and modify large codebases. These tools complement the Phase 1 core tools (ReadFile, WriteFile, Bash).

Analogy: If ReadFile/WriteFile are like reading and rewriting a full page of a book, then GlobTool finds which books are in the library, GrepTool finds which pages mention a topic, and EditFileTool makes a surgical correction to a single paragraph — without touching the rest.

---

## 2. Shared Guards

All extended tools use the same safety guards from `src/tools/guards.ts`:

```typescript
// src/tools/guards.ts (excerpt — already defined in DESIGN_F3)
export function capOutput(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  const truncated = content.slice(0, maxChars)
  return truncated + `\n\n[Output truncated at ${maxChars} characters]`
}

export function assertSafePath(filePath: string, workingDir: string): void {
  const resolved = path.resolve(workingDir, filePath)
  if (!resolved.startsWith(path.resolve(workingDir))) {
    throw new Error(
      `Path traversal attempt blocked: "${filePath}" resolves outside working directory`
    )
  }
}
```

---

## 3. GlobTool

**File:** `src/tools/GlobTool.ts`

### 3.1 Purpose

Returns a list of file paths matching a glob pattern within a directory. Claude uses this to discover source files before reading or editing them.

### 3.2 Parameters Schema

```typescript
import { z } from 'zod'

export const GlobParamsSchema = z.object({
  pattern: z.string().min(1).describe(
    'Glob pattern to match (e.g., "**/*.ts", "src/**/*.test.ts")'
  ),
  path: z.string().optional().describe(
    'Directory to search in. Defaults to the current working directory.'
  ),
})

export type GlobParams = z.infer<typeof GlobParamsSchema>
```

### 3.3 Implementation

```typescript
// src/tools/GlobTool.ts
import { glob } from 'node:fs/promises'  // Node 22+ native glob
import path from 'node:path'
import type { ToolResult } from './types.ts'
import { assertSafePath, capOutput } from './guards.ts'
import type { ResolvedConfig } from '../config/types.ts'

export class GlobTool {
  constructor(private readonly config: ResolvedConfig) {}

  readonly name = 'glob'
  readonly description = 'Find files matching a glob pattern in the project directory'

  schema = GlobParamsSchema

  async execute(params: GlobParams): Promise<ToolResult> {
    const searchDir = params.path
      ? path.resolve(this.config.workingDirectory, params.path)
      : this.config.workingDirectory

    // Guard: the search directory must be within the working directory
    assertSafePath(searchDir, this.config.workingDirectory)

    let matches: string[]
    try {
      // node:fs/promises glob (Node 22+) — returns an async iterable
      const iter = glob(params.pattern, {
        cwd: searchDir,
        withFileTypes: false,
      })
      matches = []
      for await (const match of iter) {
        matches.push(String(match))
      }
      matches.sort() // deterministic ordering
    } catch (error) {
      return {
        content: `Glob failed: ${String(error)}`,
        isError: true,
      }
    }

    if (matches.length === 0) {
      return {
        content: `No files matched pattern: ${params.pattern}`,
        isError: false,
      }
    }

    const raw = matches.join('\n')
    return {
      content: capOutput(raw, this.config.maxOutputChars),
      isError: false,
    }
  }
}
```

**Note on glob library:** Node 22 ships a native `glob` in `node:fs/promises`. If the project must support Node 20, fall back to the `fast-glob` npm package. The interface is the same; only the import changes.

```typescript
// Fallback for Node 20:
// import fg from 'fast-glob'
// matches = await fg(params.pattern, { cwd: searchDir, dot: false })
```

### 3.4 Example Tool Call

```json
{ "pattern": "**/*.test.ts", "path": "src" }
```

Example output:
```
src/api/AnthropicClient.test.ts
src/config/ConfigManager.test.ts
src/tools/GlobTool.test.ts
```

---

## 4. GrepTool

**File:** `src/tools/GrepTool.ts`

### 4.1 Purpose

Search file contents for a regex pattern, with configurable output modes and optional surrounding context lines. This allows Claude to find relevant code without reading every file.

### 4.2 Parameters Schema

```typescript
import { z } from 'zod'

export const GrepParamsSchema = z.object({
  pattern: z.string().min(1).describe(
    'Regular expression pattern to search for'
  ),
  path: z.string().optional().describe(
    'File or directory to search in. Defaults to working directory.'
  ),
  glob: z.string().optional().describe(
    'Glob pattern to filter which files are searched (e.g., "*.ts")'
  ),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).default('content').describe(
    'content = show matching lines; files_with_matches = file paths only; count = match counts per file'
  ),
  context: z.number().int().min(0).max(10).default(0).describe(
    'Number of surrounding lines to include before and after each match'
  ),
  case_insensitive: z.boolean().default(false).describe(
    'Whether the search is case-insensitive'
  ),
})

export type GrepParams = z.infer<typeof GrepParamsSchema>
```

### 4.3 Implementation Strategy

GrepTool wraps `ripgrep` (`rg`) via a subprocess call. If `rg` is not available on the system, it falls back to a pure Node.js implementation.

```typescript
// src/tools/GrepTool.ts
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import type { ToolResult } from './types.ts'
import { assertSafePath, capOutput } from './guards.ts'
import type { ResolvedConfig } from '../config/types.ts'

const execAsync = promisify(exec)

export class GrepTool {
  constructor(private readonly config: ResolvedConfig) {}

  readonly name = 'grep'
  readonly description = 'Search file contents for a regex pattern'

  schema = GrepParamsSchema

  async execute(params: GrepParams): Promise<ToolResult> {
    const searchPath = params.path
      ? path.resolve(this.config.workingDirectory, params.path)
      : this.config.workingDirectory

    assertSafePath(searchPath, this.config.workingDirectory)

    try {
      const result = await this.runRipgrep(params, searchPath)
      return result
    } catch {
      // ripgrep not available — fall back to Node.js implementation
      return this.runNodeGrep(params, searchPath)
    }
  }

  /**
   * Execute ripgrep as a subprocess.
   * Builds the argument list from the params schema.
   */
  private async runRipgrep(params: GrepParams, searchPath: string): Promise<ToolResult> {
    const args: string[] = ['rg']

    if (params.case_insensitive) args.push('-i')
    if (params.context > 0) args.push('-C', String(params.context))
    if (params.glob) args.push('--glob', params.glob)

    switch (params.output_mode) {
      case 'files_with_matches': args.push('-l'); break
      case 'count': args.push('-c'); break
      // 'content' is the default — no flag needed
    }

    args.push('--line-number')  // always include line numbers for 'content' mode
    args.push('--no-heading')   // one-line format: file:line:content
    args.push('--')
    args.push(params.pattern)
    args.push(searchPath)

    const cmd = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ')

    let stdout: string
    try {
      const { stdout: out } = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 })
      stdout = out
    } catch (error: unknown) {
      // rg exits with code 1 when no matches found — not an error
      const execError = error as { code?: number; stdout?: string }
      if (execError.code === 1) {
        return { content: 'No matches found.', isError: false }
      }
      // Code 2+ means actual errors
      if (execError.code === 127) {
        throw new Error('ripgrep not found') // trigger fallback
      }
      return { content: `grep failed: ${String(error)}`, isError: true }
    }

    const trimmed = stdout.trim()
    if (!trimmed) return { content: 'No matches found.', isError: false }

    return {
      content: capOutput(trimmed, this.config.maxOutputChars),
      isError: false,
    }
  }

  /**
   * Pure Node.js fallback when ripgrep is not available.
   * Supports 'content' and 'files_with_matches' output modes.
   * Context lines are not supported in this fallback.
   */
  private runNodeGrep(params: GrepParams, searchPath: string): ToolResult {
    const flags = params.case_insensitive ? 'gi' : 'g'
    let regex: RegExp
    try {
      regex = new RegExp(params.pattern, flags)
    } catch {
      return { content: `Invalid regex pattern: ${params.pattern}`, isError: true }
    }

    const files = this.collectFiles(searchPath, params.glob)
    const matchingFiles: string[] = []
    const contentLines: string[] = []

    for (const file of files) {
      let content: string
      try {
        content = fs.readFileSync(file, 'utf-8')
      } catch {
        continue
      }

      const lines = content.split('\n')
      let fileHasMatch = false

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? ''
        if (regex.test(line)) {
          fileHasMatch = true
          if (params.output_mode === 'content') {
            const relPath = path.relative(this.config.workingDirectory, file)
            contentLines.push(`${relPath}:${i + 1}:${line}`)
          }
          regex.lastIndex = 0 // reset stateful regex
        }
      }

      if (fileHasMatch) matchingFiles.push(file)
    }

    if (params.output_mode === 'files_with_matches') {
      if (matchingFiles.length === 0) return { content: 'No matches found.', isError: false }
      const relative = matchingFiles
        .map(f => path.relative(this.config.workingDirectory, f))
        .join('\n')
      return { content: capOutput(relative, this.config.maxOutputChars), isError: false }
    }

    if (contentLines.length === 0) return { content: 'No matches found.', isError: false }
    return {
      content: capOutput(contentLines.join('\n'), this.config.maxOutputChars),
      isError: false,
    }
  }

  private collectFiles(searchPath: string, globPattern?: string): string[] {
    const files: string[] = []
    const stat = fs.statSync(searchPath, { throwIfNoEntry: false })
    if (!stat) return files

    if (stat.isFile()) return [searchPath]

    const entries = fs.readdirSync(searchPath, { withFileTypes: true, recursive: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const fullPath = path.join(String((entry as { parentPath?: string }).parentPath ?? searchPath), entry.name)
      if (globPattern) {
        // Simple extension-based filter for fallback mode
        // Full glob matching available via ripgrep
        if (!entry.name.endsWith(globPattern.replace('*', ''))) continue
      }
      files.push(fullPath)
    }
    return files
  }
}
```

### 4.4 Output Format

For `output_mode: "content"` (default):
```
src/config/ConfigManager.ts:42:  const apiKey = process.env['ANTHROPIC_API_KEY']
src/config/ConfigManager.ts:47:  if (!apiKey) throw new Error('...')
```

For `output_mode: "files_with_matches"`:
```
src/config/ConfigManager.ts
src/api/AnthropicClient.ts
```

For `output_mode: "count"`:
```
src/config/ConfigManager.ts: 2
src/api/AnthropicClient.ts: 1
```

---

## 5. Diff Preview (Shared Logic)

**File:** `src/tools/diffPreview.ts`

Both WriteFileTool and EditFileTool use this shared module to compute and display a unified diff before writing.

### 5.1 Implementation

```typescript
// src/tools/diffPreview.ts
import { createPatch } from 'diff'  // npm install diff @types/diff
import readline from 'node:readline'
import process from 'node:process'
import type { PermissionMode } from '../config/types.ts'

const DIFF_DISPLAY_LINES = 40 // Max lines of diff shown before truncation

/**
 * Compute a unified diff string between two text versions of a file.
 * Returns empty string if the content is identical.
 */
export function computeDiff(filePath: string, original: string, updated: string): string {
  return createPatch(
    filePath,
    original,
    updated,
    'original',
    'updated',
    { context: 3 }
  )
}

/**
 * Display the diff and, in 'default' permission mode, prompt the user to confirm.
 *
 * In 'auto' mode: skip the prompt, proceed immediately.
 * In 'default' mode: show diff, ask y/n/a.
 * In 'deny' mode: this function is never reached (blocked upstream by PermissionGuard).
 *
 * @returns true if the write should proceed, false if the user declined
 */
export async function showDiffAndConfirm(
  filePath: string,
  diff: string,
  permissionMode: PermissionMode,
): Promise<boolean> {
  if (permissionMode === 'auto') {
    return true // Skip confirmation in auto mode
  }

  // Display the diff (truncated if very long)
  const lines = diff.split('\n')
  if (lines.length > DIFF_DISPLAY_LINES) {
    const shown = lines.slice(0, DIFF_DISPLAY_LINES).join('\n')
    process.stdout.write(shown)
    process.stdout.write(`\n... [${lines.length - DIFF_DISPLAY_LINES} more lines not shown]\n`)
  } else {
    process.stdout.write(diff)
  }

  // Prompt for confirmation
  const answer = await promptUser(`Write changes to ${filePath}? [y/n/a] `)
  const trimmed = answer.trim().toLowerCase()

  if (trimmed === 'a') {
    // 'a' = always — caller should upgrade session permission mode to 'auto'
    // We return a special sentinel; actual mode upgrade is the caller's responsibility
    return true
  }

  return trimmed === 'y' || trimmed === 'yes'
}

/**
 * A 'always' response to a diff prompt — callers should check this
 * by inspecting the answer before calling showDiffAndConfirm.
 * Alternative: use a callback/event to notify the caller to switch to 'auto'.
 */
export async function showDiffAndConfirmWithMode(
  filePath: string,
  diff: string,
  permissionMode: PermissionMode,
  onUpgradeToAuto: () => void,
): Promise<boolean> {
  if (permissionMode === 'auto') return true

  const lines = diff.split('\n')
  if (lines.length > DIFF_DISPLAY_LINES) {
    process.stdout.write(lines.slice(0, DIFF_DISPLAY_LINES).join('\n'))
    process.stdout.write(`\n... [${lines.length - DIFF_DISPLAY_LINES} more lines]\n`)
  } else {
    process.stdout.write(diff)
  }

  const answer = await promptUser(`Write changes to ${filePath}? [y/n/a] `)
  const trimmed = answer.trim().toLowerCase()

  if (trimmed === 'a') {
    onUpgradeToAuto()
    return true
  }

  return trimmed === 'y' || trimmed === 'yes'
}

function promptUser(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    })
    rl.question(question, answer => {
      rl.close()
      resolve(answer)
    })
  })
}
```

---

## 6. EditFileTool

**File:** `src/tools/EditFileTool.ts`

### 6.1 Purpose

Apply a surgical string replacement to an existing file. The LLM provides the exact `old_string` to find and `new_string` to replace it with. This avoids rewriting the entire file for small changes.

### 6.2 Parameters Schema

```typescript
import { z } from 'zod'

export const EditFileParamsSchema = z.object({
  file_path: z.string().min(1).describe(
    'Path to the file to edit (relative to working directory)'
  ),
  old_string: z.string().min(1).describe(
    'Exact string to find in the file. Must match exactly including whitespace.'
  ),
  new_string: z.string().describe(
    'String to replace old_string with. May be empty to delete old_string.'
  ),
  replace_all: z.boolean().default(false).describe(
    'If true, replace all occurrences. If false and multiple exist, returns an error.'
  ),
})

export type EditFileParams = z.infer<typeof EditFileParamsSchema>
```

### 6.3 Implementation

```typescript
// src/tools/EditFileTool.ts
import fs from 'node:fs'
import path from 'node:path'
import type { ToolResult } from './types.ts'
import { assertSafePath, capOutput } from './guards.ts'
import { computeDiff, showDiffAndConfirmWithMode } from './diffPreview.ts'
import type { ResolvedConfig } from '../config/types.ts'

export class EditFileTool {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly onUpgradeToAuto: () => void,
  ) {}

  readonly name = 'edit_file'
  readonly description = 'Make a surgical string replacement in a file'

  schema = EditFileParamsSchema

  async execute(params: EditFileParams): Promise<ToolResult> {
    const absolutePath = path.resolve(this.config.workingDirectory, params.file_path)

    // Safety: reject path traversal attempts
    assertSafePath(absolutePath, this.config.workingDirectory)

    // Verify the file exists and is readable
    if (!fs.existsSync(absolutePath)) {
      return {
        content: `File not found: ${params.file_path}`,
        isError: true,
      }
    }

    let original: string
    try {
      original = fs.readFileSync(absolutePath, 'utf-8')
    } catch (error) {
      return {
        content: `Failed to read file: ${String(error)}`,
        isError: true,
      }
    }

    // Count occurrences of old_string
    const occurrenceCount = this.countOccurrences(original, params.old_string)

    if (occurrenceCount === 0) {
      return {
        content: `String not found in file: "${params.old_string.slice(0, 80)}${params.old_string.length > 80 ? '...' : ''}"`,
        isError: true,
      }
    }

    if (occurrenceCount > 1 && !params.replace_all) {
      return {
        content:
          `old_string appears ${occurrenceCount} times in ${params.file_path}. ` +
          `Set replace_all: true to replace all occurrences, or provide a more specific old_string that matches exactly once.`,
        isError: true,
      }
    }

    // Perform the replacement
    const updated = params.replace_all
      ? original.split(params.old_string).join(params.new_string)
      : original.replace(params.old_string, params.new_string)

    // Compute and show diff
    const diff = computeDiff(params.file_path, original, updated)

    if (!diff.trim()) {
      return {
        content: 'No changes made (old_string and new_string are identical after replacement)',
        isError: false,
      }
    }

    // In 'default' mode: show diff and ask for confirmation
    const confirmed = await showDiffAndConfirmWithMode(
      params.file_path,
      diff,
      this.config.permissionMode,
      this.onUpgradeToAuto,
    )

    if (!confirmed) {
      return {
        content: `Edit cancelled by user.`,
        isError: false,
      }
    }

    // Write the updated file
    try {
      fs.writeFileSync(absolutePath, updated, 'utf-8')
    } catch (error) {
      return {
        content: `Failed to write file: ${String(error)}`,
        isError: true,
      }
    }

    const replacedCount = params.replace_all ? occurrenceCount : 1
    return {
      content: `Replaced ${replacedCount} occurrence${replacedCount === 1 ? '' : 's'} in ${params.file_path}`,
      isError: false,
    }
  }

  /**
   * Count how many times `needle` appears in `haystack`.
   * Uses split to count non-overlapping occurrences.
   */
  private countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1
  }
}
```

### 6.4 Error Scenarios

| Scenario | Return value | isError |
|----------|-------------|---------|
| File not found | `"File not found: path"` | true |
| `old_string` not in file | `"String not found in file: ..."` | true |
| `old_string` appears N>1 times, `replace_all: false` | Count + instruction | true |
| User declines diff confirmation | `"Edit cancelled by user."` | false |
| Write permission denied | `"Failed to write file: ..."` | true |
| `old_string === new_string` | `"No changes made..."` | false |

### 6.5 Diff Preview for Both WriteFileTool and EditFileTool

Both tools use the same `diffPreview.ts` module:

```typescript
// WriteFileTool.ts (excerpt)
const original = fs.existsSync(absolutePath)
  ? fs.readFileSync(absolutePath, 'utf-8')
  : ''
const diff = computeDiff(params.file_path, original, params.content)
const confirmed = await showDiffAndConfirmWithMode(
  params.file_path,
  diff,
  this.config.permissionMode,
  this.onUpgradeToAuto,
)
```

When writing a new file (`original === ''`), the diff shows all lines as additions (prefixed with `+`), giving the user a clear preview of what will be created.

---

## 7. Test Cases

### GlobTool tests

```typescript
describe('GlobTool', () => {
  it('returns matching file paths sorted', async () => {
    // Uses temp directory with known files
  })

  it('returns no-match message when pattern has no results', async () => {
    const tool = new GlobTool(makeConfig())
    const result = await tool.execute({ pattern: '**/*.nonexistent' })
    expect(result.isError).toBe(false)
    expect(result.content).toContain('No files matched')
  })

  it('rejects path traversal in path parameter', async () => {
    const tool = new GlobTool(makeConfig({ workingDirectory: '/tmp/safe' }))
    const result = await tool.execute({ pattern: '*.ts', path: '../../etc' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('traversal')
  })

  it('caps output at maxOutputChars', async () => {
    // Creates many files in temp dir
  })
})
```

### GrepTool tests

```typescript
describe('GrepTool', () => {
  it('finds lines matching a regex pattern', async () => {
    // Uses temp file with known content
  })

  it('returns files_with_matches mode output', async () => {
    // Checks output contains file paths only
  })

  it('returns no-match message when pattern not found', async () => {
    const result = await tool.execute({ pattern: 'THIS_CANNOT_MATCH_ANYTHING_ABCXYZ' })
    expect(result.content).toBe('No matches found.')
  })

  it('rejects invalid regex pattern', async () => {
    const result = await tool.execute({ pattern: '[invalid' })
    expect(result.isError).toBe(true)
  })
})
```

### EditFileTool tests

```typescript
describe('EditFileTool', () => {
  it('replaces a unique string in a file', async () => {
    // Write temp file, run edit, read back and assert
  })

  it('returns error when old_string not found', async () => {
    const result = await tool.execute({
      file_path: 'test.ts',
      old_string: 'DOES_NOT_EXIST',
      new_string: 'replacement',
    })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('String not found')
  })

  it('returns error when old_string appears multiple times and replace_all is false', async () => {
    // File with "foo" appearing 3 times
    const result = await tool.execute({ ..., old_string: 'foo', replace_all: false })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('3 times')
  })

  it('replaces all occurrences when replace_all is true', async () => {
    // File with "foo" appearing 3 times
    const result = await tool.execute({ ..., old_string: 'foo', replace_all: true })
    expect(result.isError).toBe(false)
    expect(result.content).toContain('Replaced 3 occurrences')
  })

  it('blocks path traversal in file_path', async () => {
    const result = await tool.execute({
      file_path: '../../etc/passwd',
      old_string: 'root',
      new_string: 'hacked',
    })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('traversal')
  })

  it('skips diff prompt in auto permission mode', async () => {
    // permissionMode: 'auto' — no readline prompt, writes directly
  })
})
```

### diffPreview tests

```typescript
describe('computeDiff', () => {
  it('returns a unified diff string', () => {
    const diff = computeDiff('test.ts', 'const x = 1\n', 'const x = 2\n')
    expect(diff).toContain('-const x = 1')
    expect(diff).toContain('+const x = 2')
  })

  it('returns empty-ish string for identical content', () => {
    const diff = computeDiff('test.ts', 'hello\n', 'hello\n')
    // createPatch returns a header even for identical content, but no +/- lines
    expect(diff).not.toContain('\n-')
    expect(diff).not.toContain('\n+')
  })
})
```

---

## 8. Summary

| Tool | Key Design Decisions |
|------|---------------------|
| GlobTool | Uses native Node 22 `glob`; falls back to `fast-glob` for Node 20 |
| GlobTool | Results sorted lexicographically for deterministic output |
| GrepTool | Wraps `rg` for performance; pure Node.js fallback if unavailable |
| GrepTool | Three output modes (content, files, count) matching Claude Code UX |
| EditFileTool | Exact string match — no fuzzy matching, no regex in `old_string` |
| EditFileTool | Fails if match is non-unique (unless `replace_all: true`) |
| EditFileTool | Diff preview before write in 'default' mode — same as WriteFileTool |
| diffPreview | Shared module used by both WriteFileTool and EditFileTool |
| diffPreview | 'a' answer upgrades session to 'auto' via callback |
| diffPreview | Truncates diff display to 40 lines — full content still written |
