import { z } from 'zod';
import { createRequire } from 'node:module';

export interface CliArgs {
  apiKey?: string | undefined;
  model?: string | undefined;
  permissionMode?: 'auto' | 'default' | 'deny' | undefined;
  agent?: string | undefined;
  /** Set when --prompt / -p / bare positional provided. Enables headless mode. */
  prompt?: string | undefined;
  debug: boolean;
  /** True when --no-color is passed. */
  noColor: boolean;
  /** Working directory override. Default: process.cwd(). */
  workingDirectory?: string | undefined;
  /** Anthropic API base URL override. Default: SDK default (api.anthropic.com). */
  apiUrl?: string | undefined;
}

const PERMISSION_MODES = ['auto', 'default', 'deny'] as const;

const RawArgsSchema = z.object({
  apiKey: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  agent: z.string().optional(),
  prompt: z.string().optional(),
  debug: z.boolean(),
  noColor: z.boolean(),
  workingDirectory: z.string().optional(),
  apiUrl: z.string().optional(),
});

/**
 * Parse process.argv into a validated CliArgs object.
 * Throws with a user-friendly message on invalid input.
 *
 * Supported flags:
 *   --api-key <key>
 *   --model <name>
 *   --permission-mode auto|default|deny
 *   --agent <name>
 *   --prompt <text>   (or -p <text>)
 *   --debug
 *   --no-color
 *   --cwd <path>           (stored as workingDirectory in CliArgs)
 *   --api-url <url>        (Anthropic API base URL override)
 *   --version | -v         (prints version and exits)
 */
export function parseArgs(argv: string[] = process.argv.slice(2)): CliArgs {
  const raw: Record<string, unknown> = {
    debug: false,
    noColor: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case '--api-key':
        raw['apiKey'] = argv[++i];
        break;
      case '--model':
        raw['model'] = argv[++i];
        break;
      case '--permission-mode':
        raw['permissionMode'] = argv[++i];
        break;
      case '--agent':
        raw['agent'] = argv[++i];
        break;
      case '--prompt':
      case '-p':
        raw['prompt'] = argv[++i];
        break;
      case '--debug':
        raw['debug'] = true;
        break;
      case '--no-color':
        raw['noColor'] = true;
        break;
      case '--cwd':
        raw['workingDirectory'] = argv[++i];
        break;
      case '--api-url':
        raw['apiUrl'] = argv[++i];
        break;
      case '--version':
      case '-v': {
        const require = createRequire(import.meta.url);
        const pkg = require('../../package.json') as { version: string };
        process.stdout.write(`codeagent ${pkg.version}\n`);
        process.exit(0);
        break;
      }
      default:
        if (arg === undefined) break;
        if (!arg.startsWith('-') && raw['prompt'] === undefined) {
          // First bare positional → treat as the headless prompt shortcut.
          raw['prompt'] = arg;
        } else if (!arg.startsWith('-')) {
          throw new Error(
            `Unexpected argument: ${JSON.stringify(arg)}\nRun with --help for usage.`,
          );
        } else {
          throw new Error(
            `Unknown flag: ${JSON.stringify(arg)}\nRun with --help for usage.`,
          );
        }
    }
  }

  try {
    return RawArgsSchema.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid arguments: ${error instanceof Error ? error.message : String(error)}\n` +
        `Run with --help for usage.`,
    );
  }
}
