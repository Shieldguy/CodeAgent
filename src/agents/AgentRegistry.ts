import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fromFile } from './AgentLoader.js';
import { BUILT_IN_AGENTS } from './built-in/index.js';
import type { AgentDefinition, LoadedAgent } from './types.js';

/**
 * AgentRegistry
 *
 * Discovers agent definitions from three sources with deterministic priority:
 *   1. Project-local: <cwd>/.codeagent/agents/*.md  (highest)
 *   2. User-global:   ~/.codeagent/agents/*.md
 *   3. Built-in:      bundled TypeScript definitions  (lowest)
 *
 * Same-name definitions: highest-priority source silently wins.
 */
export class AgentRegistry {
  private readonly agents: Map<string, LoadedAgent> = new Map();
  private loaded = false;

  /**
   * Discover all agents from all sources. Idempotent — only runs once.
   *
   * Per-file errors in user/project directories are warned, not thrown.
   * Built-in loading errors are rethrown (they indicate a code defect).
   */
  async load(workingDir: string = process.cwd()): Promise<void> {
    if (this.loaded) return;

    // Load in reverse-priority order so higher-priority sources overwrite lower.

    // 1. Built-ins (lowest priority)
    for (const definition of BUILT_IN_AGENTS) {
      this.agents.set(definition.name, { definition, source: 'built-in' });
    }

    // 2. User-global
    const userAgentsDir = path.join(os.homedir(), '.codeagent', 'agents');
    await this.loadDirectory(userAgentsDir, 'user-global');

    // 3. Project-local (highest priority)
    const projectAgentsDir = path.join(workingDir, '.codeagent', 'agents');
    await this.loadDirectory(projectAgentsDir, 'project-local');

    this.loaded = true;
  }

  private async loadDirectory(
    dir: string,
    source: 'user-global' | 'project-local',
  ): Promise<void> {
    let filePaths: string[];
    try {
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      filePaths = dirents
        .filter((d) => d.isFile() && d.name.endsWith('.md'))
        .map((d) => path.join(dir, d.name));
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      console.warn(`[AgentRegistry] Cannot read agent directory "${dir}": ${String(error)}`);
      return;
    }

    for (const filePath of filePaths) {
      try {
        const definition = await fromFile(filePath);
        this.agents.set(definition.name, { definition, source, filePath });
      } catch (error) {
        console.warn(`[AgentRegistry] Skipping agent file "${filePath}": ${String(error)}`);
      }
    }
  }

  /** Returns the AgentDefinition for the given name, or undefined if not found. */
  resolve(name: string): AgentDefinition | undefined {
    return this.agents.get(name)?.definition;
  }

  /** All loaded agents sorted alphabetically by name. */
  list(): AgentDefinition[] {
    return Array.from(this.agents.values())
      .map((e) => e.definition)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
