import * as path from 'node:path';

/** Maximum tool output size in characters. ~25K tokens at 4 chars/token. */
export const MAX_TOOL_OUTPUT_CHARS = 100_000;

/**
 * Cap a tool's raw output to MAX_TOOL_OUTPUT_CHARS.
 * Appends a truncation notice so the model knows the output was cut.
 *
 * @param raw - The full output string from the tool operation.
 * @param toolName - Used in the truncation message for context.
 */
export function capOutput(raw: string, toolName: string): string {
  if (raw.length <= MAX_TOOL_OUTPUT_CHARS) {
    return raw;
  }
  const truncated = raw.slice(0, MAX_TOOL_OUTPUT_CHARS);
  const notice =
    `\n\n[Output truncated: ${toolName} produced ${raw.length.toLocaleString()} characters. ` +
    `Only the first ${MAX_TOOL_OUTPUT_CHARS.toLocaleString()} characters are shown. ` +
    `Use more specific queries to see the rest.]`;
  return truncated + notice;
}

/**
 * Assert that `inputPath` resolves within `workingDir`.
 * Throws a user-friendly Error if the path escapes the working directory.
 *
 * Both paths are resolved to absolute before comparison so that symlinks
 * and `..` sequences cannot be used to escape.
 *
 * @param inputPath - The file path provided by the model.
 * @param workingDir - The session's working directory (already absolute).
 * @throws Error if the resolved path is outside workingDir.
 */
export function assertSafePath(inputPath: string, workingDir: string): void {
  const resolvedInput = path.resolve(workingDir, inputPath);
  const resolvedWorking = path.resolve(workingDir);

  // Add trailing separator to prevent false positives like:
  //   /app/src matching /app/src-extra
  const prefix = resolvedWorking.endsWith(path.sep)
    ? resolvedWorking
    : resolvedWorking + path.sep;

  if (!resolvedInput.startsWith(prefix) && resolvedInput !== resolvedWorking) {
    throw new Error(
      `Path traversal blocked: "${inputPath}" resolves to "${resolvedInput}", ` +
        `which is outside the working directory "${resolvedWorking}".`,
    );
  }
}
