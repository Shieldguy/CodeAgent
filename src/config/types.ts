import { z } from 'zod';

export const PermissionModeSchema = z.enum(['auto', 'default', 'deny']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const ResolvedConfigSchema = z.object({
  // Required — session cannot start without this.
  apiKey: z.string().min(1, 'ANTHROPIC_API_KEY is required'),

  // Model selection.
  model: z.string().default('claude-sonnet-4-6'),

  // Permission mode for destructive tool calls.
  permissionMode: PermissionModeSchema.default('default'),

  // Enable ANSI color output.
  color: z.boolean().default(true),

  // Maximum output tokens per API response.
  maxTokens: z.number().int().positive().default(8192),

  // Working directory for all file/tool operations.
  workingDirectory: z.string().default(process.cwd()),

  // Enable debug logging to file.
  debug: z.boolean().default(false),

  // Maximum tool calls per agentic loop turn.
  maxToolCalls: z.number().int().positive().default(25),

  // Maximum characters in tool output before truncation.
  maxOutputChars: z.number().int().positive().default(100_000),

  // Initial agent name — resolved by AgentRegistry at startup.
  agent: z.string().default('default'),

  // Anthropic API base URL override. Unset = use the SDK default (api.anthropic.com).
  // Useful for proxies, local development servers, or testing against a custom endpoint.
  apiUrl: z.string().url().optional(),
});

export type ResolvedConfig = z.infer<typeof ResolvedConfigSchema>;

// Partial config as stored in JSON files — all fields optional, apiKey excluded
// from required status so it can be omitted from project-local configs.
export const PartialConfigSchema = ResolvedConfigSchema.partial().omit({ apiKey: true }).extend({
  apiKey: z.string().optional(),
});
export type PartialConfig = z.infer<typeof PartialConfigSchema>;
