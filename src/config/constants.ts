import { homedir } from 'node:os';
import { join } from 'node:path';

// All paths are functions so they resolve at call time.
// This ensures vi.stubEnv('HOME', ...) in tests takes effect.

export function getUserConfigDir(): string {
  return join(homedir(), '.codeagent');
}
export function getUserConfigPath(): string {
  return join(getUserConfigDir(), 'config.json');
}

export function getProjectConfigDir(): string {
  return join(process.cwd(), '.codeagent');
}
export function getProjectConfigPath(): string {
  return join(getProjectConfigDir(), 'config.json');
}
