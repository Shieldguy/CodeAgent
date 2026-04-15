import type { AgentDefinition } from './types.js';
import type { AgentRegistry } from './AgentRegistry.js';

/**
 * AgentManager
 *
 * Holds the active agent for a session and handles switches via /agent.
 * The messages[] array is never touched on a switch — history is preserved.
 */
export class AgentManager {
  private activeAgent: AgentDefinition;
  private readonly usedNames: string[] = [];

  /**
   * @throws {Error} If the initial agent name is not found in the registry.
   */
  constructor(
    private readonly registry: AgentRegistry,
    initialAgentName: string,
  ) {
    const resolved = registry.resolve(initialAgentName);
    if (resolved === undefined) {
      const available = registry.list().map((a) => a.name).join(', ');
      throw new Error(
        `Unknown agent "${initialAgentName}". Available agents: ${available}`,
      );
    }
    this.activeAgent = resolved;
    this.usedNames.push(resolved.name);
  }

  /** Currently active agent definition. Read on every turn — never cache across turns. */
  get current(): Readonly<AgentDefinition> {
    return this.activeAgent;
  }

  /**
   * Activate a different agent by name. Takes effect on the next API call.
   * Duplicate consecutive names are not recorded in agentsUsed.
   *
   * @throws {Error} If no agent with the given name is found.
   */
  switchTo(name: string): AgentDefinition {
    const resolved = this.registry.resolve(name);
    if (resolved === undefined) {
      const available = this.registry
        .list()
        .map((a) => `  ${a.name}`)
        .join('\n');
      throw new Error(
        `Cannot switch to agent "${name}" — not found.\n` +
          `Available agents:\n${available}\n\n` +
          `To add a custom agent, create a file at:\n` +
          `  .codeagent/agents/${name}.md  (project-local)\n` +
          `  ~/.codeagent/agents/${name}.md  (user-global)`,
      );
    }
    this.activeAgent = resolved;
    // Suppress consecutive duplicates.
    if (this.usedNames[this.usedNames.length - 1] !== resolved.name) {
      this.usedNames.push(resolved.name);
    }
    return resolved;
  }

  /** All known agents sorted by name. Delegates to the registry. */
  listAll(): AgentDefinition[] {
    return this.registry.list();
  }

  /**
   * Ordered list of agent names used this session.
   * First entry is always the initial agent; consecutive duplicates are suppressed.
   */
  agentsUsed(): string[] {
    return [...this.usedNames];
  }
}
