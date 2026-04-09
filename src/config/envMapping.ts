/**
 * Maps environment variables to their ResolvedConfig equivalents.
 * Only includes keys that are explicitly set — absent vars produce no entry.
 */
export function readEnvVars(): Partial<Record<string, unknown>> {
  const result: Partial<Record<string, unknown>> = {};

  if (process.env['ANTHROPIC_API_KEY']) {
    result['apiKey'] = process.env['ANTHROPIC_API_KEY'];
  }
  if (process.env['CODEAGENT_MODEL']) {
    result['model'] = process.env['CODEAGENT_MODEL'];
  }
  if (process.env['CODEAGENT_PERMISSION_MODE']) {
    result['permissionMode'] = process.env['CODEAGENT_PERMISSION_MODE'];
  }
  if (process.env['CODEAGENT_DEBUG']) {
    result['debug'] =
      process.env['CODEAGENT_DEBUG'] === '1' || process.env['CODEAGENT_DEBUG'] === 'true';
  }
  if (process.env['CODEAGENT_MAX_TOKENS']) {
    result['maxTokens'] = Number(process.env['CODEAGENT_MAX_TOKENS']);
  }
  if (process.env['CODEAGENT_AGENT']) {
    result['agent'] = process.env['CODEAGENT_AGENT'];
  }
  if (process.env['CODEAGENT_API_URL']) {
    result['apiUrl'] = process.env['CODEAGENT_API_URL'];
  }

  return result;
}
