import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { assertSafePath } from './guards.js';
import type { CodeAgentTool, ToolResult } from './types.js';
import type Anthropic from '@anthropic-ai/sdk';

const ReadFileParams = z.object({
  path: z.string().min(1, 'path must not be empty'),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
});

type ReadFileParams = z.infer<typeof ReadFileParams>;

export class ReadFileTool implements CodeAgentTool {
  readonly definition: Anthropic.Tool = {
    name: 'read_file',
    description:
      'Read the contents of a file. Optionally read a line range. ' +
      'Output includes 1-based line numbers prefixed to each line.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file, relative to the working directory.',
        },
        start_line: {
          type: 'number',
          description: 'First line to read (1-based, inclusive). Defaults to 1.',
        },
        end_line: {
          type: 'number',
          description: 'Last line to read (1-based, inclusive). Defaults to end of file.',
        },
      },
      required: ['path'],
    },
  };

  async execute(input: Record<string, unknown>, workingDir: string): Promise<ToolResult> {
    let params: ReadFileParams;
    try {
      params = ReadFileParams.parse(input);
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

    let rawContent: string;
    try {
      rawContent = await fs.readFile(absolutePath, 'utf8');
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { content: `File not found: "${params.path}"`, isError: true };
      }
      if (code === 'EACCES') {
        return { content: `Permission denied: "${params.path}"`, isError: true };
      }
      return {
        content: `Failed to read "${params.path}": ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    const allLines = rawContent.split('\n');
    const startIdx = (params.start_line ?? 1) - 1; // 0-based
    const endIdx = params.end_line !== undefined ? params.end_line - 1 : allLines.length - 1;

    if (startIdx < 0 || startIdx >= allLines.length) {
      return {
        content: `start_line ${String(params.start_line)} is out of range (file has ${String(allLines.length)} lines).`,
        isError: true,
      };
    }

    const selectedLines = allLines.slice(startIdx, endIdx + 1);

    // Prefix each line with its 1-based line number, padded for alignment.
    const padWidth = String(allLines.length).length;
    const numbered = selectedLines
      .map((line, idx) => {
        const lineNum = String(startIdx + idx + 1).padStart(padWidth, ' ');
        return `${lineNum}\t${line}`;
      })
      .join('\n');

    const rangeNote =
      params.start_line !== undefined || params.end_line !== undefined
        ? ` (lines ${String(startIdx + 1)}–${String(Math.min(endIdx + 1, allLines.length))} of ${String(allLines.length)})`
        : ` (${String(allLines.length)} lines)`;

    return {
      content: `File: ${params.path}${rangeNote}\n\n${numbered}`,
      isError: false,
    };
  }
}
