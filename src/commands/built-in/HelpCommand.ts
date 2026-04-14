import type { SlashCommand, CommandContext } from '../types.js';
import type { SlashCommandEngine } from '../SlashCommandEngine.js';

export class HelpCommand implements SlashCommand {
  readonly name = 'help';
  readonly aliases = ['?'] as const;
  readonly description = 'List all available commands';

  constructor(private readonly engine: SlashCommandEngine) {}

  async execute(_args: string, ctx: CommandContext): Promise<void> {
    const commands = this.engine.listCommands();
    const lines: string[] = ['## Available Commands\n'];

    for (const cmd of commands) {
      const aliases =
        cmd.aliases && cmd.aliases.length > 0
          ? ` _(also: ${cmd.aliases.map((a) => `/${a}`).join(', ')})_`
          : '';
      lines.push(`- **/${cmd.name}**${aliases} — ${cmd.description}`);
    }

    ctx.renderer.print(lines.join('\n'));
  }
}
