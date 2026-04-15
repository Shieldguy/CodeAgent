import * as readline from 'node:readline';
import { parseArgs } from './args.js';
import { InputBuffer } from './InputBuffer.js';
import { ConfigManager } from '../config/ConfigManager.js';
import { ConversationController } from '../conversation/ConversationController.js';
import { SessionHistory } from '../conversation/SessionHistory.js';
import { OutputRenderer } from '../output/OutputRenderer.js';
import { UsageTracker } from '../output/UsageTracker.js';
import { Logger } from '../logger/Logger.js';
import { SlashCommandEngine } from '../commands/SlashCommandEngine.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function printUsageSummary(usage: UsageTracker): void {
  const { turnCount, totalInputTokens, totalOutputTokens } = usage.summary();
  process.stdout.write(
    `\nSession ended.\n` +
      `  Turns: ${String(turnCount)}\n` +
      `  Tokens used: ${String(totalInputTokens)} in / ${String(totalOutputTokens)} out\n`,
  );
}

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

    // Use static factory for async initialization (agents, git context, session history).
    controller = await ConversationController.create(config, renderer, usage);
  } catch (error) {
    process.stderr.write(
      `Startup failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }

  // ── 3. Resume previous session if requested ───────────────────────────────
  if (args.resume) {
    const lastSession = await SessionHistory.loadLast();
    if (lastSession === undefined) {
      process.stderr.write('No previous session found to resume.\n');
    } else {
      controller.restoreMessages(lastSession.messages);
      process.stdout.write(
        `Resumed session from ${lastSession.startedAt} ` +
          `(${String(lastSession.stats.turnCount)} turns, agent: ${lastSession.agent})\n`,
      );
    }
  }

  const engine = new SlashCommandEngine();

  // ── 4. Headless / piped mode ──────────────────────────────────────────────
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
    await controller.shutdown();
    process.exit(0);
  }

  // ── 5. Interactive REPL ───────────────────────────────────────────────────
  renderer.printWelcome(args.agent ?? 'default');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  // Share the REPL's readline with the permission guard so that destructive-tool
  // approval prompts don't open a second interface on stdin (which causes double-echo).
  controller.setPermissionAskFn(
    (question) => new Promise<string>((resolve) => rl.question(question, resolve)),
  );

  let buffer = new InputBuffer();

  const prompt = (): void => {
    rl.setPrompt(buffer.isCollecting ? '... ' : '> ');
    rl.prompt();
  };

  rl.on('SIGINT', () => {
    controller.abort();
    process.stdout.write('\n(aborted)\n');
    prompt();
  });

  rl.on('close', async () => {
    printUsageSummary(usage);
    await controller.shutdown();
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

    // Dispatch to slash command engine first.
    const ctx = controller.getCommandContext();
    const handled = await engine.execute(input, ctx).catch((err: unknown) => {
      renderer.printError(err instanceof Error ? err.message : String(err));
      return true;
    });

    if (!handled) {
      try {
        await controller.handleInput(input);
      } catch (error) {
        renderer.printError(error instanceof Error ? error.message : String(error));
      }
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
