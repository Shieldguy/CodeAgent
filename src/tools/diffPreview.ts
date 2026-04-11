import { createPatch } from 'diff';

/**
 * Compute a unified diff string between two text versions of a file.
 * Returns a string with the unified diff header and hunks.
 * Returns an empty string if the content is identical.
 */
export function computeDiff(filePath: string, original: string, updated: string): string {
  return createPatch(filePath, original, updated, 'original', 'updated', { context: 3 });
}
