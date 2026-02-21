/**
 * MCP Tool Adapter
 *
 * Utility functions for converting tool formats between our internal
 * ToolDefinition format and OpenAI's expected format.
 */

import type { ToolDefinition } from "./types";

/**
 * OpenAI function tool format
 */
export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

/**
 * Strip implementation from ToolDefinitions for passing to OpenAI.
 * OpenAI only needs { type, function } - not our implementation details.
 */
export function stripImplementations(tools: ToolDefinition[]): OpenAITool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.function.name,
      description: t.function.description || "",
      parameters: (t.function.parameters as Record<string, unknown>) || {
        type: "object",
        properties: {},
        required: [],
      },
    },
  }));
}
