import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { assertSafePath } from './guards.js';
import { computeDiff } from './diffPreview.js';
import type { CodeAgentTool, DiffPreviewable, ToolResult } from './types.js';
import type Anthropic from '@anthropic-ai/sdk';

const WriteFileParams = z.object({
  path: z.string().min(1, 'path must not be empty'),
  content: z.string(),
});

type WriteFileParams = z.infer<typeof WriteFileParams>;

export class WriteFileTool implements CodeAgentTool, DiffPreviewable {
  readonly definition: Anthropic.Tool = {
    name: 'write_file',
    description:
      'Write content to a file. Creates the file if it does not exist, ' +
      'or overwrites it if it does. Creates parent directories as needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to write, relative to the working directory.',
        },
        content: {
          type: 'string',
          description: 'The full content to write to the file.',
        },
      },
      required: ['path', 'content'],
    },
  };

  /**
   * Build a unified diff between the current file content and the new content.
   * Called by ConversationController before the permission check so the diff
   * can be displayed alongside the y/n/a prompt.
   */
  async buildDiffPreview(input: Record<string, unknown>, workingDir: string): Promise<string> {
    let params: WriteFileParams;
    try {
      params = WriteFileParams.parse(input);
    } catch {
      return '';
    }

    const absolutePath = path.resolve(workingDir, params.path);
    let existingContent = '';
    try {
      existingContent = await fs.readFile(absolutePath, 'utf8');
    } catch {
      // File doesn't exist yet — diff from empty.
    }
    return computeDiff(params.path, existingContent, params.content);
  }

  async execute(input: Record<string, unknown>, workingDir: string): Promise<ToolResult> {
    let params: WriteFileParams;
    try {
      params = WriteFileParams.parse(input);
    } catch (error) {
      return {
        content: `Invalid parameters: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    try {
      assertSafePath(params.path, workingDir);
    } catch (error) {
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }

    const absolutePath = path.resolve(workingDir, params.path);

    try {
      // Create parent directories if they do not exist.
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, params.content, 'utf8');
    } catch (error: unknown) {
      return {
        content: `Failed to write "${params.path}": ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    const lineCount = params.content.split('\n').length;
    return {
      content: `Successfully wrote ${String(lineCount)} lines to "${params.path}".`,
      isError: false,
    };
  }
}
