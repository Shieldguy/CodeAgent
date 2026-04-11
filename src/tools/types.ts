import type Anthropic from '@anthropic-ai/sdk';

/**
 * The result returned by every tool execution.
 * Matches the structure expected by Anthropic's tool_result message format.
 */
export interface ToolResult {
  /** Text content to report back to the model. May be truncated by capOutput(). */
  content: string;
  /** True if the operation failed. The model sees this and can decide how to proceed. */
  isError: boolean;
}

/**
 * Every tool in the system implements this interface.
 * The `definition` field is the Anthropic Tool schema sent to the API.
 * The `execute` method is called by ToolDispatcher after permission checks.
 */
export interface CodeAgentTool {
  /** The Anthropic Tool schema (name, description, input_schema). */
  readonly definition: Anthropic.Tool;

  /**
   * Execute the tool with the given raw input.
   *
   * @param input - Raw input object from the model (validated inside execute()).
   * @param workingDir - Absolute path of the session's working directory.
   * @returns A ToolResult, always. Should never throw.
   */
  execute(input: Record<string, unknown>, workingDir: string): Promise<ToolResult>;
}

/**
 * Tools that support diff preview implement this interface.
 * ConversationController calls buildDiffPreview() before the permission check
 * so the diff can be displayed alongside the y/n/a prompt.
 */
export interface DiffPreviewable {
  buildDiffPreview(input: Record<string, unknown>, workingDir: string): Promise<string>;
}
