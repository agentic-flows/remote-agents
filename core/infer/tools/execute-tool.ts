/**
 * Tool execution helper with lifecycle hooks (onStart, onComplete).
 */

import type { ToolDefinition } from "./types";

/**
 * Execute a tool with its definition, calling lifecycle hooks.
 * Calls onStart before execution and onComplete after.
 */
export async function executeToolWithDefinition<TArgs, TResult>(
  toolDef: ToolDefinition<TArgs, TResult>,
  args: TArgs,
): Promise<TResult> {
  toolDef.onStart?.(args);
  const result = await toolDef.implementation(args);
  toolDef.onComplete?.(args, result);
  return result;
}
