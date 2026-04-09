import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  ResolvedConfigSchema,
  PartialConfigSchema,
  type ResolvedConfig,
  type PartialConfig,
} from './types.js';
import {
  getUserConfigPath,
  getUserConfigDir,
  getProjectConfigPath,
} from './constants.js';
import { readEnvVars } from './envMapping.js';

/**
 * Subset of CLI flags that affect configuration.
 * `noColor` (from CliArgs) is inverted to `color` here.
 */
export interface ConfigCliArgs {
  apiKey?: string | undefined;
  model?: string | undefined;
  permissionMode?: string | undefined;
  /** false when --no-color is passed */
  color?: boolean | undefined;
  maxTokens?: number | undefined;
  workingDirectory?: string | undefined;
  debug?: boolean | undefined;
  agent?: string | undefined;
  apiUrl?: string | undefined;
}

export class ConfigManager {
  /**
   * Load and merge all configuration sources into a validated, frozen ResolvedConfig.
   *
   * Priority (highest → lowest):
   *   project-local .codeagent/config.json
   *   user-global   ~/.codeagent/config.json
   *   environment   ANTHROPIC_API_KEY, CODEAGENT_MODEL, …
   *   CLI flags     (lowest — one-off session overrides)
   *   schema defaults
   *
   * Throws with a descriptive message if the merged result fails validation
   * (most commonly: apiKey is missing).
   */
  static load(cliArgs: ConfigCliArgs = {}): ResolvedConfig {
    const envVars = readEnvVars();
    const userConfig = ConfigManager.readFile(getUserConfigPath());
    const projectConfig = ConfigManager.readFile(getProjectConfigPath());

    // Build a clean CLI-override object (strip undefined keys).
    const cliConfig: Record<string, unknown> = {};
    if (cliArgs.apiKey !== undefined) cliConfig['apiKey'] = cliArgs.apiKey;
    if (cliArgs.model !== undefined) cliConfig['model'] = cliArgs.model;
    if (cliArgs.permissionMode !== undefined) cliConfig['permissionMode'] = cliArgs.permissionMode;
    if (cliArgs.color !== undefined) cliConfig['color'] = cliArgs.color;
    if (cliArgs.maxTokens !== undefined) cliConfig['maxTokens'] = cliArgs.maxTokens;
    if (cliArgs.workingDirectory !== undefined)
      cliConfig['workingDirectory'] = cliArgs.workingDirectory;
    if (cliArgs.debug !== undefined) cliConfig['debug'] = cliArgs.debug;
    if (cliArgs.agent !== undefined) cliConfig['agent'] = cliArgs.agent;
    if (cliArgs.apiUrl !== undefined) cliConfig['apiUrl'] = cliArgs.apiUrl;

    // Merge: schema defaults ← env ← user ← project ← cli
    // Spread order: each layer overwrites only the keys it explicitly defines.
    const merged = {
      ...envVars,
      ...userConfig,
      ...projectConfig,
      ...cliConfig,
    };

    // Provide a clearer error before Zod fires its generic message.
    if (!merged['apiKey']) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set.\n' +
          'Set it via:\n' +
          '  export ANTHROPIC_API_KEY=sk-ant-...\n' +
          '  OR: codeagent config set apiKey sk-ant-...',
      );
    }

    const result = ResolvedConfigSchema.safeParse(merged);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(`Configuration error:\n${issues}`);
    }

    return Object.freeze(result.data);
  }

  /**
   * Persist a single key-value pair to the user-global config file.
   * Never writes to project-local config to avoid committing secrets.
   */
  static set(key: string, value: unknown): void {
    const existing = ConfigManager.readFile(getUserConfigPath());
    const updated = { ...existing, [key]: value };

    const validation = PartialConfigSchema.safeParse(updated);
    if (!validation.success) {
      const issues = validation.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(`Invalid config value for "${key}":\n${issues}`);
    }

    ConfigManager.ensureDir(getUserConfigDir());
    writeFileSync(getUserConfigPath(), JSON.stringify(validation.data, null, 2), {
      mode: 0o600,
      encoding: 'utf-8',
    });
  }

  /**
   * Read and parse a JSON config file.
   * Returns an empty object if the file does not exist (not an error).
   * Throws on read errors or invalid JSON / schema violations.
   */
  private static readFile(filePath: string): PartialConfig {
    if (!existsSync(filePath)) {
      return {};
    }

    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to read config file at ${filePath}: ${String(error)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Config file at ${filePath} contains invalid JSON`);
    }

    const result = PartialConfigSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(`Config file at ${filePath} has invalid fields:\n${issues}`);
    }

    return result.data;
  }

  /**
   * Create a directory with secure permissions if it does not already exist.
   */
  private static ensureDir(dirPath: string): void {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    }
  }
}
