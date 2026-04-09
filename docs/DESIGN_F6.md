# DESIGN_F6 — Configuration Manager (F6, F30)

> Features: F6 (Configuration Manager), F30 (Project-local config)
> Phase: 1 (F6), 3 (F30)
> Module: `src/config/`

---

## 1. Purpose

The Configuration Manager is the **single source of truth** for all runtime configuration in CodeAgent. Every module — the API client, tool dispatcher, output renderer, agent manager — receives a `ResolvedConfig` object rather than reading environment variables or files independently.

Analogy: Think of it like a restaurant's mise en place. All ingredients (API key, model, permissions) are measured and arranged before service begins. No cook reaches into the pantry mid-service — they use what's been prepared.

---

## 2. File Location Constants

```typescript
// src/config/constants.ts
import os from 'node:os'
import path from 'node:path'

export const USER_CONFIG_DIR = path.join(os.homedir(), '.codeagent')
export const USER_CONFIG_PATH = path.join(USER_CONFIG_DIR, 'config.json')

export const PROJECT_CONFIG_DIR = path.join(process.cwd(), '.codeagent')
export const PROJECT_CONFIG_PATH = path.join(PROJECT_CONFIG_DIR, 'config.json')
```

---

## 3. ResolvedConfig Schema

All fields are defined with Zod. The schema is the canonical type — TypeScript types are derived from it.

```typescript
// src/config/types.ts
import { z } from 'zod'

export const PermissionModeSchema = z.enum(['auto', 'default', 'deny'])
export type PermissionMode = z.infer<typeof PermissionModeSchema>

export const ResolvedConfigSchema = z.object({
  // Required — session cannot start without this
  apiKey: z.string().min(1, 'ANTHROPIC_API_KEY is required'),

  // Model selection — defaults to claude-sonnet-4-6
  model: z.string().default('claude-sonnet-4-6'),

  // Permission mode for destructive tool calls
  permissionMode: PermissionModeSchema.default('default'),

  // Enable ANSI color output
  color: z.boolean().default(true),

  // Maximum output tokens per API response
  maxTokens: z.number().int().positive().default(8192),

  // Working directory for all file/tool operations
  workingDirectory: z.string().default(process.cwd()),

  // Enable debug logging to file
  debug: z.boolean().default(false),

  // Maximum tool calls per agentic loop turn (rate limiter)
  maxToolCalls: z.number().int().positive().default(25),

  // Maximum characters in tool output before truncation
  maxOutputChars: z.number().int().positive().default(100_000),

  // Initial agent name — resolved by AgentRegistry at startup
  agent: z.string().default('default'),
})

export type ResolvedConfig = z.infer<typeof ResolvedConfigSchema>

// Partial config as stored in JSON files — all fields optional
export const PartialConfigSchema = ResolvedConfigSchema.partial().omit({ apiKey: true }).extend({
  apiKey: z.string().optional(),
})
export type PartialConfig = z.infer<typeof PartialConfigSchema>
```

---

## 4. Configuration Resolution Priority Chain

Priority is highest to lowest. A value found at a higher level **completely overrides** the same key at a lower level. Merging is shallow (per key), not deep.

```
Priority 1 (highest): Project-local   .codeagent/config.json
Priority 2:           User-global     ~/.codeagent/config.json
Priority 3:           Environment     ANTHROPIC_API_KEY, CODEAGENT_MODEL, ...
Priority 4 (lowest):  CLI flags       --model, --agent, --permission-mode, ...
                      ↓
                 ResolvedConfig (frozen object, passed to all modules)
```

**Important:** CLI flags are the lowest priority because project and user config represent the user's *persistent* preferences, while flags are intended as one-off overrides for a single session. The resolution chain reads *all* sources and merges them so the final object always has a complete, validated config.

```
Merge algorithm (pseudo-code):
  base = schema defaults
  base = merge(base, env vars)          // Priority 4 (baseline)
  base = merge(base, userConfig)        // Priority 2 overrides env
  base = merge(base, projectConfig)     // Priority 1 overrides user
  base = merge(base, cliFlags)          // Wait — see note below
```

**Note on CLI flags priority:** CLI flags are listed as lowest because they are one-time session overrides and should NOT persistently override a team's project config. For example, if a team sets `"model": "claude-opus-4-6"` in `.codeagent/config.json`, a developer's personal `--model` flag still takes effect for that one session without changing the shared config.

The actual merge order implemented:

```
final = merge(schemaDefaults, envVars, userConfig, projectConfig, cliFlags)
```

Each `merge` step only overrides keys that are explicitly present (not undefined) in the higher-priority source.

---

## 5. Environment Variable Mapping

```typescript
// src/config/envMapping.ts
export function readEnvVars(): Partial<Record<string, unknown>> {
  const result: Partial<Record<string, unknown>> = {}

  if (process.env['ANTHROPIC_API_KEY']) {
    result['apiKey'] = process.env['ANTHROPIC_API_KEY']
  }
  if (process.env['CODEAGENT_MODEL']) {
    result['model'] = process.env['CODEAGENT_MODEL']
  }
  if (process.env['CODEAGENT_PERMISSION_MODE']) {
    result['permissionMode'] = process.env['CODEAGENT_PERMISSION_MODE']
  }
  if (process.env['CODEAGENT_DEBUG']) {
    result['debug'] = process.env['CODEAGENT_DEBUG'] === '1' || process.env['CODEAGENT_DEBUG'] === 'true'
  }
  if (process.env['CODEAGENT_MAX_TOKENS']) {
    result['maxTokens'] = Number(process.env['CODEAGENT_MAX_TOKENS'])
  }
  if (process.env['CODEAGENT_AGENT']) {
    result['agent'] = process.env['CODEAGENT_AGENT']
  }

  return result
}
```

---

## 6. ConfigManager Class

```typescript
// src/config/ConfigManager.ts
import fs from 'node:fs'
import path from 'node:path'
import { ResolvedConfigSchema, PartialConfigSchema, ResolvedConfig, PartialConfig } from './types.ts'
import { USER_CONFIG_PATH, USER_CONFIG_DIR, PROJECT_CONFIG_PATH, PROJECT_CONFIG_DIR } from './constants.ts'
import { readEnvVars } from './envMapping.ts'

export interface CliArgs {
  apiKey?: string
  model?: string
  permissionMode?: string
  color?: boolean
  maxTokens?: number
  workingDirectory?: string
  debug?: boolean
  agent?: string
}

export class ConfigManager {
  /**
   * Load and merge all configuration sources into a validated ResolvedConfig.
   * Throws if the merged result is invalid (e.g., apiKey is missing).
   */
  static load(cliArgs: CliArgs = {}): ResolvedConfig {
    const userConfig = ConfigManager.readFile(USER_CONFIG_PATH)
    const projectConfig = ConfigManager.readFile(PROJECT_CONFIG_PATH)
    const envVars = readEnvVars()

    // Build CLI args as a partial config (strip undefined keys)
    const cliConfig: Record<string, unknown> = {}
    if (cliArgs.apiKey !== undefined) cliConfig['apiKey'] = cliArgs.apiKey
    if (cliArgs.model !== undefined) cliConfig['model'] = cliArgs.model
    if (cliArgs.permissionMode !== undefined) cliConfig['permissionMode'] = cliArgs.permissionMode
    if (cliArgs.color !== undefined) cliConfig['color'] = cliArgs.color
    if (cliArgs.maxTokens !== undefined) cliConfig['maxTokens'] = cliArgs.maxTokens
    if (cliArgs.workingDirectory !== undefined) cliConfig['workingDirectory'] = cliArgs.workingDirectory
    if (cliArgs.debug !== undefined) cliConfig['debug'] = cliArgs.debug
    if (cliArgs.agent !== undefined) cliConfig['agent'] = cliArgs.agent

    // Merge: env < user < project < cli (each layer only overrides defined keys)
    const merged = {
      ...envVars,
      ...userConfig,
      ...projectConfig,
      ...cliConfig,
    }

    // Validate and apply defaults via Zod
    const result = ResolvedConfigSchema.safeParse(merged)
    if (!result.success) {
      const issues = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n')
      throw new Error(`Configuration error:\n${issues}`)
    }

    // Freeze the object — all modules treat it as immutable
    return Object.freeze(result.data)
  }

  /**
   * Persist a single key-value pair to the USER-global config file.
   * Never writes to project-local config to avoid committing secrets.
   */
  static set(key: string, value: unknown): void {
    const existing = ConfigManager.readFile(USER_CONFIG_PATH)
    const updated = { ...existing, [key]: value }

    // Validate the updated partial config before writing
    const validation = PartialConfigSchema.safeParse(updated)
    if (!validation.success) {
      const issues = validation.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n')
      throw new Error(`Invalid config value for "${key}":\n${issues}`)
    }

    ConfigManager.ensureDir(USER_CONFIG_DIR)
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(validation.data, null, 2), {
      mode: 0o600,
      encoding: 'utf-8',
    })
  }

  /**
   * Read and parse a JSON config file. Returns empty object if file does not exist.
   * Any parse errors are surfaced as descriptive Error instances.
   */
  private static readFile(filePath: string): PartialConfig {
    if (!fs.existsSync(filePath)) {
      return {}
    }

    let raw: string
    try {
      raw = fs.readFileSync(filePath, 'utf-8')
    } catch (error) {
      throw new Error(`Failed to read config file at ${filePath}: ${String(error)}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`Config file at ${filePath} contains invalid JSON`)
    }

    const result = PartialConfigSchema.safeParse(parsed)
    if (!result.success) {
      const issues = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n')
      throw new Error(`Config file at ${filePath} has invalid fields:\n${issues}`)
    }

    return result.data
  }

  /**
   * Create a directory with secure permissions if it does not already exist.
   */
  private static ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 })
    }
  }
}
```

---

## 7. File Permissions

Config directories and files must be created with restrictive permissions to protect the API key and other secrets.

| Path | Permissions | Reason |
|------|------------|--------|
| `~/.codeagent/` | `0o700` (rwx------) | Only owner can list/enter |
| `~/.codeagent/config.json` | `0o600` (rw-------) | Only owner can read/write |
| `.codeagent/` (project) | `0o700` | Should be in .gitignore |
| `.codeagent/config.json` (project) | `0o600` | Should be in .gitignore |

**Warning in documentation:** The project-local `.codeagent/` directory should be added to `.gitignore`. While project config is designed for model/agent preferences rather than secrets, no sensitive data should ever be committed.

---

## 8. `config set` CLI Command

The `config set` command writes to the **user-global** config file only, never to the project-local config. This is a deliberate security decision: project-local config is intended to be committed to version control (for model/agent defaults), so secrets must never be written there.

```typescript
// src/cli/args.ts (config set subcommand handler)
import { ConfigManager } from '../config/ConfigManager.ts'

export function handleConfigSet(key: string, value: string): void {
  // Type-coerce common values
  let coerced: unknown = value
  if (value === 'true') coerced = true
  else if (value === 'false') coerced = false
  else if (/^\d+$/.test(value)) coerced = Number(value)

  try {
    ConfigManager.set(key, coerced)
    console.log(`Config updated: ${key} = ${JSON.stringify(coerced)}`)
    console.log(`Saved to: ~/.codeagent/config.json`)
  } catch (error) {
    console.error(`Error: ${String(error)}`)
    process.exit(1)
  }
}
```

**CLI usage:**
```
codeagent config set model claude-opus-4-6
codeagent config set permissionMode auto
codeagent config set debug true
```

---

## 9. Project-Local Config Use Cases (F30)

Project-local config (`.codeagent/config.json`) is designed for **team-shared, repository-specific defaults**. It should NOT contain secrets.

**Use case 1 — Force a specific model for a repo:**
```json
{
  "model": "claude-opus-4-6",
  "maxTokens": 16384
}
```

**Use case 2 — Set the default agent for a repo:**
```json
{
  "agent": "code-reviewer",
  "permissionMode": "auto"
}
```

**Use case 3 — Restrict to read-only tools for documentation repos:**
```json
{
  "permissionMode": "deny",
  "agent": "doc-writer"
}
```

These files should be committed to version control to enforce consistent behavior across the team. Because they override the user's personal `~/.codeagent/config.json`, developers working in the repo automatically get the correct model and agent without manual configuration.

**Note:** `apiKey` is explicitly excluded from project-local config validation. If a project config file contains an `apiKey` field, it will be ignored with a warning.

---

## 10. apiKey Validation

The API key is validated last, after all sources are merged. If it is missing or empty after merging all sources, `ConfigManager.load()` throws a descriptive error with remediation instructions.

```typescript
// Enforced by Zod schema: apiKey: z.string().min(1, 'ANTHROPIC_API_KEY is required')
// Additional runtime check in ConfigManager.load():
if (!merged['apiKey']) {
  throw new Error(
    'ANTHROPIC_API_KEY is not set.\n' +
    'Set it via:\n' +
    '  export ANTHROPIC_API_KEY=sk-ant-...\n' +
    '  OR: codeagent config set apiKey sk-ant-...'
  )
}
```

---

## 11. Bootstrap Integration

```typescript
// src/cli/index.ts (startup sequence)
import { ConfigManager } from '../config/ConfigManager.ts'

const args = parseArgs(process.argv.slice(2))

let config: ResolvedConfig
try {
  config = ConfigManager.load({
    apiKey: args['api-key'],
    model: args['model'],
    permissionMode: args['permission-mode'],
    debug: args['debug'],
    agent: args['agent'],
  })
} catch (error) {
  console.error(`\nStartup error: ${String(error)}\n`)
  process.exit(1)
}

// config is now frozen and passed by reference to all modules
const controller = new ConversationController(config, agentManager)
```

---

## 12. Test Cases

```typescript
// src/config/ConfigManager.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ConfigManager } from './ConfigManager.ts'

describe('ConfigManager.load', () => {
  it('throws when apiKey is missing from all sources', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    expect(() => ConfigManager.load()).toThrow('ANTHROPIC_API_KEY')
  })

  it('reads apiKey from environment variable', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    const config = ConfigManager.load()
    expect(config.apiKey).toBe('sk-test')
  })

  it('CLI flags override env vars for non-secret fields', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('CODEAGENT_MODEL', 'claude-opus-4-6')
    const config = ConfigManager.load({ model: 'claude-haiku-3-5' })
    expect(config.model).toBe('claude-haiku-3-5')
  })

  it('applies schema defaults when fields are absent', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    const config = ConfigManager.load()
    expect(config.permissionMode).toBe('default')
    expect(config.maxToolCalls).toBe(25)
    expect(config.maxOutputChars).toBe(100_000)
  })

  it('returns a frozen object', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    const config = ConfigManager.load()
    expect(Object.isFrozen(config)).toBe(true)
  })

  it('project config overrides user config', () => {
    // Covered by integration test with temp config files
  })
})

describe('ConfigManager.set', () => {
  it('writes to user config file', () => {
    // Uses temp directory with vi.stubEnv for HOME
  })

  it('rejects invalid permissionMode values', () => {
    expect(() => ConfigManager.set('permissionMode', 'invalid')).toThrow()
  })
})
```

---

## 13. Summary

| Concern | Decision |
|---------|----------|
| Single source of truth | `ResolvedConfig` frozen object, passed everywhere |
| Priority | project > user > env > CLI flags |
| Validation | Zod schema at load time, fail-fast with descriptive errors |
| Security | 0o700 dir / 0o600 file; `config set` never writes project-local |
| apiKey | Required field; clear error message with remediation steps |
| Immutability | `Object.freeze()` on the resolved config |
| Project-local | Team defaults (model, agent, mode) — not secrets |
