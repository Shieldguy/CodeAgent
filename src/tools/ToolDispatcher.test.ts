import { describe, it, expect, vi } from 'vitest';
import { ToolDispatcher } from './ToolDispatcher.js';
import type { CodeAgentTool, ToolResult } from './types.js';
import type Anthropic from '@anthropic-ai/sdk';
import { MAX_TOOL_OUTPUT_CHARS } from './guards.js';

function makeTool(name: string, result: ToolResult = { content: 'ok', isError: false }): CodeAgentTool {
  return {
    definition: {
      name,
      description: `${name} tool`,
      input_schema: { type: 'object', properties: {}, required: [] },
    } as Anthropic.Tool,
    execute: vi.fn().mockResolvedValue(result),
  };
}

describe('ToolDispatcher', () => {
  describe('register() and dispatch()', () => {
    it('dispatches to a registered tool', async () => {
      const d = new ToolDispatcher();
      const tool = makeTool('read_file');
      d.register(tool);

      await d.dispatch('read_file', {}, '/tmp');

      expect(tool.execute).toHaveBeenCalledWith({}, '/tmp');
    });

    it('throws when registering a tool with a duplicate name', () => {
      const d = new ToolDispatcher();
      d.register(makeTool('bash'));
      expect(() => d.register(makeTool('bash'))).toThrow('already registered');
    });

    it('returns an error ToolResult for an unknown tool name', async () => {
      const d = new ToolDispatcher();
      const result = await d.dispatch('nonexistent', {}, '/tmp');
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Unknown tool');
    });

    it('caps output when the tool returns more than MAX_TOOL_OUTPUT_CHARS', async () => {
      const d = new ToolDispatcher();
      // Use 2x the limit so the truncated output is definitely shorter than the original.
      const huge = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS * 2);
      d.register(makeTool('big_tool', { content: huge, isError: false }));

      const result = await d.dispatch('big_tool', {}, '/tmp');

      expect(result.content.length).toBeLessThan(huge.length);
      expect(result.content).toContain('[Output truncated');
    });

    it('returns an error ToolResult when execute() throws', async () => {
      const d = new ToolDispatcher();
      const tool: CodeAgentTool = {
        definition: { name: 'thrower', description: '', input_schema: { type: 'object', properties: {}, required: [] } } as Anthropic.Tool,
        execute: vi.fn().mockRejectedValue(new Error('boom')),
      };
      d.register(tool);

      const result = await d.dispatch('thrower', {}, '/tmp');
      expect(result.isError).toBe(true);
      expect(result.content).toContain('boom');
    });
  });

  describe('allDefinitions()', () => {
    it('returns definitions for all registered tools', () => {
      const d = new ToolDispatcher();
      d.register(makeTool('tool_a'));
      d.register(makeTool('tool_b'));

      const defs = d.allDefinitions();
      expect(defs.map((t) => t.name).sort()).toEqual(['tool_a', 'tool_b']);
    });

    it('filters by allowlist when provided', () => {
      const d = new ToolDispatcher();
      d.register(makeTool('read_file'));
      d.register(makeTool('write_file'));
      d.register(makeTool('bash'));

      const defs = d.allDefinitions(new Set(['read_file', 'bash']));
      expect(defs.map((t) => t.name).sort()).toEqual(['bash', 'read_file']);
    });

    it('returns empty array when allowlist excludes all tools', () => {
      const d = new ToolDispatcher();
      d.register(makeTool('read_file'));

      const defs = d.allDefinitions(new Set(['nonexistent']));
      expect(defs).toHaveLength(0);
    });
  });

  describe('getTool()', () => {
    it('returns the registered tool by name', () => {
      const d = new ToolDispatcher();
      const tool = makeTool('read_file');
      d.register(tool);
      expect(d.getTool('read_file')).toBe(tool);
    });

    it('returns undefined for an unknown tool', () => {
      const d = new ToolDispatcher();
      expect(d.getTool('unknown')).toBeUndefined();
    });
  });

  describe('getDiffPreview()', () => {
    it('returns undefined for a tool without buildDiffPreview', async () => {
      const d = new ToolDispatcher();
      d.register(makeTool('read_file'));
      expect(await d.getDiffPreview('read_file', {}, '/tmp')).toBeUndefined();
    });

    it('returns undefined for an unknown tool', async () => {
      const d = new ToolDispatcher();
      expect(await d.getDiffPreview('nope', {}, '/tmp')).toBeUndefined();
    });

    it('calls buildDiffPreview on a DiffPreviewable tool', async () => {
      const d = new ToolDispatcher();
      const tool = {
        ...makeTool('write_file'),
        buildDiffPreview: vi.fn().mockResolvedValue('--- diff ---'),
      };
      d.register(tool);

      const result = await d.getDiffPreview('write_file', { path: 'x.ts', content: 'y' }, '/tmp');
      expect(result).toBe('--- diff ---');
    });
  });
});
