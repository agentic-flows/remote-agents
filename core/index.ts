/**
 * @deepgram-phone-agent/core
 * 
 * Reusable voice agent infrastructure for Cloudflare Workers.
 * Uses Deepgram for STT/TTS, Cloudflare AI Gateway for LLM routing,
 * and Twilio for telephony.
 */

// =============================================================================
// AGENTS
// =============================================================================

export { ChatAgent, type ChatAgentState, type ChatMessage, type ChatInput } from './chat-agent/chat';
export { VoiceAgent, type VoiceAgentState, type VoiceTransportCallbacks } from './voice-agent/voice';

// =============================================================================
// INFERENCE
// =============================================================================

// Core inference
export {
  infer,
  AbortError,
  InferError,
  serializeCallChain,
  type ToolCallContext,
  type InferResponseString,
} from './infer/inferutils/core';

// Model configuration
export {
  AI_MODEL_CONFIG,
  AIModels,
  AllModels,
  ModelSize,
  isValidAIModel,
  toAIModel,
  type AIModelConfig,
  type AgentActionKey,
  type AgentConfig,
  type InferenceMetadata,
  type InferenceContext,
  type ModelConfig,
} from './infer/inferutils/config.types';

// Errors
export {
  SecurityError,
  SecurityErrorType,
  RateLimitExceededError,
  RateLimitType,
  type RateLimitErrorDetails,
} from './infer/inferutils/errors';

// Messages
export {
  type Message,
  type MessageRole,
  type MessageContent,
  type TextContent,
  type ImageContent,
  createUserMessage,
  createSystemMessage,
  createAssistantMessage,
  createMultiModalUserMessage,
} from './infer/inferutils/common';

// Logging
export {
  createLogger,
  Logger,
  StructuredLogger,
  LoggerFactory,
} from './infer/inferutils/logger';

export type { LogLevel, LoggerConfig, ObjectContext, LogEntry } from './infer/inferutils/types';

// =============================================================================
// STT / TTS
// =============================================================================

export {
  CloudflareFluxSTT,
  type FluxConfig,
  type FluxEventCallbacks,
  type FluxResponse,
  type FluxEventType,
  type FluxWord,
} from './infer/stt/cloudflare-flux';

export {
  CloudflareAuraTTS,
  type TTSConfig,
  type TTSEventCallbacks,
} from './infer/tts/cloudflare-aura';

// =============================================================================
// TOOLS
// =============================================================================

export {
  type ToolDefinition,
  type AnyToolDefinition,
  type ToolImplementation,
  type ToolCallResult,
  type ExtractToolArgs,
  type ExtractToolResult,
  type MCPServerConfig,
  type MCPResult,
  type ErrorResult,
} from './infer/tools/types';

export { stripImplementations, type OpenAITool } from './infer/tools/mcp-adapter';

export { executeToolWithDefinition } from './infer/tools/execute-tool';

export {
  MCPManager,
  type MCPServerRow,
  type MCPServerOptions,
  type MCPToolWithServer,
} from './infer/tools/mcp-manager';

// =============================================================================
// INTEGRATIONS
// =============================================================================

export {
  // Config & types
  type TwilioConfig,
  type TwilioCallResult,
  type TerminateCallResult,
  type ConferenceResult,
  type ParticipantResult,
  type OutboundCallConfig,
  type OutboundCallResult,
  
  // Call control
  terminateCall,
  updateCall,
  createCall,
  
  // Outbound call orchestration
  initiateOutboundCall,
  
  // Conference operations
  getConference,
  addParticipantToConference,
  updateParticipant,
  removeParticipant,
  endConference,
  
  // TwiML builders
  conferenceWithHoldTwiml,
  conferenceJoinTwiml,
  dialTwiml,
  voicemailTwiml,
  mediaStreamTwiml,
} from './integrations/twilio';

// =============================================================================
// UTILITIES
// =============================================================================

export {
  // Audio
  decodeMulaw,
  resample8kTo16k,
  base64ToUint8Array,
  uint8ArrayToBase64,
  twilioMulawToPcm16k,
  // Datetime
  toUtcISOString,
  // WebSocket
  dedupedConnect,
  type DedupedConnectionParams,
  // Metrics
  PipelineMetrics,
  TTSMetrics,
  type TTFBMetrics,
  type ProcessingMetrics,
  type TTFAMetrics,
} from './utils';

// =============================================================================
// TYPES
// =============================================================================

export type { CoreEnv } from './types';
