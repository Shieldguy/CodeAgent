import type Anthropic from '@anthropic-ai/sdk';
import type { CodeAgentTool, DiffPreviewable, ToolResult } from './types.js';
import { capOutput } from './guards.js';

/**
 * ToolDispatcher is the single entry point for all tool execution.
 * It maintains a registry of tools and dispatches calls by name.
 * Output capping is applied after execution.
 */
export class ToolDispatcher {
  private readonly registry: Map<string, CodeAgentTool>;

  constructor() {
    this.registry = new Map();
  }

  /**
   * Register a tool. Throws if a tool with the same name is already registered.
   */
  register(tool: CodeAgentTool): void {
    const name = tool.definition.name;
    if (this.registry.has(name)) {
      throw new Error(`Tool "${name}" is already registered.`);
    }
    this.registry.set(name, tool);
  }

  /**
   * Returns the Anthropic Tool schemas for all registered tools.
   * If `allowlist` is provided, only tools in the allowlist are returned.
   */
  allDefinitions(allowlist?: ReadonlySet<string>): Anthropic.Tool[] {
    const definitions: Anthropic.Tool[] = [];
    for (const [name, tool] of this.registry) {
      if (allowlist === undefined || allowlist.has(name)) {
        definitions.push(tool.definition);
      }
    }
    return definitions;
  }

  /**
   * Retrieve a registered tool by name. Returns undefined if not found.
   * Used by ConversationController to call buildDiffPreview() before dispatch.
   */
  getTool(name: string): CodeAgentTool | undefined {
    return this.registry.get(name);
  }

  /**
   * Get a diff preview for a tool call if the tool supports it.
   * Returns undefined if the tool does not implement DiffPreviewable.
   */
  async getDiffPreview(
    name: string,
    input: Record<string, unknown>,
    workingDir: string,
  ): Promise<string | undefined> {
    const tool = this.registry.get(name);
    if (!tool) return undefined;

    // Check if the tool supports diff preview (WriteFileTool, EditFileTool).
    if ('buildDiffPreview' in tool && typeof (tool as DiffPreviewable).buildDiffPreview === 'function') {
      return (tool as DiffPreviewable).buildDiffPreview(input, workingDir);
    }

    return undefined;
  }

  /**
   * Dispatch a tool call by name.
   * Applies output capping to the result.
   * Never throws — returns an error ToolResult for unknown tools or thrown exceptions.
   */
  async dispatch(
    name: string,
    input: Record<string, unknown>,
    workingDir: string,
  ): Promise<ToolResult> {
    const tool = this.registry.get(name);

    if (!tool) {
      return {
        content: `Unknown tool: "${name}". Available tools: ${[...this.registry.keys()].join(', ')}.`,
        isError: true,
      };
    }

    try {
      const result = await tool.execute(input, workingDir);
      return {
        content: capOutput(result.content, name),
        isError: result.isError,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: `Tool "${name}" threw an unexpected error: ${message}`,
        isError: true,
      };
    }
  }
}
