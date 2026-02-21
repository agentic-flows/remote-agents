/**
 * Core types for voice agent infrastructure
 */

// =============================================================================
// ENVIRONMENT (Base type - apps extend this)
// =============================================================================

/**
 * Base environment type for voice agents.
 * Applications should extend Cloudflare.Env (or use wrangler-generated types)
 * and include these required properties.
 * 
 * Note: We use 'interface' instead of extending Cloudflare.Env to avoid
 * type conflicts with wrangler's literal types (e.g., AI_GATEWAY_NAME: "phone-agent").
 */
export interface CoreEnv {
  // Cloudflare AI binding (required for STT/TTS, optional for chat-only)
  AI?: Ai;
  
  // Cloudflare credentials (required for AI Gateway, optional for chat-only)
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  
  // AI Gateway configuration
  LLM_MODEL?: string;
  AI_GATEWAY_NAME?: string;
  
  // API keys for AI providers
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  
  // Twilio credentials for call control
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_PHONE_NUMBER?: string;
  
  // Separate Twilio account for outbound calls (optional)
  TWILIO_OUTBOUND_SID?: string;
  TWILIO_OUTBOUND_TOKEN?: string;
  TWILIO_OUTBOUND_NUMBER?: string;
}

// =============================================================================
// CONVERSATION
// =============================================================================

/**
 * Message type for conversation history.
 * Uses AI SDK's ModelMessage format directly.
 */
export type Message = import('ai').ModelMessage;
