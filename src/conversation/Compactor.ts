import type Anthropic from '@anthropic-ai/sdk';

const SUMMARIZATION_SYSTEM_PROMPT = `You are a conversation summarizer.
Your task is to produce a dense, factual summary of a conversation between a user
and an AI coding assistant.

Rules:
- Include all files that were read, written, or modified (with their paths).
- Include all commands that were run and their outcomes.
- Include all decisions made and their rationale.
- Include any errors encountered and how they were resolved.
- Use bullet points grouped by topic.
- Do not include pleasantries, acknowledgments, or meta-commentary.
- Write in past tense ("The user asked...", "The assistant ran...").
- Be concise: aim for 300–500 words. Never exceed 1000 words.
`;

/**
 * Summarize a list of messages into a compact text string.
 *
 * Phase 1: returns a placeholder string without making an API call.
 * Phase 3 (F27): replace with the real implementation below.
 *
 * @param _client - Anthropic SDK client (unused in Phase 1).
 * @param _model  - Model ID (unused in Phase 1).
 * @param messages - The messages to summarize.
 */
export async function summarizeMessages(
  _client: Anthropic,
  _model: string,
  messages: Anthropic.MessageParam[],
): Promise<string> {
  if (messages.length === 0) {
    return '(no messages to summarize)';
  }

  // Phase 1 placeholder — no API call.
  // Replace this block with the real implementation in Phase 3 (F27).
  return (
    `[Placeholder summary: ${messages.length} messages from the earlier conversation ` +
    `were omitted due to context length. Use /clear if the context becomes too long.]`
  );
}

/**
 * Phase 3 real implementation (kept here as reference, not exported yet).
 * Activate by replacing summarizeMessages above with this function body.
 */
async function _summarizeMessagesReal(
  client: Anthropic,
  model: string,
  messages: Anthropic.MessageParam[],
): Promise<string> {
  if (messages.length === 0) {
    return '(no messages to summarize)';
  }

  const transcript = messages
    .map((msg) => {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content
              .map((block) => {
                if ('text' in block && typeof block.text === 'string') return block.text;
                if (block.type === 'tool_use') return `[Tool call: ${block.name}]`;
                if (block.type === 'tool_result') {
                  const raw =
                    typeof block.content === 'string'
                      ? block.content
                      : '(structured result)';
                  return `[Tool result: ${raw.slice(0, 200)}]`;
                }
                return '[Unknown block]';
              })
              .join('\n');
      return `${role}: ${content}`;
    })
    .join('\n\n---\n\n');

  const response = await client.messages.create({
    model,
    max_tokens: 1_024,
    system: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Please summarize the following conversation:\n\n${transcript}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Summarization API returned no text content.');
  }

  return textBlock.text;
}

// Prevent unused-variable errors on the reference implementation.
void _summarizeMessagesReal;
