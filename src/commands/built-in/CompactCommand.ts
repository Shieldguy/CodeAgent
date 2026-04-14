import type { SlashCommand, CommandContext } from '../types.js';

export class CompactCommand implements SlashCommand {
  readonly name = 'compact';
  readonly description = 'Trigger immediate context compaction regardless of token count';

  async execute(_args: string, ctx: CommandContext): Promise<void> {
    const before = ctx.messages.length;
    ctx.renderer.printInfo('Compacting context...');
    try {
      await ctx.compact();
      const after = ctx.messages.length;
      ctx.renderer.printInfo(`Context compacted. Messages: ${String(before)} → ${String(after)}`);
    } catch (error) {
      ctx.renderer.printError(`Compaction failed: ${String(error)}`);
    }
  }
}
