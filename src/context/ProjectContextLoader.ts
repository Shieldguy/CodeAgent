import * as fs from 'node:fs';
import * as path from 'node:path';

const CLAUDE_MD_FILENAME = 'CLAUDE.md';
const MAX_CONTEXT_CHARS = 20_000;
const TRUNCATION_NOTICE =
  '\n\n[CLAUDE.md truncated: content exceeded 20,000 characters. ' +
  'Only the first 20,000 characters are included.]';

export interface ProjectContextResult {
  /** Content to inject into the system prompt. Empty string if not found. */
  content: string;
  /** Whether CLAUDE.md was found and readable. */
  found: boolean;
  /** Full path to the CLAUDE.md that was (or would be) read. */
  filePath: string;
  /** Whether content was truncated. */
  truncated: boolean;
}

/**
 * Load the CLAUDE.md project context file from the working directory.
 *
 * - If the file does not exist: returns empty content, no error.
 * - If the file is unreadable: returns empty content, no error.
 * - If content exceeds 20,000 chars: truncates with a notice.
 */
export async function loadProjectContext(workingDir: string): Promise<ProjectContextResult> {
  return loadProjectContextSync(workingDir);
}

/**
 * Synchronous variant — used inside the ConversationController constructor.
 */
export function loadProjectContextSync(workingDir: string): ProjectContextResult {
  const filePath = path.join(workingDir, CLAUDE_MD_FILENAME);

  if (!fs.existsSync(filePath)) {
    return { content: '', found: false, filePath, truncated: false };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { content: '', found: false, filePath, truncated: false };
  }

  if (raw.length <= MAX_CONTEXT_CHARS) {
    return { content: raw, found: true, filePath, truncated: false };
  }

  return {
    content: raw.slice(0, MAX_CONTEXT_CHARS) + TRUNCATION_NOTICE,
    found: true,
    filePath,
    truncated: true,
  };
}
