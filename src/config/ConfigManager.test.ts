import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from './ConfigManager.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Write a JSON config file, creating parent dirs as needed. */
function writeConfig(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('ConfigManager.load', () => {
  beforeEach(() => {
    // Wipe env vars that affect config so each test starts clean.
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('CODEAGENT_MODEL', '');
    vi.stubEnv('CODEAGENT_PERMISSION_MODE', '');
    vi.stubEnv('CODEAGENT_DEBUG', '');
    vi.stubEnv('CODEAGENT_MAX_TOKENS', '');
    vi.stubEnv('CODEAGENT_AGENT', '');
    // Point HOME to a temp dir so user config files are isolated.
    vi.stubEnv('HOME', os.tmpdir());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws when apiKey is missing from all sources', () => {
    expect(() => ConfigManager.load()).toThrow('ANTHROPIC_API_KEY');
  });

  it('reads apiKey from environment variable', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-env');
    const config = ConfigManager.load();
    expect(config.apiKey).toBe('sk-test-env');
  });

  it('CLI apiKey overrides env var', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-from-env');
    const config = ConfigManager.load({ apiKey: 'sk-from-cli' });
    expect(config.apiKey).toBe('sk-from-cli');
  });

  it('CLI model overrides env model', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('CODEAGENT_MODEL', 'claude-opus-4-6');
    const config = ConfigManager.load({ model: 'claude-haiku-4-5' });
    expect(config.model).toBe('claude-haiku-4-5');
  });

  it('applies schema defaults when fields are absent', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    const config = ConfigManager.load();
    expect(config.model).toBe('claude-sonnet-4-6');
    expect(config.permissionMode).toBe('default');
    expect(config.maxToolCalls).toBe(25);
    expect(config.maxOutputChars).toBe(100_000);
    expect(config.maxTokens).toBe(8192);
    expect(config.debug).toBe(false);
    expect(config.color).toBe(true);
    expect(config.agent).toBe('default');
  });

  it('returns a frozen object', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    const config = ConfigManager.load();
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('reads CODEAGENT_DEBUG=1 as true', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('CODEAGENT_DEBUG', '1');
    const config = ConfigManager.load();
    expect(config.debug).toBe(true);
  });

  it('reads CODEAGENT_DEBUG=true as true', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('CODEAGENT_DEBUG', 'true');
    const config = ConfigManager.load();
    expect(config.debug).toBe(true);
  });

  it('reads CODEAGENT_MAX_TOKENS from env', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('CODEAGENT_MAX_TOKENS', '4096');
    const config = ConfigManager.load();
    expect(config.maxTokens).toBe(4096);
  });

  it('user config file overrides env vars', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('CODEAGENT_MODEL', 'claude-haiku-4-5');

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-test-'));
    vi.stubEnv('HOME', tmpHome);
    writeConfig(path.join(tmpHome, '.codeagent', 'config.json'), {
      model: 'claude-opus-4-6',
    });

    try {
      const config = ConfigManager.load();
      expect(config.model).toBe('claude-opus-4-6');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('throws on invalid JSON in config file', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-test-'));
    vi.stubEnv('HOME', tmpHome);
    // API key must be present so the JSON-parse error is the first failure.
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');

    const configDir = path.join(tmpHome, '.codeagent');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), '{ bad json }', 'utf-8');

    try {
      expect(() => ConfigManager.load()).toThrow('invalid JSON');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('throws on invalid permissionMode value in config file', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-test-'));
    vi.stubEnv('HOME', tmpHome);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');

    writeConfig(path.join(tmpHome, '.codeagent', 'config.json'), {
      permissionMode: 'invalid-mode',
    });

    try {
      expect(() => ConfigManager.load()).toThrow('invalid fields');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe('ConfigManager.set', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-set-test-'));
    vi.stubEnv('HOME', tmpHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('creates ~/.codeagent/config.json with the given value', () => {
    ConfigManager.set('model', 'claude-opus-4-6');

    const written = JSON.parse(
      fs.readFileSync(path.join(tmpHome, '.codeagent', 'config.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(written['model']).toBe('claude-opus-4-6');
  });

  it('merges with existing values rather than overwriting', () => {
    ConfigManager.set('model', 'claude-opus-4-6');
    ConfigManager.set('debug', true);

    const written = JSON.parse(
      fs.readFileSync(path.join(tmpHome, '.codeagent', 'config.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(written['model']).toBe('claude-opus-4-6');
    expect(written['debug']).toBe(true);
  });

  it('throws when setting an invalid permissionMode', () => {
    expect(() => ConfigManager.set('permissionMode', 'yolo')).toThrow();
  });

  it('writes the config file with mode 0o600', () => {
    ConfigManager.set('model', 'claude-opus-4-6');
    const filePath = path.join(tmpHome, '.codeagent', 'config.json');
    const stat = fs.statSync(filePath);
    // 0o600 = 0b110000000 — only owner read/write
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
