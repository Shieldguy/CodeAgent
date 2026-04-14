import type { SlashCommand, CommandContext } from './types.js';
import { ClearCommand } from './built-in/ClearCommand.js';
import { ExitCommand } from './built-in/ExitCommand.js';
import { HelpCommand } from './built-in/HelpCommand.js';
import { InfoCommand } from './built-in/InfoCommand.js';
import { AgentCommand } from './built-in/AgentCommand.js';
import { UsageCommand } from './built-in/UsageCommand.js';
import { ExportCommand } from './built-in/ExportCommand.js';
import { CompactCommand } from './built-in/CompactCommand.js';

/**
 * SlashCommandEngine intercepts user input starting with '/' and dispatches
 * it to the appropriate handler — bypassing the Anthropic API entirely.
 *
 * Analogy: like a restaurant intercom — messages addressed to the kitchen
 * (/compact, /clear) never reach the customer. Only plain input goes through
 * the main API channel.
 */
export class SlashCommandEngine {
  private readonly commands: Map<string, SlashCommand> = new Map();

  constructor() {
    this.registerBuiltIns();
  }

  /**
   * Register a command by its primary name and all aliases.
   * An existing registration with the same name is overwritten.
   */
  register(cmd: SlashCommand): void {
    this.commands.set(cmd.name, cmd);
    for (const alias of cmd.aliases ?? []) {
      this.commands.set(alias, cmd);
    }
  }

  /**
   * Attempt to execute a user input string as a slash command.
   *
   * @returns true if the input was handled (including error cases),
   *          false if the input does not start with '/'.
   */
  async execute(input: string, ctx: CommandContext): Promise<boolean> {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) {
      return false;
    }

    const withoutSlash = trimmed.slice(1);
    const spaceIndex = withoutSlash.indexOf(' ');
    const name = spaceIndex === -1 ? withoutSlash : withoutSlash.slice(0, spaceIndex);
    const args = spaceIndex === -1 ? '' : withoutSlash.slice(spaceIndex + 1).trim();

    const cmd = this.commands.get(name.toLowerCase());
    if (!cmd) {
      ctx.renderer.printError(
        `Unknown command: /${name}\nType /help to see available commands.`,
      );
      return true; // handled (with error) — do not forward to API
    }

    try {
      await cmd.execute(args, ctx);
    } catch (error) {
      ctx.renderer.printError(`Command /${name} failed: ${String(error)}`);
    }

    return true;
  }

  /**
   * Return all unique registered commands sorted by primary name.
   * Aliases are not listed separately.
   */
  listCommands(): SlashCommand[] {
    const seen = new Set<SlashCommand>();
    for (const cmd of this.commands.values()) {
      seen.add(cmd);
    }
    return [...seen].sort((a, b) => a.name.localeCompare(b.name));
  }

  private registerBuiltIns(): void {
    const builtIns: SlashCommand[] = [
      new ClearCommand(),
      new ExitCommand(),
      new HelpCommand(this),
      new InfoCommand(),
      new AgentCommand(),
      new UsageCommand(),
      new ExportCommand(),
      new CompactCommand(),
    ];
    for (const cmd of builtIns) {
      this.register(cmd);
    }
  }
}
