# DESIGN_F15 — MCP Server Support, Plugin System (F15) & Sub-agent Delegation (F29)

> Phase 4 features. This document specifies what each feature will do and how it integrates with the existing architecture. Full implementation is deferred to Phase 4. TypeScript interfaces are authoritative; bodies are illustrative.

---

## Table of Contents

1. [Overview](#1-overview)
2. [MCP Server Support](#2-mcp-server-support)
3. [Plugin System](#3-plugin-system)
4. [Sub-agent Delegation (F29)](#4-sub-agent-delegation-f29)
5. [Configuration Extensions](#5-configuration-extensions)
6. [Startup Integration Sequence](#6-startup-integration-sequence)
7. [Security Considerations](#7-security-considerations)

---

## 1. Overview

Phase 4 opens CodeAgent to external extension in two directions:

1. **MCP (Model Context Protocol) servers** — local processes that expose tools over a standardized JSON-RPC protocol. CodeAgent connects to configured MCP servers at startup, discovers their tool catalogs, and presents those tools to the model alongside built-in tools.

2. **Plugin packages** — npm packages installed by the user that bundle additional tools and/or agent definitions. Plugins are discovered from a well-known directory and loaded via dynamic import through a stable public API surface.

3. **Sub-agent delegation (F29)** — a `/delegate` slash command that spawns a headless `ConversationController` instance running as a specific agent, executes a single task, and surfaces the result in the parent session.

All three features are additive. They do not alter existing Phase 1–3 behavior when unconfigured. A fresh install with no MCP servers, no plugins, and no `/delegate` invocations behaves identically to Phase 3.

---

## 2. MCP Server Support

### 2.1 What MCP is

The Model Context Protocol (MCP) is an open standard for exposing tools through a local server process. An MCP server is any process that listens on a local socket or HTTP port and responds to a defined JSON-RPC 2.0 API. This allows:

- Tools written in any language (Python, Go, Rust) to be called by CodeAgent
- Teams to share tool catalogs without modifying the CLI source code
- Specialized tool servers (database clients, internal APIs) to be plugged in via config

MCP servers are external processes that CodeAgent **connects to** — it does not start or manage their lifecycle.

### 2.2 Core interfaces

```typescript
// src/mcp/types.ts

/**
 * Describes a single tool as reported by an MCP server.
 * Mirrors the MCP spec's tool descriptor shape.
 */
export interface MCPToolDescriptor {
  /** Unique name within this server. Will be prefixed with server name on registration. */
  readonly name: string
  readonly description: string
  /** JSON Schema object describing the input parameters. */
  readonly inputSchema: Record<string, unknown>
}

/**
 * Result returned by an MCP tool call.
 */
export interface MCPToolResult {
  /** Tool output as a string (may be JSON, plain text, or structured data). */
  readonly content: string
  readonly isError: boolean
}

/**
 * Client interface for a single connected MCP server.
 *
 * Implementations are responsible for connection lifecycle, request/response
 * serialization, and error handling. The interface is transport-agnostic —
 * concrete implementations handle HTTP, stdio, or WebSocket transports.
 */
export interface MCPClient {
  /**
   * Establish a connection to the MCP server.
   * Resolves when the connection handshake is complete.
   * Rejects if the server is unreachable or the protocol version is incompatible.
   */
  connect(url: string): Promise<void>

  /**
   * Retrieve the list of tools this server exposes.
   * Must be called after connect().
   */
  listTools(): Promise<MCPToolDescriptor[]>

  /**
   * Invoke a tool by name with the given input object.
   * @param name  The tool name as returned by listTools() (without server prefix).
   * @param input  The input object conforming to the tool's inputSchema.
   */
  callTool(name: string, input: Record<string, unknown>): Promise<MCPToolResult>

  /**
   * Close the connection and release resources.
   */
  disconnect(): Promise<void>
}

/**
 * Configuration entry for a single MCP server.
 * Lives in the user's or project's config under mcp.servers[].
 */
export interface MCPServerConfig {
  /** Human-readable label. Used as a prefix for tool names: "<name>/<tool>". */
  readonly name: string
  /** Connection URL. Example: "http://localhost:3001" or "stdio://path/to/server" */
  readonly url: string
}
```

### 2.3 MCPToolAdapter

`MCPToolAdapter` wraps an `MCPToolDescriptor` from a specific server as a `CodeAgentTool`, making it indistinguishable from built-in tools to `ToolDispatcher` and the agent tool allowlist system.

```typescript
// src/mcp/MCPToolAdapter.ts

import type { CodeAgentTool, ToolResult } from '../tools/types.js'
import type { MCPClient } from './types.js'

/**
 * MCPToolAdapter
 *
 * Adapts a remote MCP tool to the CodeAgentTool interface.
 *
 * Tool naming convention:
 *   The exposed name is "<serverName>/<toolName>" (forward-slash separator).
 *   This avoids collisions between tools from different servers and makes
 *   the origin of each tool visible in agent tool allowlists.
 *
 * Example: a server named "db-tools" with a tool "query" is registered as
 *   "db-tools/query" and can be referenced in an agent's tools array as:
 *     tools:
 *       - db-tools/query
 *
 * Error handling:
 *   Network errors and MCP-level errors are caught and returned as ToolResult
 *   with isError=true rather than thrown. This allows the agentic loop to
 *   continue and report the error to the model for recovery.
 */
export class MCPToolAdapter implements CodeAgentTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>

  constructor(
    private readonly client: MCPClient,
    private readonly serverName: string,
    descriptor: import('./types.js').MCPToolDescriptor
  ) {
    this.name = `${serverName}/${descriptor.name}`
    this.description = descriptor.description
    this.inputSchema = descriptor.inputSchema
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    try {
      const result = await this.client.callTool(
        this.name.slice(this.serverName.length + 1), // strip "<serverName>/"
        input
      )
      return {
        content: result.content,
        isError: result.isError,
      }
    } catch (error) {
      return {
        content: `MCP tool "${this.name}" failed: ${String(error)}`,
        isError: true,
      }
    }
  }
}
```

### 2.4 MCPRegistry — startup connection and registration

```typescript
// src/mcp/MCPRegistry.ts

import type { ToolDispatcher } from '../tools/ToolDispatcher.js'
import type { MCPServerConfig } from './types.js'
import { MCPToolAdapter } from './MCPToolAdapter.js'
import { HttpMCPClient } from './HttpMCPClient.js'

/**
 * MCPRegistry
 *
 * At startup, connects to all configured MCP servers, discovers their tool
 * catalogs, and registers each tool with ToolDispatcher.
 *
 * Connection failures are non-fatal: a server that is unreachable is skipped
 * with a warning. This allows the user to start CodeAgent even when some MCP
 * servers are temporarily down.
 *
 * All active connections are tracked for cleanup on process exit.
 */
export class MCPRegistry {
  private readonly activeClients: import('./types.js').MCPClient[] = []

  async connect(
    servers: readonly MCPServerConfig[],
    dispatcher: ToolDispatcher
  ): Promise<void> {
    for (const serverConfig of servers) {
      await this.connectServer(serverConfig, dispatcher)
    }
  }

  private async connectServer(
    config: MCPServerConfig,
    dispatcher: ToolDispatcher
  ): Promise<void> {
    const client = new HttpMCPClient()
    try {
      await client.connect(config.url)
      const descriptors = await client.listTools()

      for (const descriptor of descriptors) {
        const adapter = new MCPToolAdapter(client, config.name, descriptor)
        dispatcher.register(adapter)
      }

      this.activeClients.push(client)
      console.error(
        `[MCP] Connected to "${config.name}" — ${descriptors.length} tool(s) registered.`
      )
    } catch (error) {
      console.warn(
        `[MCP] Failed to connect to server "${config.name}" at ${config.url}: ${String(error)}`
      )
      // Non-fatal: continue loading other servers
    }
  }

  async disconnectAll(): Promise<void> {
    await Promise.allSettled(this.activeClients.map((c) => c.disconnect()))
    this.activeClients.length = 0
  }
}
```

### 2.5 Agent integration with MCP tools

MCP tools appear in `ToolDispatcher.allDefinitions()` under their `<serverName>/<toolName>` names. The agent tool allowlist system works identically for MCP tools as for built-in tools.

An agent definition can reference MCP tools by their full prefixed name:

```markdown
---
name: db-analyst
description: Analyzes database queries using db-tools server
model: claude-opus-4-6
tools:
  - read_file
  - db-tools/query
  - db-tools/explain
---

You are a database analyst. Use the db-tools/query tool to run queries
and db-tools/explain to inspect query plans before recommending optimizations.
```

---

## 3. Plugin System

### 3.1 What a plugin is

A plugin is an **npm package** installed in `~/.codeagent/plugins/` that exports a `CodeAgentPlugin` object. Plugins can contribute:

- Additional `CodeAgentTool` implementations (any language capability expressible in TypeScript)
- Additional `AgentDefinition` objects (pre-packaged personas distributed as packages)

Plugins are a distribution mechanism, not a security boundary. They run in the same Node.js process as CodeAgent and have access to the same APIs. The "isolation" concern is about the public API contract — plugins should only import from `codeagent/plugin-api`, not from internal modules.

### 3.2 CodeAgentPlugin interface

```typescript
// src/plugin-api/types.ts  (public surface — re-exported as "codeagent/plugin-api")

import type { AgentDefinition } from '../agents/types.js'
import type { CodeAgentTool } from '../tools/types.js'

/**
 * The contract every CodeAgent plugin must fulfill.
 *
 * A plugin package's main export must be (or export a default of) an object
 * that satisfies this interface.
 *
 * Minimal valid plugin:
 *   export default {
 *     name: 'my-tools',
 *     version: '1.0.0',
 *     tools: [new MyTool()],
 *   }
 */
export interface CodeAgentPlugin {
  /** Unique package name. Used for logging and conflict detection. */
  readonly name: string

  /**
   * Semver version string. Logged at startup for diagnostics.
   * Should match the package.json version field.
   */
  readonly version: string

  /**
   * Tools contributed by this plugin. Each tool is registered in ToolDispatcher.
   * Tool names must be unique across all plugins and built-in tools.
   * Convention: prefix tool names with the plugin name (e.g., "myplugin/do-thing").
   */
  readonly tools: readonly CodeAgentTool[]

  /**
   * Agent definitions contributed by this plugin. Each agent is registered in
   * AgentRegistry under the 'user-global' source priority.
   * Optional: omit if this plugin contributes only tools.
   */
  readonly agents?: readonly AgentDefinition[]
}

/**
 * Zod schema for validating the plugin manifest before dynamic import.
 * Validates the package.json shape, not the runtime export.
 */
export const PluginManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  main: z.string().optional(),
  exports: z.unknown().optional(),
})

export type PluginManifest = z.infer<typeof PluginManifestSchema>
```

### 3.3 Plugin discovery and loading

```typescript
// src/plugins/PluginLoader.ts

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import type { CodeAgentPlugin } from '../plugin-api/types.js'
import type { ToolDispatcher } from '../tools/ToolDispatcher.js'
import type { AgentRegistry } from '../agents/AgentRegistry.js'

/**
 * PluginLoader
 *
 * Discovery algorithm:
 *   1. Read all subdirectories of ~/.codeagent/plugins/
 *   2. For each subdirectory, read package.json and validate with PluginManifestSchema
 *   3. Dynamically import the package's main export
 *   4. Validate the export has required CodeAgentPlugin fields
 *   5. Register tools with ToolDispatcher
 *   6. Register agents with AgentRegistry (as 'user-global' source)
 *
 * Errors during any single plugin's load are caught and logged.
 * A broken plugin does not prevent other plugins from loading.
 *
 * Security constraint:
 *   Plugins are loaded with dynamic import(). They have full Node.js API access.
 *   Only install plugins from trusted sources. Future versions may add a
 *   signature verification step before import.
 */
export class PluginLoader {
  private readonly pluginsDir = path.join(os.homedir(), '.codeagent', 'plugins')

  async loadAll(dispatcher: ToolDispatcher, registry: AgentRegistry): Promise<void> {
    let entries: string[]
    try {
      const dirents = await fs.readdir(this.pluginsDir, { withFileTypes: true })
      entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      // Directory does not exist — no plugins installed
      return
    }

    for (const entry of entries) {
      await this.loadPlugin(path.join(this.pluginsDir, entry), dispatcher, registry)
    }
  }

  private async loadPlugin(
    pluginDir: string,
    dispatcher: ToolDispatcher,
    registry: AgentRegistry
  ): Promise<void> {
    const manifestPath = path.join(pluginDir, 'package.json')

    let manifest: import('../plugin-api/types.js').PluginManifest
    try {
      const raw = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as unknown
      const result = (await import('../plugin-api/types.js')).PluginManifestSchema.safeParse(raw)
      if (!result.success) {
        throw new Error(`Invalid package.json: ${result.error.message}`)
      }
      manifest = result.data
    } catch (error) {
      console.warn(`[Plugin] Skipping "${pluginDir}": ${String(error)}`)
      return
    }

    let pluginExport: unknown
    try {
      // Dynamic import resolves relative to the plugin's own package root
      const mod = await import(pluginDir) as { default?: unknown }
      pluginExport = mod.default ?? mod
    } catch (error) {
      console.warn(`[Plugin] Failed to import "${manifest.name}": ${String(error)}`)
      return
    }

    // Validate that the export looks like a CodeAgentPlugin
    if (
      typeof pluginExport !== 'object' ||
      pluginExport === null ||
      !('name' in pluginExport) ||
      !('version' in pluginExport) ||
      !('tools' in pluginExport)
    ) {
      console.warn(
        `[Plugin] "${manifest.name}" does not export a valid CodeAgentPlugin object.`
      )
      return
    }

    const plugin = pluginExport as CodeAgentPlugin

    // Register tools
    for (const tool of plugin.tools) {
      dispatcher.register(tool)
    }

    // Register agent definitions
    for (const agent of plugin.agents ?? []) {
      registry.registerExternal(agent, 'user-global')
    }

    console.error(
      `[Plugin] Loaded "${plugin.name}@${plugin.version}" — ` +
      `${plugin.tools.length} tool(s), ${(plugin.agents ?? []).length} agent(s).`
    )
  }
}
```

### 3.4 Public plugin API surface

The public API that plugin authors import from is re-exported through a stable entrypoint. Plugin authors must not reach into `src/**` by relative path.

```typescript
// src/plugin-api/index.ts  (published as "codeagent/plugin-api")

// Types plugin authors need to implement tools
export type { CodeAgentTool, ToolResult, ToolDefinition } from '../tools/types.js'

// Types plugin authors need to define agents
export type { AgentDefinition } from '../agents/types.js'
export { AgentDefinitionSchema } from '../agents/types.js'

// The plugin contract itself
export type { CodeAgentPlugin } from './types.js'
```

### 3.5 Plugin isolation rules

| Rule | Rationale |
|---|---|
| Import only from `codeagent/plugin-api` | Internal modules are not a stable API and may change without notice |
| Prefix tool names with plugin name | Prevents collisions with built-in tools and other plugins |
| Do not modify `process.env` | Shared global state; breaks other components |
| Do not call `process.exit()` | Only the CLI entrypoint may exit |
| Tool errors → `isError: true` result | The agentic loop must continue; don't throw from `execute()` |

---

## 4. Sub-agent Delegation (F29)

### 4.1 What sub-agent delegation is

Sub-agent delegation allows the active session to spawn a **headless child session** that runs a specific agent on a single task. This is analogous to asking a specialist colleague to handle one part of a problem while the main conversation continues.

The `/delegate` command:
1. Resolves the named agent from the registry
2. Creates a child `ConversationController` with that agent active
3. Sends the task string as the first (and only) user message
4. Runs the agentic loop to completion in the child session
5. Streams the child's output to the terminal with a visual indicator
6. Optionally appends the child's final response to the parent's `messages[]`

The child session:
- Inherits the parent's working directory and `ResolvedConfig`
- Inherits the parent's `ProjectContext` (CLAUDE.md content)
- Does **not** inherit the parent's `messages[]` — starts fresh
- Has its own tool dispatcher and permission guard instances
- Has its own token usage counter (not added to parent's usage)

### 4.2 DelegateCommand

```typescript
// src/commands/built-in/DelegateCommand.ts

import type { SlashCommand, CommandContext } from '../types.js'
import { ConversationController } from '../../conversation/ConversationController.js'
import { AgentManager } from '../../agents/AgentManager.js'

/**
 * DelegateCommand
 *
 * Syntax:  /delegate <agent-name> <task description>
 *
 * Example: /delegate security-reviewer Check auth.ts for injection vulnerabilities
 *
 * The task description is everything after the agent name. It is sent as the
 * first user message in the child session.
 *
 * Output formatting:
 *   Child output is printed with a visual prefix to distinguish it from the
 *   parent session:
 *
 *   ┌─ [security-reviewer] ──────────────────────────────────────
 *   │  ... streamed output from child session ...
 *   └────────────────────────────────────────────────────────────
 *
 * Append behavior:
 *   After the child session completes, the user is prompted:
 *   "Append this response to the current conversation? [y/N]"
 *   If yes, the child's final response is appended to the parent's messages[]
 *   as an assistant message, so the parent can reference the delegation result.
 */
export class DelegateCommand implements SlashCommand {
  readonly name = 'delegate'
  readonly description = 'Delegate a task to a specialized agent (headless sub-session)'
  readonly usage = '/delegate <agent-name> <task>'

  async execute(args: string, ctx: CommandContext): Promise<void> {
    const firstSpaceIdx = args.indexOf(' ')
    if (firstSpaceIdx === -1) {
      ctx.output.writeLine(
        'Usage: /delegate <agent-name> <task>\n' +
        'Example: /delegate security-reviewer Check src/auth.ts for vulnerabilities'
      )
      return
    }

    const agentName = args.slice(0, firstSpaceIdx).trim()
    const task = args.slice(firstSpaceIdx + 1).trim()

    if (task.length === 0) {
      ctx.output.writeLine('Delegation task cannot be empty.')
      return
    }

    // Resolve the agent before creating the child session
    const agentDef = ctx.agentManager.listAll().find((a) => a.name === agentName)
    if (agentDef === undefined) {
      const available = ctx.agentManager.listAll().map((a) => a.name).join(', ')
      ctx.output.writeLine(
        `Unknown agent "${agentName}".\nAvailable agents: ${available}`
      )
      return
    }

    ctx.output.writeLine(`\n┌─ [${agentName}] ${'─'.repeat(Math.max(0, 56 - agentName.length))}`)

    try {
      const childController = createChildController(agentName, ctx)
      const result = await childController.handleInputHeadless(task)

      ctx.output.writeLine('└' + '─'.repeat(60))

      // Prompt user to append result to parent conversation
      const append = await ctx.input.prompt('Append this response to the conversation? [y/N] ')
      if (append.trim().toLowerCase() === 'y') {
        ctx.conversationContext.appendAssistantMessage(
          `[Delegated to ${agentName}]\n\n${result}`
        )
        ctx.output.writeLine('Response appended to conversation.')
      }
    } catch (error) {
      ctx.output.writeLine('└' + '─'.repeat(60))
      ctx.output.writeLine(`Delegation failed: ${String(error)}`)
    }
  }
}

/**
 * createChildController
 *
 * Factory function that builds a child ConversationController configured for
 * headless delegation. The child reuses the parent's config and project context
 * but gets its own fresh instances of all stateful services.
 */
function createChildController(agentName: string, ctx: CommandContext): ConversationController {
  // The child AgentManager is constructed with the delegation target agent.
  // It shares the same registry so agent definitions are consistent.
  const childAgentManager = new AgentManager(ctx.agentManager.registry, agentName)

  return new ConversationController({
    config: ctx.config,
    agentManager: childAgentManager,
    projectContext: ctx.projectContext,
    // Child gets fresh tools, permissions, and context — no shared state
    isHeadless: true,
    outputPrefix: '│  ',
  })
}
```

### 4.3 ConversationController — headless mode additions

```typescript
// Additions to src/conversation/ConversationController.ts

export interface ConversationControllerOptions {
  config: ResolvedConfig
  agentManager: AgentManager
  projectContext?: string
  /** When true, does not start readline. Output is prefixed with outputPrefix. */
  isHeadless?: boolean
  /** Prefix printed before each output line in headless mode. Default: "". */
  outputPrefix?: string
}

// New method on ConversationController:
/**
 * handleInputHeadless
 *
 * Sends a single user message, runs the agentic loop to completion, and
 * returns the final assistant response as a string.
 *
 * Used exclusively by DelegateCommand. Not available in interactive mode.
 * Throws if called on a non-headless controller.
 */
async handleInputHeadless(input: string): Promise<string> {
  if (!this.options.isHeadless) {
    throw new Error('handleInputHeadless() called on an interactive controller')
  }
  // ... append user message, run agentic loop, collect final text, return it
}
```

### 4.4 ContextManager isolation in child sessions

The child's `ContextManager` starts with an empty `messages[]`. This is intentional:

- The parent's conversation history is not passed down — the child sees only the task string.
- This prevents information leakage between sessions.
- It also keeps the child's context window clean for the specific task.

If the user needs the child to have context from the parent, they should include relevant information in the task description: `/delegate security-reviewer Review this function: [paste code here]`.

### 4.5 Use cases and examples

**Parallel analysis without context contamination:**

```
User: /delegate security-reviewer Audit src/api/ for authentication bypass vulnerabilities
      ↓
[security-reviewer] reads files in src/api/
[security-reviewer] reports findings
User: Append this response to the conversation? [y/N] y
      ↓
Parent conversation now contains the security report as context
User: Based on that report, which fix should we prioritize?
```

**Documentation generation:**

```
User: /delegate doc-writer Write JSDoc for all exported functions in src/tools/guards.ts
      ↓
[doc-writer] reads guards.ts, writes JSDoc comments
Append this response to the conversation? [y/N] n
```

**Architecture review before implementing:**

```
User: /delegate architect Design the schema for session persistence (F26)
      ↓
[architect] produces a design document
Append this response to the conversation? [y/N] y
User: Looks good. Now implement it.
```

---

## 5. Configuration Extensions

Both MCP and plugins require additions to `ResolvedConfig`:

```typescript
// Additions to src/config/types.ts

/**
 * MCP server configuration.
 * Lives under the "mcp" key in config.json.
 */
export interface MCPConfig {
  /**
   * List of MCP servers to connect to at startup.
   * Tools from all connected servers are registered in ToolDispatcher.
   */
  readonly servers: readonly MCPServerConfig[]
}

export interface MCPServerConfig {
  /** Human-readable label used as tool name prefix: "<name>/<tool>" */
  readonly name: string
  /**
   * Connection URL.
   * Supported schemes: http://, https://, stdio://
   * Example: "http://localhost:3001"
   */
  readonly url: string
}

// Full config shape (additions only — existing fields unchanged)
export interface ResolvedConfig {
  // ... existing fields ...

  /** MCP server connections. Empty by default. */
  readonly mcp: MCPConfig
}
```

Example `~/.codeagent/config.json` with MCP servers:

```json
{
  "model": "claude-sonnet-4-6",
  "permissionMode": "default",
  "mcp": {
    "servers": [
      { "name": "db-tools", "url": "http://localhost:3001" },
      { "name": "internal-api", "url": "http://localhost:3002" }
    ]
  }
}
```

---

## 6. Startup Integration Sequence

The Phase 4 additions fit into the existing bootstrap sequence after Phase 3 services are initialized:

```
Bootstrap (main.ts):
  1. parseArgs()
  2. loadConfig()
  3. new AgentRegistry() → registry.load()          [Phase 2]
  4. new AgentManager(registry, args.agent)         [Phase 2]
  5. new ToolDispatcher() → register built-in tools [Phase 1]
  6. new MCPRegistry() → mcpRegistry.connect(       [Phase 4]
       config.mcp.servers, toolDispatcher
     )
  7. new PluginLoader() → pluginLoader.loadAll(     [Phase 4]
       toolDispatcher, registry
     )
  8. new ConversationController(...)                [Phase 1]
  9. REPL loop or headless execution
  10. on exit: mcpRegistry.disconnectAll()          [Phase 4]
```

Steps 6 and 7 are skipped (zero-cost) when no MCP servers are configured and no plugins are installed.

---

## 7. Security Considerations

### MCP servers

- MCP servers are external processes. Any tool they expose can execute arbitrary code on the user's machine if the model calls it.
- Users are responsible for the security of MCP servers they configure.
- Future: add a confirmation prompt the first time a new MCP server's tools are about to be called, similar to the permission guard for built-in destructive tools.
- MCP tool results are subject to the same 100,000-character output cap as built-in tools.
- MCP tool names must pass a safelist regex (`^[a-z0-9-]+/[a-z0-9_-]+$`) to prevent injection through tool naming.

### Plugins

- Plugins run in the same process with full Node.js API access. There is no sandbox.
- Only install plugins from sources you trust.
- Future: package signing and verification before dynamic import.
- Plugins that register tools with names already taken by built-ins or other plugins will have their duplicate tool rejected with a warning at load time.

### Sub-agent delegation

- The child session inherits the parent's permission mode. If the parent is in `auto` mode, the child is also in `auto` mode.
- The child can only be created with agents that exist in the registry — arbitrary agent definitions cannot be injected through the `/delegate` command.
- Child sessions run in the same process; they do not provide isolation from the parent's filesystem or environment.
