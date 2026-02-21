import type { ChatCompletionFunctionTool } from "openai/resources";

export interface MCPServerConfig {
  name: string;
  sseUrl: string;
}

export interface MCPResult {
  content: string;
}

export interface ErrorResult {
  error: string;
}

export interface ToolCallResult {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolImplementation<TArgs = any, TResult = unknown> = (
  args: TArgs,
) => Promise<TResult>;

export type ToolDefinition<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TArgs = any,
  TResult = unknown,
> = ChatCompletionFunctionTool & {
  implementation: ToolImplementation<TArgs, TResult>;
  onStart?: (args: TArgs) => void;
  onComplete?: (args: TArgs, result: TResult) => void;
};

// Non-generic alias for use in arrays and collections - uses 'any' to allow heterogeneous tool arrays
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;

export type ExtractToolArgs<T> = T extends ToolImplementation<infer A, unknown> ? A : never;

export type ExtractToolResult<T> = T extends ToolImplementation<unknown, infer R> ? R : never;
