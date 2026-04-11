import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { assertSafePath, capOutput } from './guards.js';
import type { CodeAgentTool, ToolResult } from './types.js';
import type Anthropic from '@anthropic-ai/sdk';

const execFileAsync = promisify(execFile);

const GrepParams = z.object({
  pattern: z.string().min(1, 'pattern must not be empty'),
  path: z.string().optional(),
  glob: z.string().optional(),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).default('content'),
  context: z.number().int().min(0).max(10).default(0),
  case_insensitive: z.boolean().default(false),
});

type GrepParams = z.infer<typeof GrepParams>;

export class GrepTool implements CodeAgentTool {
  readonly definition: Anthropic.Tool = {
    name: 'grep',
    description:
      'Search file contents for a regular expression pattern. ' +
      'Supports content, files_with_matches, and count output modes.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regular expression pattern to search for.',
        },
        path: {
          type: 'string',
          description: 'File or directory to search in. Defaults to working directory.',
        },
        glob: {
          type: 'string',
          description: 'Glob pattern to filter which files are searched (e.g., "*.ts").',
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description:
            'content = matching lines; files_with_matches = file paths only; count = match counts.',
        },
        context: {
          type: 'number',
          description: 'Lines of surrounding context before and after each match (0–10).',
        },
        case_insensitive: {
          type: 'boolean',
          description: 'Whether the search is case-insensitive.',
        },
      },
      required: ['pattern'],
    },
  };

  async execute(input: Record<string, unknown>, workingDir: string): Promise<ToolResult> {
    let params: GrepParams;
    try {
      params = GrepParams.parse(input);
    } catch (error) {
      return {
        content: `Invalid parameters: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    const searchPath = params.path ? path.resolve(workingDir, params.path) : workingDir;

    try {
      assertSafePath(searchPath, workingDir);
    } catch (error) {
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }

    // Try ripgrep first; fall back to Node.js implementation.
    try {
      return await this.runRipgrep(params, searchPath);
    } catch {
      return this.runNodeGrep(params, searchPath, workingDir);
    }
  }

  /** Execute ripgrep as a subprocess using an args array (no shell injection risk). */
  private async runRipgrep(params: GrepParams, searchPath: string): Promise<ToolResult> {
    const args: string[] = [];

    if (params.case_insensitive) args.push('-i');
    if (params.context > 0) args.push('-C', String(params.context));
    if (params.glob) args.push('--glob', params.glob);

    switch (params.output_mode) {
      case 'files_with_matches':
        args.push('-l');
        break;
      case 'count':
        args.push('-c');
        break;
      // 'content' is the default — no flag needed.
    }

    if (params.output_mode === 'content') {
      args.push('--line-number', '--no-heading');
    }

    args.push('--', params.pattern, searchPath);

    let stdout: string;
    try {
      const { stdout: out } = await execFileAsync('rg', args, {
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = out;
    } catch (error: unknown) {
      const execError = error as { code?: number; stdout?: string };
      // rg exits with code 1 when no matches found — not an error.
      if (execError.code === 1) {
        return { content: 'No matches found.', isError: false };
      }
      // Code 127 means command not found — trigger Node.js fallback.
      throw error;
    }

    const trimmed = stdout.trim();
    if (!trimmed) return { content: 'No matches found.', isError: false };

    return {
      content: capOutput(trimmed, 'grep'),
      isError: false,
    };
  }

  /** Pure Node.js fallback when ripgrep is not available. */
  private runNodeGrep(params: GrepParams, searchPath: string, workingDir: string): ToolResult {
    const flags = params.case_insensitive ? 'gi' : 'g';
    let regex: RegExp;
    try {
      regex = new RegExp(params.pattern, flags);
    } catch {
      return { content: `Invalid regex pattern: ${params.pattern}`, isError: true };
    }

    const files = this.collectFiles(searchPath, params.glob);
    const matchingFiles: string[] = [];
    const contentLines: string[] = [];

    for (const file of files) {
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      let fileHasMatch = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        regex.lastIndex = 0;
        if (regex.test(line)) {
          fileHasMatch = true;
          if (params.output_mode === 'content') {
            const relPath = path.relative(workingDir, file);
            contentLines.push(`${relPath}:${String(i + 1)}:${line}`);
          }
        }
      }

      if (fileHasMatch) matchingFiles.push(file);
    }

    if (params.output_mode === 'files_with_matches') {
      if (matchingFiles.length === 0) return { content: 'No matches found.', isError: false };
      const relative = matchingFiles.map((f) => path.relative(workingDir, f)).join('\n');
      return { content: capOutput(relative, 'grep'), isError: false };
    }

    if (params.output_mode === 'count') {
      if (matchingFiles.length === 0) return { content: 'No matches found.', isError: false };
      const counts = matchingFiles
        .map((f) => {
          const content = fs.readFileSync(f, 'utf-8');
          const lines = content.split('\n');
          let count = 0;
          for (const line of lines) {
            regex.lastIndex = 0;
            if (regex.test(line)) count++;
          }
          return `${path.relative(workingDir, f)}: ${String(count)}`;
        })
        .join('\n');
      return { content: capOutput(counts, 'grep'), isError: false };
    }

    if (contentLines.length === 0) return { content: 'No matches found.', isError: false };
    return {
      content: capOutput(contentLines.join('\n'), 'grep'),
      isError: false,
    };
  }

  /** Recursively collect all files under a directory, optionally filtered by extension. */
  private collectFiles(searchPath: string, globPattern?: string): string[] {
    const files: string[] = [];
    const stat = fs.statSync(searchPath, { throwIfNoEntry: false });
    if (!stat) return files;
    if (stat.isFile()) return [searchPath];

    const entries = fs.readdirSync(searchPath, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const parentPath = (entry as { parentPath?: string }).parentPath ?? searchPath;
      const fullPath = path.join(parentPath, entry.name);
      if (globPattern) {
        // Simple extension filter for the Node.js fallback.
        const ext = globPattern.replace(/^\*\./, '.');
        if (!entry.name.endsWith(ext)) continue;
      }
      files.push(fullPath);
    }
    return files;
  }
}
