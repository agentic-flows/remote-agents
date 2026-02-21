import { describe, it, expect, vi } from 'vitest';
import { executeToolWithDefinition } from './execute-tool';
import type { ToolDefinition } from './types';

describe('executeToolWithDefinition', () => {
  it('calls implementation and returns result', async () => {
    const tool: ToolDefinition<{ x: number }, number> = {
      type: 'function',
      function: { name: 'double', description: 'Doubles a number', parameters: {} },
      implementation: async (args) => args.x * 2,
    };

    const result = await executeToolWithDefinition(tool, { x: 5 });
    expect(result).toBe(10);
  });

  it('calls onStart before implementation', async () => {
    const order: string[] = [];

    const tool: ToolDefinition<{ x: number }, number> = {
      type: 'function',
      function: { name: 'test', description: '', parameters: {} },
      onStart: () => { order.push('onStart'); },
      implementation: async (args) => {
        order.push('implementation');
        return args.x;
      },
    };

    await executeToolWithDefinition(tool, { x: 1 });
    expect(order).toEqual(['onStart', 'implementation']);
  });

  it('calls onComplete after implementation with args and result', async () => {
    const onComplete = vi.fn();

    const tool: ToolDefinition<{ msg: string }, string> = {
      type: 'function',
      function: { name: 'echo', description: '', parameters: {} },
      implementation: async (args) => `echo: ${args.msg}`,
      onComplete,
    };

    await executeToolWithDefinition(tool, { msg: 'hello' });

    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith({ msg: 'hello' }, 'echo: hello');
  });

  it('calls onStart, implementation, onComplete in order', async () => {
    const order: string[] = [];

    const tool: ToolDefinition<void, string> = {
      type: 'function',
      function: { name: 'seq', description: '', parameters: {} },
      onStart: () => { order.push('start'); },
      implementation: async () => {
        order.push('impl');
        return 'done';
      },
      onComplete: () => { order.push('complete'); },
    };

    await executeToolWithDefinition(tool, undefined as void);
    expect(order).toEqual(['start', 'impl', 'complete']);
  });

  it('works without onStart and onComplete hooks', async () => {
    const tool: ToolDefinition<void, string> = {
      type: 'function',
      function: { name: 'bare', description: '', parameters: {} },
      implementation: async () => 'ok',
    };

    const result = await executeToolWithDefinition(tool, undefined as void);
    expect(result).toBe('ok');
  });

  it('propagates implementation errors', async () => {
    const tool: ToolDefinition<void, never> = {
      type: 'function',
      function: { name: 'fail', description: '', parameters: {} },
      implementation: async () => { throw new Error('boom'); },
    };

    await expect(executeToolWithDefinition(tool, undefined as void)).rejects.toThrow('boom');
  });
});
