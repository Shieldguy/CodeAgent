import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { capOutput } from './guards.js';
import type { CodeAgentTool, ToolResult } from './types.js';
import type Anthropic from '@anthropic-ai/sdk';

/**
 * Environment variable name prefixes that are stripped before spawning bash.
 * Any env var whose name starts with one of these strings (case-insensitive) is excluded.
 */
const BLOCKED_ENV_PREFIXES: ReadonlyArray<string> = [
  'ANTHROPIC_',
  'OPENAI_',
  'GEMINI_',
  'AWS_SECRET',
  'AWS_SESSION',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'STRIPE_',
  'TWILIO_',
  'SENDGRID_',
  'DATABASE_URL',
  'DB_PASSWORD',
  'REDIS_URL',
  'SECRET_',
  'API_KEY',
  'API_SECRET',
  'ACCESS_TOKEN',
  'REFRESH_TOKEN',
  'PRIVATE_KEY',
];

/**
 * Build a sanitized copy of process.env with blocked prefixes removed.
 * Never mutates process.env.
 */
export function safeEnv(): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upperKey = key.toUpperCase();
    const blocked = BLOCKED_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix));
    if (!blocked) {
      safe[key] = value;
    }
  }
  return safe;
}

/** Tracks all active bash subprocesses so they can be cleaned up on session exit. */
const activeProcesses = new Set<ChildProcess>();

/** Milliseconds to wait for SIGTERM before escalating to SIGKILL. */
const SIGKILL_GRACE_MS = 2_000;

// Register cleanup handler once at module load time.
process.on('exit', () => {
  for (const proc of activeProcesses) {
    try {
      proc.kill('SIGTERM');
    } catch {
      // Process may have already ended — ignore.
    }
  }
});

const BashParams = z.object({
  command: z.string().min(1, 'command must not be empty'),
  /** Timeout in milliseconds. Default: 30_000. Max: 300_000. */
  timeout_ms: z.number().int().positive().max(300_000).optional(),
});

type BashParams = z.infer<typeof BashParams>;

const DEFAULT_TIMEOUT_MS = 30_000;

export class BashTool implements CodeAgentTool {
  readonly definition: Anthropic.Tool = {
    name: 'bash',
    description:
      'Run a bash command in the working directory. ' +
      'Stdout and stderr are captured and returned. ' +
      'Commands run with sensitive environment variables removed. ' +
      'Long-running commands are killed after the timeout.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The bash command to run.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Timeout in milliseconds. Default: 30000. Max: 300000.',
        },
      },
      required: ['command'],
    },
  };

  async execute(input: Record<string, unknown>, workingDir: string): Promise<ToolResult> {
    let params: BashParams;
    try {
      params = BashParams.parse(input);
    } catch (error) {
      return {
        content: `Invalid parameters: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;

    return new Promise<ToolResult>((resolve) => {
      const proc = spawn('bash', ['-c', params.command], {
        cwd: workingDir,
        env: safeEnv(),
        detached: false,
      });

      activeProcesses.add(proc);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let killed = false;

      proc.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      // Timeout: SIGTERM → SIGKILL escalation.
      const timeoutHandle = setTimeout(() => {
        if (!killed) {
          killed = true;
          proc.kill('SIGTERM');

          const killHandle = setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch {
              // Already dead.
            }
          }, SIGKILL_GRACE_MS);

          killHandle.unref?.();
        }
      }, timeoutMs);

      proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timeoutHandle);
        activeProcesses.delete(proc);

        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');

        let output = '';
        if (stdout.length > 0) output += stdout;
        if (stderr.length > 0)
          output += (output.length > 0 ? '\n[stderr]\n' : '[stderr]\n') + stderr;
        if (output.length === 0) output = '(no output)';

        if (killed) {
          resolve({
            content: capOutput(`[Killed: timeout after ${String(timeoutMs)}ms]\n${output}`, 'bash'),
            isError: true,
          });
          return;
        }

        const exitInfo =
          signal !== null ? `[Killed by signal: ${signal}]` : `[Exit code: ${String(code)}]`;
        const isError = code !== 0 && signal === null;

        resolve({
          content: capOutput(`${exitInfo}\n${output}`, 'bash'),
          isError,
        });
      });

      proc.on('error', (err: Error) => {
        clearTimeout(timeoutHandle);
        activeProcesses.delete(proc);
        resolve({
          content: `Failed to spawn bash: ${err.message}`,
          isError: true,
        });
      });
    });
  }
}
