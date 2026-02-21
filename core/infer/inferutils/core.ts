/**
 * Core inference functions for voice agents
 *
 * Simplified for conversational AI - no structured output, no schema formatting.
 * Uses OpenAI SDK directly with support for streaming and tool calling.
 */

import { OpenAI } from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageFunctionToolCall,
  ReasoningEffort,
} from "openai/resources.mjs";
import type { Stream } from "openai/streaming";
import { RateLimitExceededError, RateLimitType, SecurityError } from "./errors";
import { createLogger } from "./logger";
import type { CoreEnv } from "../../types";
import { stripImplementations } from "../tools/mcp-adapter";
import type { ToolCallResult, ToolDefinition } from "../tools/types";
import type { Message, MessageContent, MessageRole } from "./common";
import {
  type AgentActionKey,
  AI_MODEL_CONFIG,
  type AIModelConfig,
  type AIModels,
  type InferenceMetadata,
} from "./config.types";

const logger = createLogger("InferenceCore");

/**
 * Constants
 */
const MAX_LLM_MESSAGES = 100;
const MAX_TOOL_CALLING_DEPTH = 10;

function getMaxToolCallingDepth(_actionKey: AgentActionKey | "testModelConfig"): number {
  return MAX_TOOL_CALLING_DEPTH;
}

/**
 * Execute a tool with its definition
 */
async function executeToolWithDefinition<TArgs, TResult>(
  tool: ToolDefinition<TArgs, TResult>,
  args: TArgs,
): Promise<TResult> {
  if (tool.onStart) {
    tool.onStart(args);
  }
  const result = await tool.implementation(args);
  if (tool.onComplete) {
    tool.onComplete(args, result);
  }
  return result;
}

function optimizeInputs(messages: Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    content: optimizeMessageContent(message.content),
  }));
}

// Define a function-type tool call for internal use
interface FunctionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

// Streaming tool-call accumulation helpers
type ToolCallsArray = NonNullable<
  NonNullable<ChatCompletionChunk["choices"][number]["delta"]>["tool_calls"]
>;
type ToolCallDelta = ToolCallsArray[number];
type ToolAccumulatorEntry = FunctionToolCall & { index?: number; __order: number };

function synthIdForIndex(i: number): string {
  return `tool_${Date.now()}_${i}_${Math.random().toString(36).slice(2)}`;
}

function accumulateToolCallDelta(
  byIndex: Map<number, ToolAccumulatorEntry>,
  byId: Map<string, ToolAccumulatorEntry>,
  deltaToolCall: ToolCallDelta,
  orderCounterRef: { value: number },
): void {
  const idx = deltaToolCall.index;
  const idFromDelta = deltaToolCall.id;

  let entry: ToolAccumulatorEntry | undefined;

  // Look up existing entry by id or index
  if (idFromDelta && byId.has(idFromDelta)) {
    entry = byId.get(idFromDelta);
  } else if (idx !== undefined && byIndex.has(idx)) {
    entry = byIndex.get(idx);
  } else {
    // Create new entry
    const provisionalId = idFromDelta || synthIdForIndex(idx ?? byId.size);
    entry = {
      id: provisionalId,
      type: "function",
      function: {
        name: "",
        arguments: "",
      },
      __order: orderCounterRef.value++,
      ...(idx !== undefined ? { index: idx } : {}),
    };
    if (idx !== undefined) {
      byIndex.set(idx, entry);
    }
    byId.set(provisionalId, entry);
  }

  if (!entry) {
    return;
  }

  // Update id if provided and different
  if (idFromDelta && entry.id !== idFromDelta) {
    byId.delete(entry.id);
    entry.id = idFromDelta;
    byId.set(entry.id, entry);
  }

  // Register index if provided and not yet registered
  if (idx !== undefined && entry.index === undefined) {
    entry.index = idx;
    byIndex.set(idx, entry);
  }

  // Update function name - replace if provided
  if (deltaToolCall.function?.name) {
    entry.function.name = deltaToolCall.function.name;
  }

  // Append arguments - accumulate string chunks
  if (deltaToolCall.function?.arguments !== undefined) {
    const before = entry.function.arguments;
    const chunk = deltaToolCall.function.arguments;

    // Check if we already have complete JSON and this is extra data
    let isComplete = false;
    if (before.length > 0) {
      try {
        JSON.parse(before);
        isComplete = true;
      } catch {
        // Not complete yet, continue accumulating
      }
    }

    if (!isComplete) {
      entry.function.arguments += chunk;
    }
  }
}

function assembleToolCalls(
  byIndex: Map<number, ToolAccumulatorEntry>,
  byId: Map<string, ToolAccumulatorEntry>,
): FunctionToolCall[] {
  if (byIndex.size > 0) {
    return Array.from(byIndex.values())
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((e) => ({
        id: e.id,
        type: "function" as const,
        function: { name: e.function.name, arguments: e.function.arguments },
      }));
  }
  return Array.from(byId.values())
    .sort((a, b) => a.__order - b.__order)
    .map((e) => ({
      id: e.id,
      type: "function" as const,
      function: { name: e.function.name, arguments: e.function.arguments },
    }));
}

function optimizeMessageContent(content: MessageContent): MessageContent {
  if (!content) {
    return content;
  }
  // If content is an array (TextContent | ImageContent), only optimize text content
  if (Array.isArray(content)) {
    return content.map((item) =>
      item.type === "text" ? { ...item, text: optimizeTextContent(item.text) } : item,
    );
  }

  // If content is a string, optimize it directly
  return optimizeTextContent(content);
}

function optimizeTextContent(content: string): string {
  // CONSERVATIVE OPTIMIZATION - Only safe changes that preserve readability

  // 1. Remove trailing whitespace from lines (always safe)
  let result = content.replace(/[ \t]+$/gm, "");

  // 2. Reduce excessive empty lines (more than 3 consecutive) to 2 max
  result = result.replace(/\n\s*\n\s*\n\s*\n+/g, "\n\n\n");

  // 3. Remove leading/trailing whitespace from the entire content
  result = result.trim();

  return result;
}

/**
 * Get OpenAI client configuration for a model
 * Uses Cloudflare AI Gateway binding for faster edge routing
 */
async function getConfigurationForModel(
  modelConfig: AIModelConfig,
  env: CoreEnv,
  gatewayName?: string,
): Promise<{
  baseURL: string;
  apiKey: string;
  defaultHeaders?: Record<string, string>;
}> {
  // Use AI Gateway binding if available
  if (gatewayName && env.AI?.gateway) {
    const gateway = env.AI.gateway(gatewayName);
    switch (modelConfig.provider) {
      case "openai":
        return {
          baseURL: await gateway.getUrl("openai"),
          apiKey: env.OPENAI_API_KEY || "",
        };
      case "anthropic":
        return {
          baseURL: await gateway.getUrl("anthropic"),
          apiKey: env.ANTHROPIC_API_KEY || "",
        };
      default:
        return {
          baseURL: await gateway.getUrl("openai"),
          apiKey: env.OPENAI_API_KEY || "",
        };
    }
  }

  // Fallback to direct provider URLs
  switch (modelConfig.provider) {
    case "openai":
      return {
        baseURL: "https://api.openai.com/v1",
        apiKey: env.OPENAI_API_KEY || "",
      };
    case "anthropic":
      return {
        baseURL: "https://api.anthropic.com/v1/",
        apiKey: env.ANTHROPIC_API_KEY || "",
      };
    default:
      return {
        baseURL: "https://api.openai.com/v1",
        apiKey: env.OPENAI_API_KEY || "",
      };
  }
}

type InferArgsBase = {
  env: CoreEnv;
  metadata: InferenceMetadata;
  actionKey: AgentActionKey | "testModelConfig";
  messages: Message[];
  maxTokens?: number;
  modelName: AIModels | string;
  reasoning_effort?: ReasoningEffort;
  temperature?: number;
  stream?: {
    chunk_size: number;
    onChunk: (chunk: string) => void;
  };
  tools?: ToolDefinition[];
  abortSignal?: AbortSignal;
  /** AI Gateway name for edge routing (uses env.AI binding) */
  gatewayName?: string;
  /** Skip tool execution - return tool calls without executing them (for EagerEndOfTurn buffering) */
  skipToolExecution?: boolean;
};

export interface ToolCallContext {
  messages: Message[];
  depth: number;
}

export function serializeCallChain(context: ToolCallContext, finalResponse: string): string {
  // Build a transcript of the tool call messages, and append the final response
  let transcript =
    "**Request terminated by user, partial response transcript (last 5 messages):**\n\n<call_chain_transcript>";
  for (const message of context.messages.slice(-5)) {
    let content = message.content;

    // Truncate tool messages to 100 chars
    if (message.role === "tool" || message.role === "function") {
      content = (content || "").slice(0, 100);
    }

    transcript += `<message role="${message.role}">${content}</message>`;
  }
  transcript += `<final_response>${finalResponse || "**cancelled**"}</final_response>`;
  transcript += "</call_chain_transcript>";
  return transcript;
}

export class InferError extends Error {
  public response: string;
  public toolCallContext?: ToolCallContext;

  constructor(message: string, response: string, toolCallContext?: ToolCallContext) {
    super(message);
    this.name = "InferError";
    this.response = response;
    this.toolCallContext = toolCallContext;
  }

  partialResponseTranscript(): string {
    if (!this.toolCallContext) {
      return this.response;
    }
    return serializeCallChain(this.toolCallContext, this.response);
  }

  partialResponse(): InferResponseString {
    return {
      string: this.response,
      toolCallContext: this.toolCallContext,
    };
  }
}

export class AbortError extends InferError {
  constructor(response: string, toolCallContext?: ToolCallContext) {
    super(response, response, toolCallContext);
    this.name = "AbortError";
  }
}

export type InferResponseString = {
  string: string;
  toolCallContext?: ToolCallContext;
  /** Pending tool calls when skipToolExecution=true (for EagerEndOfTurn buffering) */
  pendingToolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /** AI Gateway log ID from the response (for cost tracking via binding) */
  gatewayLogId?: string;
};

/**
 * Execute all tool calls from OpenAI response
 */
async function executeToolCalls(
  openAiToolCalls: FunctionToolCall[],
  originalDefinitions: ToolDefinition[],
): Promise<ToolCallResult[]> {
  logger.info("Executing tool calls", {
    toolCallCount: openAiToolCalls.length,
    toolNames: openAiToolCalls.map((tc) => tc.function.name),
  });

  const toolDefinitions = new Map(originalDefinitions.map((td) => [td.function.name, td]));
  return Promise.all(
    openAiToolCalls.map(async (tc) => {
      try {
        const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        const td = toolDefinitions.get(tc.function.name);
        if (!td) {
          throw new Error(`Tool ${tc.function.name} not found`);
        }

        logger.debug("Executing tool", {
          toolName: tc.function.name,
          args,
        });

        const result = await executeToolWithDefinition(td, args);

        logger.debug("Tool execution complete", {
          toolName: tc.function.name,
          resultType: typeof result,
          result,
        });

        return {
          id: tc.id,
          name: tc.function.name,
          arguments: args,
          result,
        };
      } catch (error) {
        logger.error("Tool execution failed", {
          toolName: tc.function.name,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          id: tc.id,
          name: tc.function.name,
          arguments: {},
          result: {
            error: `Failed to execute ${tc.function.name}: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        };
      }
    }),
  );
}

/**
 * Perform an inference using OpenAI API
 * Supports streaming and tool calling.
 */
export async function infer(
  {
    env,
    metadata,
    messages,
    actionKey,
    maxTokens,
    modelName,
    stream,
    tools,
    reasoning_effort,
    temperature,
    abortSignal,
    gatewayName,
    skipToolExecution,
  }: InferArgsBase,
  toolCallContext?: ToolCallContext,
): Promise<InferResponseString> {
  if (messages.length > MAX_LLM_MESSAGES) {
    throw new RateLimitExceededError(
      `Message limit exceeded: ${messages.length} messages (max: ${MAX_LLM_MESSAGES}). Please use context compactification.`,
      RateLimitType.LLM_CALLS,
    );
  }

  // Check tool calling depth to prevent infinite recursion
  const currentDepth = toolCallContext?.depth ?? 0;
  if (currentDepth >= getMaxToolCallingDepth(actionKey)) {
    return {
      string: "[System: Maximum tool calling depth reached.]",
      toolCallContext,
    };
  }

  try {
    // Look up model config, with fallback for models not in the config (e.g., "gpt-4.1-nano" without prefix)
    let modelConfig = AI_MODEL_CONFIG[modelName as AIModels];
    
    // If not found, try with openai/ prefix
    if (!modelConfig && !modelName.includes('/')) {
      modelConfig = AI_MODEL_CONFIG[`openai/${modelName}` as AIModels];
    }
    
    // Final fallback: assume OpenAI provider
    if (!modelConfig) {
      modelConfig = {
        name: modelName,
        size: 'lite' as const,
        provider: 'openai',
        creditCost: 1,
        contextSize: 128000,
      };
    }

    const { apiKey, baseURL, defaultHeaders } = await getConfigurationForModel(modelConfig, env, gatewayName);

    // Remove [*.] from model name
    const cleanModelName = modelName.replace(/\[.*?\]/, "");

    // Extract just the model name without provider prefix for OpenAI API
    const apiModelName = cleanModelName.includes("/")
      ? cleanModelName.split("/").pop() || cleanModelName
      : cleanModelName;

    const client = new OpenAI({
      apiKey,
      baseURL: baseURL,
      defaultHeaders,
      logLevel: "debug",
      logger,
    });

    // Optimize messages to reduce token count
    const optimizedMessages = optimizeInputs(messages);

    const messagesToPass = [...optimizedMessages];
    if (toolCallContext?.messages) {
      // Exclude prior tool messages that have empty name
      const ctxMessages = toolCallContext.messages;
      const filteredCtx = ctxMessages.filter(
        (m) => m.role !== "tool" || (m.name && m.name.trim() !== ""),
      );
      messagesToPass.push(...filteredCtx);
    }

    // Strip implementation functions from tools - OpenAI only needs type + function definition
    const openAiTools = tools ? stripImplementations(tools) : undefined;
    const toolsOpts = openAiTools ? { tools: openAiTools, tool_choice: "auto" as const } : {};
    let response:
      | OpenAI.ChatCompletion
      | OpenAI.ChatCompletionChunk
      | Stream<OpenAI.ChatCompletionChunk>;
    let gatewayLogId: string | undefined;
    try {
      // Call OpenAI API via .withResponse() to capture raw headers (for AI Gateway log ID)
      const apiPromise = client.chat.completions.create(
        {
          ...toolsOpts,
          model: apiModelName,
          messages: messagesToPass as OpenAI.ChatCompletionMessageParam[],
          max_completion_tokens: maxTokens || 4096,
          stream: !!stream,
          reasoning_effort: modelConfig?.nonReasoning ? undefined : reasoning_effort,
          temperature,
        },
        {
          signal: abortSignal,
          headers: {
            "cf-aig-metadata": JSON.stringify({
              chatId: metadata.agentId,
              userId: metadata.userId,
              actionKey,
            }),
          },
        },
      );

      // Use .withResponse() to get both parsed data AND raw Response with headers
      const { data, response: rawResponse } = await apiPromise.withResponse();
      response = data as typeof response;

      // Extract AI Gateway log ID from response headers
      gatewayLogId = rawResponse?.headers?.get?.('cf-aig-log-id') || undefined;
      if (gatewayLogId) {
        logger.info("Captured gateway log ID", { gatewayLogId });
      }
    } catch (error) {
      // Check if error is due to abort
      if (
        error instanceof Error &&
        (error.name === "AbortError" ||
          error.message?.includes("aborted") ||
          error.message?.includes("abort"))
      ) {
        throw new AbortError("**User cancelled inference**", toolCallContext);
      }

      throw error;
    }
    let toolCalls: FunctionToolCall[] = [];

    let content = "";
    if (stream) {
      // If streaming is enabled, handle the stream response
      if (Symbol.asyncIterator in response) {
        let streamIndex = 0;
        // Accumulators for tool calls: by index (preferred) and by id (fallback when index is missing)
        const byIndex = new Map<number, ToolAccumulatorEntry>();
        const byId = new Map<string, ToolAccumulatorEntry>();
        const orderCounterRef = { value: 0 };

        for await (const event of response as Stream<ChatCompletionChunk>) {
          const delta = (event as ChatCompletionChunk).choices[0]?.delta;

          if (delta?.tool_calls) {
            try {
              for (const deltaToolCall of delta.tool_calls as ToolCallsArray) {
                accumulateToolCallDelta(byIndex, byId, deltaToolCall, orderCounterRef);
              }
            } catch {
              // Error processing tool calls in streaming
            }
          }

          // Process content
          content += delta?.content || "";
          const slice = content.slice(streamIndex);
          const finishReason = (event as ChatCompletionChunk).choices[0]?.finish_reason;
          if (slice.length >= stream.chunk_size || finishReason != null) {
            stream.onChunk(slice);
            streamIndex += slice.length;
          }
        }

        // Assemble toolCalls with preference for index ordering, else first-seen order
        const assembled = assembleToolCalls(byIndex, byId);
        toolCalls = assembled.filter((tc) => tc.function.name && tc.function.name.trim() !== "");
      } else {
        // Handle the case where stream was requested but a non-stream response was received
        // Properly extract both content and tool calls from non-stream response
        const completion = response as OpenAI.ChatCompletion;
        const message = completion.choices[0]?.message;
        if (message) {
          content = message.content || "";
          // Extract function tool calls only
          toolCalls = (message.tool_calls || [])
            .filter((tc): tc is ChatCompletionMessageFunctionToolCall => tc.type === "function")
            .map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            }));
        }
      }
    } else {
      // If not streaming, get the full response content (response is ChatCompletion)
      content = (response as OpenAI.ChatCompletion).choices[0]?.message?.content || "";
      const allToolCalls =
        (response as OpenAI.ChatCompletion).choices[0]?.message?.tool_calls || [];
      // Extract function tool calls only
      toolCalls = allToolCalls
        .filter((tc): tc is ChatCompletionMessageFunctionToolCall => tc.type === "function")
        .map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }))
        .filter((tc) => tc.function.name && tc.function.name.trim() !== "");
    }

    if (!content && !stream && !toolCalls.length) {
      return { string: "", toolCallContext, gatewayLogId };
    }

    // If skipToolExecution is true, return pending tool calls without executing them
    // This is used for EagerEndOfTurn buffering - tools should only execute on EndOfTurn
    if (skipToolExecution && toolCalls.length > 0) {
      logger.info("Skipping tool execution (EagerEndOfTurn mode)", {
        pendingToolCallCount: toolCalls.length,
        toolNames: toolCalls.map((tc) => tc.function.name),
      });
      return {
        string: content,
        toolCallContext,
        gatewayLogId,
        pendingToolCalls: toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })),
      };
    }

    let executedToolCalls: ToolCallResult[] = [];
    if (tools && toolCalls.length > 0) {
      executedToolCalls = await executeToolCalls(toolCalls, tools);
    }

    if (executedToolCalls.length) {
      logger.debug("Building tool messages for LLM", {
        executedToolCallCount: executedToolCalls.length,
        toolResults: executedToolCalls.map((tc) => ({
          name: tc.name,
          hasResult: !!tc.result,
          result: tc.result,
        })),
      });

      // Generate a new response with the tool calls executed
      const newMessages = [
        ...(toolCallContext?.messages || []),
        { role: "assistant" as MessageRole, content, tool_calls: toolCalls },
        ...executedToolCalls
          .filter((result) => result.name && result.name.trim() !== "")
          .map((result) => ({
            role: "tool" as MessageRole,
            content: result.result ? JSON.stringify(result.result) : "done",
            name: result.name,
            tool_call_id: result.id,
          })),
      ];

      const newDepth = (toolCallContext?.depth ?? 0) + 1;
      const newToolCallContext = {
        messages: newMessages,
        depth: newDepth,
      };

      const executedCallsWithResults = executedToolCalls.filter((result) => result.result);

      if (executedCallsWithResults.length) {
        const output = await infer(
          {
            env,
            metadata,
            messages,
            modelName,
            maxTokens,
            actionKey,
            stream,
            tools,
            reasoning_effort,
            temperature,
            abortSignal,
            gatewayName,
          },
          newToolCallContext,
        );
        return output;
      }

      return { string: content, toolCallContext: newToolCallContext, gatewayLogId };
    }

    return { string: content, toolCallContext, gatewayLogId };
  } catch (error) {
    if (error instanceof RateLimitExceededError || error instanceof SecurityError) {
      throw error;
    }
    throw error;
  }
}
