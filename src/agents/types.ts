import { z } from 'zod';

/**
 * Zod schema for validating a parsed agent definition.
 *
 * name        — Kebab-case machine identifier.
 * description — One-line summary shown in /agent list.
 * model       — Optional Claude model override for all turns while active.
 * tools       — Optional allowlist; undefined = all tools, [] = no tools.
 * systemPrompt— Full persona text injected as the final system prompt section.
 */
export const AgentDefinitionSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9-]+$/,
      'Agent name must be kebab-case (lowercase letters, digits, hyphens)',
    ),
  description: z.string().min(1),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  systemPrompt: z.string().min(1),
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/** Where the agent definition was discovered. */
export type AgentSource = 'built-in' | 'user-global' | 'project-local';

export interface LoadedAgent {
  readonly definition: AgentDefinition;
  readonly source: AgentSource;
  /** Absolute path for file-based sources; undefined for built-ins. */
  readonly filePath?: string;
}
