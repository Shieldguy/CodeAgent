import type Anthropic from '@anthropic-ai/sdk';
import type { SessionStats } from './SessionHistory.js';

const TOOL_RESULT_MAX_CHARS = 500;

export interface ExportOptions {
  readonly model: string;
  readonly agent: string;
}

/**
 * SessionExporter
 *
 * Pure module — no I/O, no side effects. Converts a message history and
 * SessionStats into a human-readable Markdown string.
 *
 * Output structure:
 *   # Session Export
 *   ## Stats
 *   ## Conversation
 */
export const SessionExporter = {
  toMarkdown(
    messages: readonly Anthropic.MessageParam[],
    stats: SessionStats,
    options: ExportOptions,
  ): string {
    const sections: string[] = [];

    // Header
    sections.push(
      `# Session Export\n\n` +
        `**Date:** ${stats.startedAt}  \n` +
        `**Model:** ${options.model}  \n` +
        `**Agent:** ${options.agent}  \n`,
    );

    // Stats table
    const endedRow =
      stats.endedAt !== undefined ? `| Session ended | ${stats.endedAt} |\n` : '';

    sections.push(
      `## Stats\n\n` +
        `| Metric | Value |\n` +
        `|--------|-------|\n` +
        `| Session started | ${stats.startedAt} |\n` +
        endedRow +
        `| Turns | ${String(stats.turnCount)} |\n` +
        `| Input tokens | ${stats.totalInputTokens.toLocaleString()} |\n` +
        `| Output tokens | ${stats.totalOutputTokens.toLocaleString()} |\n` +
        `| Estimated cost | $${stats.estimatedCostUsd.toFixed(4)} |\n` +
        `| Agents used | ${stats.agentsUsed.join(' -> ')} |\n`,
    );

    // Conversation
    const conversationLines: string[] = ['## Conversation\n'];
    for (const message of messages) {
      if (message.role === 'user') {
        conversationLines.push(`**User:** ${extractUserContent(message.content)}\n`);
      } else if (message.role === 'assistant') {
        conversationLines.push(...extractAssistantContent(message.content));
      }
    }
    sections.push(conversationLines.join('\n'));

    return sections.join('\n---\n\n');
  },
};

function extractUserContent(content: Anthropic.MessageParam['content']): string {
  if (typeof content === 'string') return content;

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'tool_result') {
      const rawContent = Array.isArray(block.content)
        ? block.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('')
        : ((block.content as string | undefined) ?? '');
      const truncated = truncate(rawContent, TOOL_RESULT_MAX_CHARS);
      const isError = block.is_error === true ? ' [ERROR]' : '';
      parts.push(`**Tool result** (${block.tool_use_id})${isError}: ${truncated}`);
    }
  }
  return parts.join('\n\n');
}

function extractAssistantContent(content: Anthropic.MessageParam['content']): string[] {
  if (typeof content === 'string') return [`**Assistant:** ${content}\n`];

  const lines: string[] = [];
  for (const block of content as Anthropic.ContentBlock[]) {
    if (block.type === 'text' && block.text.trim().length > 0) {
      lines.push(`**Assistant:** ${block.text.trim()}\n`);
    } else if (block.type === 'tool_use') {
      const inputStr = truncate(JSON.stringify(block.input, null, 2), TOOL_RESULT_MAX_CHARS);
      lines.push(`**Tool:** ${block.name} -> \`\`\`\n${inputStr}\n\`\`\`\n`);
    }
  }
  return lines;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n... (truncated, ${String(text.length - maxChars)} chars omitted)`;
}
