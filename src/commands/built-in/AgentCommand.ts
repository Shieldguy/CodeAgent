import type { SlashCommand, CommandContext } from '../types.js';

export class AgentCommand implements SlashCommand {
  readonly name = 'agent';
  readonly description = 'List available agents or switch to a named agent';

  async execute(args: string, ctx: CommandContext): Promise<void> {
    const targetName = args.trim();

    if (!targetName) {
      // No argument: list all available agents with current marked.
      const agents = ctx.listAgents();
      const lines = ['## Available Agents\n'];

      for (const agent of agents) {
        const isCurrent = agent.name === ctx.activeAgentName;
        const marker = isCurrent ? ' ✓' : '';
        const model = agent.model !== undefined ? ` _(model: ${agent.model})_` : '';
        lines.push(`- **${agent.name}**${marker} — ${agent.description}${model}`);
      }

      ctx.renderer.print(lines.join('\n'));
      return;
    }

    // Switch to the named agent.
    const prior = ctx.activeAgentName;
    try {
      await ctx.switchAgent(targetName);
      ctx.renderer.printInfo(`Agent switched: ${prior} → ${targetName}`);
    } catch (error) {
      ctx.renderer.printError(
        `Cannot switch to agent "${targetName}": ${String(error)}\n` +
          `Run /agent to see available agents.`,
      );
    }
  }
}
