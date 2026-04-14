import type { SlashCommand, CommandContext } from '../types.js';

export class ExitCommand implements SlashCommand {
  readonly name = 'exit';
  readonly aliases = ['quit', 'q'] as const;
  readonly description = 'Show usage summary and exit the session';

  async execute(_args: string, ctx: CommandContext): Promise<void> {
    ctx.renderer.print(ctx.usageTracker.formatSummary());
    ctx.exit(0);
  }
}
