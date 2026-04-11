import { glob } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { assertSafePath, capOutput } from './guards.js';
import type { CodeAgentTool, ToolResult } from './types.js';
import type Anthropic from '@anthropic-ai/sdk';

const GlobParams = z.object({
  pattern: z.string().min(1, 'pattern must not be empty'),
  path: z.string().optional(),
});

type GlobParams = z.infer<typeof GlobParams>;

export class GlobTool implements CodeAgentTool {
  readonly definition: Anthropic.Tool = {
    name: 'glob',
    description:
      'Find files matching a glob pattern in the project directory. ' +
      'Returns a sorted list of matching file paths.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match (e.g., "**/*.ts", "src/**/*.test.ts").',
        },
        path: {
          type: 'string',
          description:
            'Directory to search in. Defaults to the working directory.',
        },
      },
      required: ['pattern'],
    },
  };

  async execute(input: Record<string, unknown>, workingDir: string): Promise<ToolResult> {
    let params: GlobParams;
    try {
      params = GlobParams.parse(input);
    } catch (error) {
      return {
        content: `Invalid parameters: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    const searchDir = params.path
      ? path.resolve(workingDir, params.path)
      : workingDir;

    try {
      assertSafePath(searchDir, workingDir);
    } catch (error) {
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }

    let matches: string[];
    try {
      matches = [];
      for await (const match of glob(params.pattern, { cwd: searchDir })) {
        matches.push(String(match));
      }
      matches.sort();
    } catch (error: unknown) {
      return {
        content: `Glob failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    if (matches.length === 0) {
      return {
        content: `No files matched pattern: ${params.pattern}`,
        isError: false,
      };
    }

    return {
      content: capOutput(matches.join('\n'), 'glob'),
      isError: false,
    };
  }
}
