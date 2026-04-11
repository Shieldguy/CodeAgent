import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { assertSafePath } from './guards.js';
import { computeDiff } from './diffPreview.js';
import type { CodeAgentTool, DiffPreviewable, ToolResult } from './types.js';
import type Anthropic from '@anthropic-ai/sdk';

const EditFileParams = z.object({
  file_path: z.string().min(1, 'file_path must not be empty'),
  old_string: z.string().min(1, 'old_string must not be empty'),
  new_string: z.string(),
  replace_all: z.boolean().default(false),
});

type EditFileParams = z.infer<typeof EditFileParams>;

export class EditFileTool implements CodeAgentTool, DiffPreviewable {
  readonly definition: Anthropic.Tool = {
    name: 'edit_file',
    description:
      'Make a surgical string replacement in a file. ' +
      'old_string must match exactly (including whitespace). ' +
      'Returns an error if old_string appears more than once and replace_all is false.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file to edit (relative to working directory).',
        },
        old_string: {
          type: 'string',
          description: 'Exact string to find in the file. Must match exactly including whitespace.',
        },
        new_string: {
          type: 'string',
          description: 'String to replace old_string with. May be empty to delete old_string.',
        },
        replace_all: {
          type: 'boolean',
          description:
            'If true, replace all occurrences. ' +
            'If false and multiple exist, returns an error.',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  };

  /**
   * Build a unified diff showing what the edit would change.
   * Called by ConversationController before the permission check.
   */
  async buildDiffPreview(input: Record<string, unknown>, workingDir: string): Promise<string> {
    let params: EditFileParams;
    try {
      params = EditFileParams.parse(input);
    } catch {
      return '';
    }

    const absolutePath = path.resolve(workingDir, params.file_path);
    let original: string;
    try {
      original = fs.readFileSync(absolutePath, 'utf-8');
    } catch {
      return '';
    }

    const updated = params.replace_all
      ? original.split(params.old_string).join(params.new_string)
      : original.replace(params.old_string, params.new_string);

    return computeDiff(params.file_path, original, updated);
  }

  async execute(input: Record<string, unknown>, workingDir: string): Promise<ToolResult> {
    let params: EditFileParams;
    try {
      params = EditFileParams.parse(input);
    } catch (error) {
      return {
        content: `Invalid parameters: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    const absolutePath = path.resolve(workingDir, params.file_path);

    try {
      assertSafePath(params.file_path, workingDir);
    } catch (error) {
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }

    if (!fs.existsSync(absolutePath)) {
      return {
        content: `File not found: ${params.file_path}`,
        isError: true,
      };
    }

    let original: string;
    try {
      original = fs.readFileSync(absolutePath, 'utf-8');
    } catch (error) {
      return {
        content: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    const occurrenceCount = this.countOccurrences(original, params.old_string);

    if (occurrenceCount === 0) {
      const preview =
        params.old_string.length > 80
          ? params.old_string.slice(0, 80) + '...'
          : params.old_string;
      return {
        content: `String not found in file: "${preview}"`,
        isError: true,
      };
    }

    if (occurrenceCount > 1 && !params.replace_all) {
      return {
        content:
          `old_string appears ${String(occurrenceCount)} times in ${params.file_path}. ` +
          `Set replace_all: true to replace all occurrences, ` +
          `or provide a more specific old_string that matches exactly once.`,
        isError: true,
      };
    }

    const updated = params.replace_all
      ? original.split(params.old_string).join(params.new_string)
      : original.replace(params.old_string, params.new_string);

    // No-op check.
    if (updated === original) {
      return {
        content: 'No changes made (old_string and new_string produce identical content).',
        isError: false,
      };
    }

    try {
      fs.writeFileSync(absolutePath, updated, 'utf-8');
    } catch (error) {
      return {
        content: `Failed to write file: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    const replacedCount = params.replace_all ? occurrenceCount : 1;
    return {
      content: `Replaced ${String(replacedCount)} occurrence${replacedCount === 1 ? '' : 's'} in ${params.file_path}.`,
      isError: false,
    };
  }

  /** Count non-overlapping occurrences of `needle` in `haystack`. */
  private countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }
}
