import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry } from './AgentRegistry.js';
import { AgentManager } from './AgentManager.js';

// Use a minimal project directory so load() succeeds quickly.
async function makeRegistry(): Promise<AgentRegistry> {
  const registry = new AgentRegistry();
  // Use a non-existent cwd — built-ins will still load.
  await registry.load('/tmp/__nonexistent_codeagent_test__');
  return registry;
}

describe('AgentManager', () => {
  let registry: AgentRegistry;

  beforeEach(async () => {
    registry = await makeRegistry();
  });

  it('constructs with a valid built-in agent', () => {
    const manager = new AgentManager(registry, 'default');
    expect(manager.current.name).toBe('default');
  });

  it('throws with available agent list when initial name is unknown', () => {
    expect(() => new AgentManager(registry, 'no-such-agent')).toThrow('Available agents:');
  });

  it('current returns the active agent', () => {
    const manager = new AgentManager(registry, 'code-reviewer');
    expect(manager.current.name).toBe('code-reviewer');
    // Built-in agents defer model selection to config (model: undefined).
    expect(manager.current.model).toBeUndefined();
  });

  it('switchTo changes the active agent', () => {
    const manager = new AgentManager(registry, 'default');
    const next = manager.switchTo('code-reviewer');
    expect(next.name).toBe('code-reviewer');
    expect(manager.current.name).toBe('code-reviewer');
  });

  it('switchTo returns the new definition', () => {
    const manager = new AgentManager(registry, 'default');
    const def = manager.switchTo('architect');
    expect(def.name).toBe('architect');
    expect(def.systemPrompt.length).toBeGreaterThan(0);
  });

  it('switchTo throws with helpful message for unknown agent', () => {
    const manager = new AgentManager(registry, 'default');
    expect(() => manager.switchTo('bad-name')).toThrow('Cannot switch to agent "bad-name"');
    expect(() => manager.switchTo('bad-name')).toThrow('Available agents:');
    expect(() => manager.switchTo('bad-name')).toThrow('.codeagent/agents/bad-name.md');
  });

  it('listAll() returns all known agents sorted alphabetically', () => {
    const manager = new AgentManager(registry, 'default');
    const names = manager.listAll().map((a) => a.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain('default');
    expect(names).toContain('code-reviewer');
  });

  it('agentsUsed() starts with the initial agent', () => {
    const manager = new AgentManager(registry, 'default');
    expect(manager.agentsUsed()).toEqual(['default']);
  });

  it('agentsUsed() records switches without consecutive duplicates', () => {
    const manager = new AgentManager(registry, 'default');
    manager.switchTo('code-reviewer');
    manager.switchTo('code-reviewer'); // duplicate — should be suppressed
    manager.switchTo('default');
    expect(manager.agentsUsed()).toEqual(['default', 'code-reviewer', 'default']);
  });
});
