import * as readline from 'node:readline';
import { parseArgs } from './args.js';
import { InputBuffer } from './InputBuffer.js';
import { ConfigManager } from '../config/ConfigManager.js';
import { ConversationController } from '../conversation/ConversationController.js';
import { OutputRenderer } from '../output/OutputRenderer.js';
import { UsageTracker } from '../output/UsageTracker.js';
import { Logger } from '../logger/Logger.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Print a concise session summary to stdout.
 * Called on Ctrl+D. /exit routes through SlashCommandEngine (Phase 3).
 */
function printUsageSummary(usage: UsageTracker): void {
  const { turnCount, totalInputTokens, totalOutputTokens } = usage.summary();
  process.stdout.write(
    `\nSession ended.\n` +
      `  Turns: ${turnCount}\n` +
      `  Tokens used: ${totalInputTokens} in / ${totalOutputTokens} out\n`,
  );
}

/**
 * Read all of stdin to a string (used for piped/headless mode, F13).
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  // ── 1. Parse CLI arguments ────────────────────────────────────────────────
  let args;
  try {
    args = parseArgs();
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  // ── 2. Bootstrap services ─────────────────────────────────────────────────
  let controller: ConversationController;
  let usage: UsageTracker;
  let renderer: OutputRenderer;

  try {
    const config = ConfigManager.load({
      apiKey: args.apiKey,
      model: args.model,
      permissionMode: args.permissionMode,
      workingDirectory: args.workingDirectory,
      debug: args.debug,
      color: args.noColor ? false : undefined,
      agent: args.agent,
      apiUrl: args.apiUrl,
    });

    Logger.getInstance(config.debug).info('Session started', {
      model: config.model,
      workingDirectory: config.workingDirectory,
    });

    usage = new UsageTracker();
    renderer = new OutputRenderer(config.debug, config.color);
    controller = new ConversationController(config, renderer, usage);
  } catch (error) {
    process.stderr.write(
      `Startup failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }

  // ── 3. Headless / piped mode (F13) ────────────────────────────────────────
  let headlessPrompt: string | undefined;

  if (args.prompt !== undefined) {
    headlessPrompt = args.prompt;
  } else if (!process.stdin.isTTY) {
    try {
      headlessPrompt = await readStdin();
    } catch (err) {
      process.stderr.write(`Failed to read stdin: ${String(err)}\n`);
      process.exit(1);
    }
  }

  if (headlessPrompt !== undefined) {
    try {
      await controller.handleInput(headlessPrompt);
    } catch (error) {
      process.stderr.write(
        `Error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    }
    process.exit(0);
  }

  // ── 4. Interactive REPL (F1) ──────────────────────────────────────────────
  renderer.printWelcome(args.agent ?? 'default');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  let buffer = new InputBuffer();

  const prompt = (): void => {
    rl.setPrompt(buffer.isCollecting ? '... ' : '> ');
    rl.prompt();
  };

  // Ctrl+C — abort in-flight stream, do NOT exit (F1 spec).
  rl.on('SIGINT', () => {
    controller.abort();
    process.stdout.write('\n(aborted)\n');
    prompt();
  });

  // Ctrl+D / EOF — print summary then exit.
  rl.on('close', () => {
    printUsageSummary(usage);
    process.exit(0);
  });

  rl.on('error', (err: Error) => {
    process.stderr.write(`Readline error: ${err.message}\n`);
    process.exit(1);
  });

  rl.on('line', async (line: string) => {
    rl.pause();

    const result = buffer.feed(line);
    buffer = result.next;

    if (result.value === null) {
      // Still in paste mode — show continuation prompt.
      rl.resume();
      prompt();
      return;
    }

    const input = result.value.trim();

    if (input.length === 0) {
      rl.resume();
      prompt();
      return;
    }

    // All slash commands (including /exit) route through ConversationController →
    // SlashCommandEngine (Phase 3). For Phase 1, /clear is handled inline here.
    if (input === '/clear') {
      controller.reset();
      renderer.printInfo('Context cleared.');
      rl.resume();
      prompt();
      return;
    }

    try {
      await controller.handleInput(input);
    } catch (error) {
      // Per-turn errors keep the session alive.
      renderer.printError(error instanceof Error ? error.message : String(error));
    }

    rl.resume();
    prompt();
  });

  prompt();
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${String(err)}\n`);
  process.exit(1);
});
