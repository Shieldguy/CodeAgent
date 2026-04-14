import type { SlashCommand, CommandContext } from '../types.js';

export class UsageCommand implements SlashCommand {
  readonly name = 'usage';
  readonly description = 'Show cumulative token count and estimated cost for this session';

  async execute(_args: string, ctx: CommandContext): Promise<void> {
    ctx.renderer.print(ctx.usageTracker.formatSummary());
  }
}
