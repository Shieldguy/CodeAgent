import type { SlashCommand, CommandContext } from '../types.js';

export class ClearCommand implements SlashCommand {
  readonly name = 'clear';
  readonly description = 'Reset conversation history to empty';

  async execute(_args: string, ctx: CommandContext): Promise<void> {
    const count = ctx.messages.length;
    ctx.clearMessages();
    ctx.renderer.printInfo(
      `Conversation cleared. (${String(count)} message${count === 1 ? '' : 's'} removed)`,
    );
  }
}
