/**
 * Config Types for voice agent inference
 */

import type { ReasoningEffort } from "openai/resources.mjs";

export const ModelSize = {
  LITE: "lite",
  REGULAR: "regular",
  LARGE: "large",
} as const;

export type ModelSize = (typeof ModelSize)[keyof typeof ModelSize];

export interface AIModelConfig {
  name: string;
  size: ModelSize;
  provider: string;
  creditCost: number;
  contextSize: number;
  nonReasoning?: boolean;
  directOverride?: boolean;
  /** Cost per million input tokens in USD */
  inputCostPerMillion?: number;
  /** Cost per million output tokens in USD */
  outputCostPerMillion?: number;
}

// Model master list - common models for voice agents
const MODELS_MASTER = {
  DISABLED: {
    id: "disabled",
    config: {
      name: "Disabled",
      size: ModelSize.LITE,
      provider: "None",
      creditCost: 0,
      contextSize: 0,
    },
  },

  // --- OpenAI Models ---
  GPT_4O: {
    id: "openai/gpt-4o",
    config: {
      name: "GPT-4o",
      size: ModelSize.LARGE,
      provider: "openai",
      creditCost: 5,
      contextSize: 128000,
    },
  },
  GPT_4O_MINI: {
    id: "openai/gpt-4o-mini",
    config: {
      name: "GPT-4o Mini",
      size: ModelSize.LITE,
      provider: "openai",
      creditCost: 1,
      contextSize: 128000,
      inputCostPerMillion: 0.15,
      outputCostPerMillion: 0.60,
    },
  },
  GPT_4_1_NANO: {
    id: "openai/gpt-4.1-nano",
    config: {
      name: "GPT-4.1 Nano",
      size: ModelSize.LITE,
      provider: "openai",
      creditCost: 0.5,
      contextSize: 1047576,
      inputCostPerMillion: 0.10,
      outputCostPerMillion: 0.40,
      nonReasoning: true,
    },
  },
  GPT_4_1_MINI: {
    id: "openai/gpt-4.1-mini",
    config: {
      name: "GPT-4.1 Mini",
      size: ModelSize.LITE,
      provider: "openai",
      creditCost: 1,
      contextSize: 1047576,
      inputCostPerMillion: 0.40,
      outputCostPerMillion: 1.60,
      nonReasoning: true,
    },
  },

  // --- Anthropic Models ---
  CLAUDE_4_SONNET: {
    id: "anthropic/claude-sonnet-4-20250514",
    config: {
      name: "Claude 4 Sonnet",
      size: ModelSize.LARGE,
      provider: "anthropic",
      creditCost: 12,
      contextSize: 200000,
    },
  },
  CLAUDE_4_5_HAIKU: {
    id: "anthropic/claude-haiku-4-5",
    config: {
      name: "Claude 4.5 Haiku",
      size: ModelSize.REGULAR,
      provider: "anthropic",
      creditCost: 4,
      contextSize: 200000,
    },
  },

  // --- Google Models ---
  GEMINI_2_5_PRO: {
    id: "google-ai-studio/gemini-2.5-pro",
    config: {
      name: "Gemini 2.5 Pro",
      size: ModelSize.LARGE,
      provider: "google-ai-studio",
      creditCost: 5,
      contextSize: 1048576,
    },
  },
  GEMINI_2_5_FLASH: {
    id: "google-ai-studio/gemini-2.5-flash",
    config: {
      name: "Gemini 2.5 Flash",
      size: ModelSize.REGULAR,
      provider: "google-ai-studio",
      creditCost: 1.2,
      contextSize: 1048576,
    },
  },
} as const;

/**
 * Generated AIModels object
 */
export const AIModels = Object.fromEntries(
  Object.entries(MODELS_MASTER).map(([key, value]) => [key, value.id]),
) as { [K in keyof typeof MODELS_MASTER]: (typeof MODELS_MASTER)[K]["id"] };

export type AIModels = (typeof AIModels)[keyof typeof AIModels];

/**
 * Configuration map for all AI Models.
 */
export const AI_MODEL_CONFIG: Record<AIModels, AIModelConfig> = Object.fromEntries(
  Object.values(MODELS_MASTER).map((entry) => [entry.id, entry.config]),
) as Record<AIModels, AIModelConfig>;

/**
 * All available models list
 */
export const AllModels: AIModels[] = Object.values(MODELS_MASTER).map((entry) => entry.id);

/**
 * Model config for a specific action
 */
export interface ModelConfig {
  name: AIModels | string;
  reasoning_effort?: ReasoningEffort;
  max_tokens?: number;
  temperature?: number;
  fallbackModel?: AIModels | string;
}

/**
 * Agent action keys
 */
export type AgentActionKey = "conversationalResponse" | "scheduling" | "toolExecution";

/**
 * Agent config type
 */
export type AgentConfig = Record<AgentActionKey, ModelConfig>;

/**
 * Inference metadata
 */
export interface InferenceMetadata {
  agentId: string;
  userId: string;
}

/**
 * Inference context
 */
export interface InferenceContext extends InferenceMetadata {
  userModelConfigs?: Record<AgentActionKey, ModelConfig>;
  abortSignal?: AbortSignal;
}

/**
 * Check if a value is a valid AI model
 */
export function isValidAIModel(value: string): value is AIModels {
  return Object.values(AIModels).includes(value as AIModels);
}

/**
 * Convert string to AI model if valid
 */
export function toAIModel(value: string | null | undefined): AIModels | undefined {
  if (!value) {
    return undefined;
  }

  return isValidAIModel(value) ? value : undefined;
}
