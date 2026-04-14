import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';

/** Maximum combined character count for all git output fields. */
const GIT_OUTPUT_CAP = 3_000;

/** Maximum milliseconds to wait for any single git command. */
const GIT_TIMEOUT_MS = 3_000;

export interface GitContext {
  /** Current branch name, e.g. "main", "feature/auth". */
  branch: string;
  /** Output of `git status --short`. Empty string = clean working tree. */
  status: string;
  /** Output of `git diff --stat HEAD`. Empty if no changes since last commit. */
  diffStat: string;
}

/**
 * Check whether the given directory is inside a git repository.
 * Walks up the directory tree looking for a `.git` entry — no subprocess.
 */
export function isGitRepo(workingDir: string): boolean {
  let dir = path.resolve(workingDir);
  const root = path.parse(dir).root;

  while (dir !== root) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return false;
}

/**
 * Collect the current git state for the system prompt.
 *
 * Returns null if the directory is not a git repo, git is not installed,
 * any command times out, or any unexpected error occurs.
 * All failures are silent — git context is informational only.
 */
export async function loadGitContext(workingDir: string): Promise<GitContext | null> {
  if (!isGitRepo(workingDir)) return null;

  try {
    const [branch, status, diffStat] = await Promise.all([
      runGit('branch --show-current', workingDir),
      runGit('status --short', workingDir),
      runGit('diff --stat HEAD', workingDir),
    ]);

    return capCombinedOutput({ branch, status, diffStat });
  } catch {
    return null;
  }
}

/**
 * Cap the combined output of all three fields to GIT_OUTPUT_CAP chars.
 * Priority: branch (always kept in full), then status, then diffStat.
 */
function capCombinedOutput(raw: GitContext): GitContext {
  const branchTrimmed = raw.branch.trim();
  let remaining = GIT_OUTPUT_CAP - branchTrimmed.length;

  const statusTrimmed = raw.status.trim();
  const statusCapped =
    statusTrimmed.length <= remaining
      ? statusTrimmed
      : statusTrimmed.slice(0, remaining) + '\n[truncated]';
  remaining -= statusCapped.length;

  const diffStatTrimmed = raw.diffStat.trim();
  const diffStatCapped =
    diffStatTrimmed.length <= remaining
      ? diffStatTrimmed
      : diffStatTrimmed.slice(0, Math.max(0, remaining)) + '\n[truncated]';

  return { branch: branchTrimmed, status: statusCapped, diffStat: diffStatCapped };
}

/** Run a git subcommand with a timeout. Rejects on error or timeout. */
function runGit(subcommand: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = exec(
      `git ${subcommand}`,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 512 * 1024,
        env: {
          ...process.env,
          // Disable pager so git doesn't wait for user input.
          GIT_PAGER: 'cat',
          PAGER: 'cat',
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${subcommand} failed: ${stderr || String(error)}`));
          return;
        }
        resolve(stdout);
      },
    );

    child.on('error', reject);
  });
}
