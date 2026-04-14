import type { SlashCommand, CommandContext } from '../types.js';
import type Anthropic from '@anthropic-ai/sdk';

// Rough estimate: 1 token ≈ 4 characters on average.
const CHARS_PER_TOKEN = 4;

function estimateTokens(messages: readonly Anthropic.MessageParam[]): number {
  let total = 0;
  for (const msg of messages) {
    const text =
      typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    total += Math.ceil(text.length / CHARS_PER_TOKEN);
  }
  return total;
}

export class InfoCommand implements SlashCommand {
  readonly name = 'info';
  readonly description = 'Show turn count, active agent, model, and estimated token count';

  async execute(_args: string, ctx: CommandContext): Promise<void> {
    const estimatedTokens = estimateTokens(ctx.messages);

    const info = [
      '## Session Info',
      '',
      `- **Agent:**    ${ctx.activeAgentName}`,
      `- **Model:**    ${ctx.currentModel}`,
      `- **Turns:**    ${String(ctx.turnCount)}`,
      `- **Messages:** ${String(ctx.messages.length)}`,
      `- **Est. context tokens:** ~${estimatedTokens.toLocaleString()}`,
    ].join('\n');

    ctx.renderer.print(info);
  }
}
