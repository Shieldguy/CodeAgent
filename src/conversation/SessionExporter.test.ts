import { describe, it, expect } from 'vitest';
import { SessionExporter } from './SessionExporter.js';
import type { SessionStats } from './SessionHistory.js';
import type Anthropic from '@anthropic-ai/sdk';

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    startedAt: '2026-04-14T10:00:00.000Z',
    turnCount: 3,
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    estimatedCostUsd: 0.0042,
    agentsUsed: ['default'],
    ...overrides,
  };
}

describe('SessionExporter.toMarkdown()', () => {
  it('produces valid Markdown with all required sections', () => {
    const md = SessionExporter.toMarkdown([], makeStats(), { model: 'opus', agent: 'default' });
    expect(md).toContain('# Session Export');
    expect(md).toContain('## Stats');
    expect(md).toContain('## Conversation');
  });

  it('includes model and agent in the header', () => {
    const md = SessionExporter.toMarkdown([], makeStats(), {
      model: 'claude-opus-4-6',
      agent: 'code-reviewer',
    });
    expect(md).toContain('**Model:** claude-opus-4-6');
    expect(md).toContain('**Agent:** code-reviewer');
  });

  it('includes stats table with token counts', () => {
    const md = SessionExporter.toMarkdown([], makeStats(), { model: 'x', agent: 'y' });
    expect(md).toContain('| Turns | 3 |');
    expect(md).toContain('| Input tokens | 1,000 |');
    expect(md).toContain('| Output tokens | 500 |');
    expect(md).toContain('| Estimated cost | $0.0042 |');
  });

  it('includes endedAt row when present', () => {
    const stats = makeStats({ endedAt: '2026-04-14T11:00:00.000Z' });
    const md = SessionExporter.toMarkdown([], stats, { model: 'x', agent: 'y' });
    expect(md).toContain('| Session ended | 2026-04-14T11:00:00.000Z |');
  });

  it('omits endedAt row when absent', () => {
    const md = SessionExporter.toMarkdown([], makeStats(), { model: 'x', agent: 'y' });
    expect(md).not.toContain('Session ended');
  });

  it('formats agentsUsed with arrow separator', () => {
    const stats = makeStats({ agentsUsed: ['default', 'code-reviewer'] });
    const md = SessionExporter.toMarkdown([], stats, { model: 'x', agent: 'y' });
    expect(md).toContain('default -> code-reviewer');
  });

  it('formats user messages with **User:** prefix', () => {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'Hello there!' }];
    const md = SessionExporter.toMarkdown(messages, makeStats(), { model: 'x', agent: 'y' });
    expect(md).toContain('**User:** Hello there!');
  });

  it('formats assistant text messages with **Assistant:** prefix', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'Hi back!' }] },
    ];
    const md = SessionExporter.toMarkdown(messages, makeStats(), { model: 'x', agent: 'y' });
    expect(md).toContain('**Assistant:** Hi back!');
  });

  it('formats tool_use blocks', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu_01',
            name: 'read_file',
            input: { path: 'src/foo.ts' },
          },
        ],
      },
    ];
    const md = SessionExporter.toMarkdown(messages, makeStats(), { model: 'x', agent: 'y' });
    expect(md).toContain('**Tool:** read_file');
  });

  it('truncates tool results longer than 500 chars', () => {
    const longText = 'x'.repeat(600);
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_01',
            content: longText,
          },
        ],
      },
    ];
    const md = SessionExporter.toMarkdown(messages, makeStats(), { model: 'x', agent: 'y' });
    expect(md).toContain('(truncated,');
    // Should not contain more than 500 x's in a row
    expect(md).not.toMatch(/x{501}/);
  });

  it('marks tool result errors', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_01',
            content: 'Permission denied',
            is_error: true,
          },
        ],
      },
    ];
    const md = SessionExporter.toMarkdown(messages, makeStats(), { model: 'x', agent: 'y' });
    expect(md).toContain('[ERROR]');
  });

  it('handles empty messages array gracefully', () => {
    const md = SessionExporter.toMarkdown([], makeStats(), { model: 'x', agent: 'y' });
    expect(md).toContain('## Conversation');
  });

  it('handles string content in assistant messages', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'assistant', content: 'Simple string reply' },
    ];
    const md = SessionExporter.toMarkdown(messages, makeStats(), { model: 'x', agent: 'y' });
    expect(md).toContain('**Assistant:** Simple string reply');
  });
});
