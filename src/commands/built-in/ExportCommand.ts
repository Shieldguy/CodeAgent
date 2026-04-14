import type { SlashCommand, CommandContext } from '../types.js';

export class ExportCommand implements SlashCommand {
  readonly name = 'export';
  readonly description = 'Save the current conversation to a Markdown file';

  async execute(_args: string, ctx: CommandContext): Promise<void> {
    ctx.renderer.printInfo('Exporting session...');
    try {
      const filePath = await ctx.exportSession();
      ctx.renderer.printInfo(`Session exported to: ${filePath}`);
    } catch (error) {
      ctx.renderer.printError(`Export failed: ${String(error)}`);
    }
  }
}
