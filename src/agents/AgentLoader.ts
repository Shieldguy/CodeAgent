import * as fs from 'node:fs/promises';
import { AgentDefinitionSchema, type AgentDefinition } from './types.js';

/** Raw parsed frontmatter before zod validation. Values are strings or string arrays. */
interface RawFrontmatter {
  [key: string]: string | string[] | undefined;
}

interface ParseResult {
  frontmatter: RawFrontmatter;
  body: string;
}

/**
 * parseFrontmatter
 *
 * Parses YAML frontmatter from a raw file string without external dependencies.
 *
 * Supported YAML subset:
 *   - Simple scalar:  key: value
 *   - Quoted scalar:  key: "value with spaces"
 *   - List:           key:\n  - item1\n  - item2
 *
 * Throws a descriptive Error if:
 *   - The file does not start with "---"
 *   - No closing "---" is found
 */
export function parseFrontmatter(raw: string): ParseResult {
  const lines = raw.split('\n');

  if (lines[0]?.trimEnd() !== '---') {
    throw new Error(
      `Agent definition file must start with "---" on the first line. ` +
        `Got: ${JSON.stringify(lines[0])}`,
    );
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trimEnd() === '---') {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    throw new Error(
      'Agent definition file has an opening "---" but no closing "---". ' +
        'The frontmatter block was never terminated.',
    );
  }

  const frontmatterLines = lines.slice(1, closingIndex);
  const bodyLines = lines.slice(closingIndex + 1);
  const body = bodyLines.join('\n').trim();

  return { frontmatter: parseFrontmatterLines(frontmatterLines), body };
}

/**
 * Parses frontmatter lines into a RawFrontmatter object.
 *
 * Handles:
 *   "key: value"          → { key: "value" }
 *   'key: "quoted value"' → { key: "quoted value" }
 *   "key:\n  - a\n  - b"  → { key: ["a", "b"] }
 */
function parseFrontmatterLines(lines: string[]): RawFrontmatter {
  const result: RawFrontmatter = {};
  let currentListKey: string | null = null;

  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) {
      continue;
    }

    // List item: "  - value"
    const listItemMatch = line.match(/^\s+-\s+(.+)$/);
    if (listItemMatch !== null && currentListKey !== null) {
      const item = listItemMatch[1]?.trim() ?? '';
      const existing = result[currentListKey];
      result[currentListKey] = Array.isArray(existing) ? [...existing, item] : [item];
      continue;
    }

    // Key-value line: "key: value" or "key:"
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (kvMatch === null) {
      continue; // Unknown line format — skip silently
    }

    const key = kvMatch[1] ?? '';
    const rawValue = (kvMatch[2] ?? '').trim();

    if (rawValue === '') {
      // "key:" with no value — start of a list block
      currentListKey = key;
      result[key] = [];
    } else {
      currentListKey = null;
      // Strip optional surrounding quotes
      result[key] = rawValue.replace(/^["']|["']$/g, '');
    }
  }

  return result;
}

/**
 * fromFile
 *
 * Reads an agent definition .md file, parses frontmatter, validates with zod,
 * and returns an AgentDefinition.
 *
 * Throws a descriptive error if the file is unreadable, malformed, or invalid.
 */
export async function fromFile(filePath: string): Promise<AgentDefinition> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to read agent definition file "${filePath}": ${String(error)}`);
  }

  let parsed: ParseResult;
  try {
    parsed = parseFrontmatter(raw);
  } catch (error) {
    throw new Error(
      `Malformed frontmatter in agent definition file "${filePath}": ${String(error)}`,
    );
  }

  const rawDefinition = {
    name: parsed.frontmatter['name'],
    description: parsed.frontmatter['description'],
    model: parsed.frontmatter['model'],
    tools: parsed.frontmatter['tools'],
    systemPrompt: parsed.body,
  };

  const validation = AgentDefinitionSchema.safeParse(rawDefinition);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid agent definition in "${filePath}":\n${issues}`);
  }

  return validation.data;
}
