/**
 * Voice Agent Platform — Data Models
 *
 * Architecture:
 *   1. Payload CMS — auth only (JWT, roles). Admin UI is a client to Tenant DO API.
 *   2. Tenant Agent DO (singleton per tenant, keyed by slug) — owns ALL persistent
 *      data in its SQLite: agent configs, call records, transcripts, CRM contacts,
 *      business profile, outbound campaigns.
 *   3. Call DO (ephemeral per call, keyed by Twilio/SignalWire Call SID) — lives for
 *      call duration, holds the media stream WebSocket, runs STT/LLM/TTS pipeline.
 *      On call end, writes the record to Tenant DO SQLite and dies.
 *
 * Sources:
 *   - Asterisk-AI-Voice-Agent (mature voice platform config patterns)
 *   - Existing DREAM agent platform (CRM, chat, email, webhooks)
 *   - Cloudflare DO + Workers AI + AI Gateway architecture
 *
 * This file defines:
 *   A. Tenant DO SQLite row types (Drizzle ORM source of truth)
 *   B. Call DO ephemeral state (in-memory during call)
 *   C. API contract types (what Payload admin UI reads/writes)
 */

// =============================================================================
// A. TENANT DO SQLITE — ROW TYPES
// =============================================================================
// These map 1:1 to Drizzle ORM tables in the Tenant Agent DO's per-tenant SQLite.
// The Tenant DO is the single source of truth for all persistent platform data.

// ─── Agent Configs ──────────────────────────────────────────────────────────
// Each row is a fully self-contained voice agent definition.
// Phone number → agent config lookup is the primary routing mechanism.

export interface AgentConfigRow {
  id: number;
  name: string;
  business_name: string | null;

  // ── AI Personality ──
  greeting: string | null;
  system_prompt: string | null;
  instructions: string | null; // additional instructions appended to system prompt
  first_message_mode: string | null; // 'greeting' | 'listen' | 'custom'

  // ── LLM ──
  llm_provider: string | null; // 'ai_gateway' | 'openai' | 'anthropic' | 'google'
  llm_model: string | null; // 'openai/gpt-4.1-nano', 'anthropic/claude-haiku-4-5', etc.
  temperature: number | null;
  max_tokens: number | null;

  // ── Voice / TTS ──
  voice_provider: string | null; // 'cloudflare_aura' | 'elevenlabs' | 'openai' | 'deepgram'
  voice_id: string | null; // speaker name or voice ID
  language: string | null; // BCP-47 for TTS output

  // ── STT ──
  stt_provider: string | null; // 'cloudflare_flux' | 'deepgram' | 'openai_whisper' | 'groq'
  stt_language: string | null; // BCP-47 for recognition
  custom_keywords: string | null; // JSON string[] — boost recognition of domain terms

  // ── Speech Tuning ──
  wait_seconds_before_speaking: number | null; // delay after STT+TTS ready (default 0.4)
  num_words_to_interrupt: number | null; // words to trigger barge-in (default 2)
  interruption_voice_seconds: number | null; // caller speak time to confirm barge-in (default 0.2)
  backoff_seconds_after_interruption: number | null; // silence before agent resumes (default 1.0)
  backchanneling_enabled: number | null; // 0|1 — "mhm", "uh-huh" during caller speech
  silence_timeout: number | null; // seconds of silence before auto-prompt or hangup
  max_duration: number | null; // max call duration in seconds

  // ── Call Ending ──
  end_call_phrases: string | null; // JSON string[] — phrases that trigger hangup
  end_call_message: string | null; // farewell message before hangup

  // ── Tools ──
  tools: string | null; // JSON string[] — enabled tool names for this agent
  mcp_server_ids: string | null; // JSON number[] — FK refs to tenant_mcp_configs.id

  // ── Transfer Destinations (from Asterisk) ──
  transfer_destinations: string | null; // JSON TransferDestination[]
  // TransferDestination = { name: string, description: string, target: string, type: 'phone'|'sip'|'queue' }

  // ── Phone / Telephony ──
  phone_number: string | null; // E.164 — the number that routes to this agent
  enable_phone: number; // 0|1
  enable_chat: number; // 0|1
  telephony_provider: string | null; // 'twilio' | 'signalwire'
  twilio_account_sid: string | null; // per-agent subaccount (null = master)
  twilio_auth_token: string | null;

  // ── Voicemail / AMD (from Asterisk) ──
  voicemail_detection: string | null; // 'off' | 'on'
  voicemail_message: string | null;
  voicemail_action: string | null; // 'leave-message' | 'hang-up'
  amd_options: string | null; // JSON Record<string,unknown> — Twilio/SW AMD params

  // ── Recording & Compliance ──
  recording_enabled: number | null; // 0|1 (default 1)
  recording_consent_message: string | null;

  // ── Webhooks ──
  webhook_url: string | null;
  webhook_events: string | null; // JSON string[] — event names to fire
  webhook_secret: string | null; // HMAC-SHA256 signing secret

  // ── Status & Counters ──
  status: string; // 'active' | 'inactive' | 'draft'
  total_calls: number;
  total_emails: number;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Transfer Destination (parsed from agent_configs.transfer_destinations) ──

export interface TransferDestination {
  /** Logical name for this destination (e.g. "sales_team", "support"). */
  name: string;
  /** Human description — injected into LLM context so it knows when to transfer. */
  description: string;
  /** Phone number (E.164), SIP URI, or queue identifier. */
  target: string;
  type: 'phone' | 'sip' | 'queue';
}

// ─── Call Log ───────────────────────────────────────────────────────────────
// Written by Call DO → Tenant DO when a call ends.

export interface CallLogRow {
  id: number;
  agent_config_id: number | null;
  contact_id: number | null;
  direction: string; // 'inbound' | 'outbound'
  status: string; // 'in-progress' | 'completed' | 'failed' | 'transferred' | 'voicemail'

  // Timing
  duration_seconds: number | null;
  started_at: string | null;
  ended_at: string | null;

  // Content
  recording_url: string | null;
  transcript: string | null; // JSON ConversationTurn[]
  summary: string | null; // LLM-generated post-call summary
  sentiment: string | null; // 'positive' | 'neutral' | 'negative'
  outcome: string | null; // 'appointment_booked' | 'info_provided' | 'transferred' | etc.

  // Performance (from Asterisk call record patterns)
  avg_turn_latency_ms: number | null;
  max_turn_latency_ms: number | null;
  total_turns: number | null;
  barge_in_count: number | null;
  tool_calls: string | null; // JSON ToolCallRecord[]

  // Cost
  cost_breakdown: string | null; // JSON { stt, llm, tts, telephony, total }
  gateway_log_ids: string | null; // JSON string[] — AI Gateway log IDs for cost lookup

  // Telephony
  telephony_provider: string | null; // 'twilio' | 'signalwire'
  call_sid: string | null; // Twilio Call SID or SignalWire call ID
  telephony_account_sid: string | null;

  // Outbound campaign link
  campaign_id: number | null;
  lead_id: number | null;
  attempt_id: number | null;

  created_at: string;
}

// ─── Contacts (CRM) ────────────────────────────────────────────────────────

export interface ContactRow {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  lifecycle_stage: string | null; // 'lead' | 'customer' | 'opportunity' | 'churned'
  tags: string | null; // JSON string[]
  custom_fields: string | null; // JSON Record<string, unknown>
  source: string | null; // 'phone' | 'chat' | 'email' | 'web' | 'import'
  source_detail: string | null; // e.g. agent config name, campaign name
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Activities ─────────────────────────────────────────────────────────────

export interface ActivityRow {
  id: number;
  contact_id: number | null;
  type: string; // 'call' | 'email' | 'chat' | 'note' | 'quote' | 'transfer'
  description: string | null;
  call_log_id: number | null;
  quote_id: number | null;
  agent_config_id: number | null;
  metadata: string | null; // JSON Record<string, unknown>
  created_at: string;
}

// ─── Messages (multi-channel inbox) ─────────────────────────────────────────

export interface MessageRow {
  id: number;
  contact_id: number | null;
  channel: string; // 'email' | 'chat' | 'sms'
  direction: string; // 'inbound' | 'outbound'
  body: string | null;
  attachments: string | null; // JSON array
  thread_id: string | null;
  chat_id: string | null;
  is_read: number; // 0|1
  source_id: string | null;
  subject: string | null;
  from_address: string | null;
  to_address: string | null;
  created_at: string;
}

// ─── Quotes ─────────────────────────────────────────────────────────────────

export interface QuoteRow {
  id: number;
  contact_id: number | null;
  status: string; // 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired'
  items: string | null; // JSON array
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  notes: string | null;
  valid_until: string | null;
  custom_fields: string | null; // JSON Record<string, unknown> — replaces vehicle_* columns
  created_at: string;
  updated_at: string;
}

// ─── Chat Widget Configs ────────────────────────────────────────────────────

export interface ChatWidgetConfigRow {
  id: number;
  name: string;
  agent_name: string | null;
  system_prompt: string | null;
  llm_provider: string | null;
  llm_model: string | null;
  avatar_url: string | null;
  greeting: string | null;
  instructions: string | null;
  tools: string | null; // JSON string[]
  styling: string | null; // JSON { theme, colors, position, etc. }
  status: string; // 'active' | 'inactive'
  created_at: string;
  updated_at: string;
}

// ─── Tenant MCP Configs ─────────────────────────────────────────────────────

export interface TenantMcpConfigRow {
  id: number;
  name: string;
  url: string;
  transport: string | null; // 'sse' | 'stdio'
  headers: string | null; // JSON Record<string, string>
  auth_type: string | null;
  status: string; // 'connected' | 'disconnected' | 'error'
  connection_id: string | null;
  tool_count: number;
  tools: string | null; // JSON array of tool definitions
  last_error: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Workflows ──────────────────────────────────────────────────────────────

export interface WorkflowRow {
  id: number;
  name: string;
  trigger_type: string; // 'manual' | 'call_ended' | 'contact_created' | 'schedule'
  trigger_config: string | null; // JSON
  steps: string | null; // JSON array of workflow steps
  status: string; // 'active' | 'inactive'
  schedule_cron: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Email Routing ──────────────────────────────────────────────────────────

export interface EmailRoutingRow {
  id: number;
  vanity_address: string | null;
  forward_to: string | null;
  mode: string; // 'forward' | 'auto-reply' | 'both'
  auto_reply_enabled: number; // 0|1
  auto_reply_prompt: string | null;
  create_lead_on_receive: number; // 0|1
  active: number; // 0|1
  created_at: string;
  updated_at: string;
}

// ─── Outbound Campaigns (from Asterisk) ─────────────────────────────────────

export interface CampaignRow {
  id: number;
  name: string;
  status: string; // 'draft' | 'running' | 'paused' | 'stopped' | 'completed' | 'archived'

  // Scheduling
  timezone: string; // IANA e.g. 'America/Chicago'
  run_start_at_utc: string | null;
  run_end_at_utc: string | null;
  daily_window_start_local: string; // '09:00'
  daily_window_end_local: string; // '17:00'

  // Throttling
  max_concurrent: number; // 1–5 simultaneous calls
  min_interval_seconds: number; // between calls

  // AI config
  agent_config_id: number; // FK → agent_configs.id (which agent handles the call)
  caller_id_number: string | null; // outbound CLID override

  // Voicemail drop
  voicemail_drop_enabled: number; // 0|1
  voicemail_drop_mode: string | null; // 'tts' | 'upload'
  voicemail_drop_text: string | null;
  voicemail_drop_media_url: string | null;

  // Consent
  consent_enabled: number; // 0|1
  consent_media_url: string | null;
  consent_timeout_seconds: number;

  // AMD
  amd_options: string | null; // JSON — Twilio/SignalWire AMD passthrough params

  created_at: string;
  updated_at: string;
}

export interface LeadRow {
  id: number;
  campaign_id: number;
  name: string | null;
  phone_number: string; // E.164
  lead_timezone: string | null; // IANA override
  context_override: string | null; // agent_config override for this lead
  caller_id_override: string | null;
  custom_vars: string | null; // JSON Record<string, unknown> — injected into system prompt

  state: string; // 'pending'|'leased'|'dialing'|'amd_pending'|'in_progress'|'completed'|'failed'|'canceled'
  attempt_count: number;
  last_outcome: string | null;
  last_attempt_at_utc: string | null;
  leased_until_utc: string | null; // for atomic lease-based concurrency

  created_at: string;
  updated_at: string;
  // UNIQUE(campaign_id, phone_number)
}

export interface AttemptRow {
  id: number;
  campaign_id: number;
  lead_id: number;
  started_at_utc: string;
  ended_at_utc: string | null;
  duration_seconds: number | null;

  call_sid: string | null; // Twilio/SignalWire call ID
  outcome: string | null;
  amd_status: string | null; // 'human'|'machine_start'|'machine_end_beep'|'fax'|'unknown'
  amd_cause: string | null;
  consent_dtmf: string | null;
  consent_result: string | null;

  agent_config_id: number | null;
  call_log_id: number | null; // FK → call_log.id
  error_message: string | null;
}

// ─── Image Jobs ─────────────────────────────────────────────────────────────

export interface ImageJobRow {
  id: number;
  status: string; // 'pending' | 'completed' | 'failed'
  request: string | null; // JSON
  prompt: string | null;
  model: string | null;
  params: string | null; // JSON
  result_url: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

// =============================================================================
// B. CALL DO — EPHEMERAL STATE (in-memory during call)
// =============================================================================
// This is NOT persisted in SQLite. It lives in the Call DO's memory for the
// duration of a single phone call. When the call ends, relevant fields are
// written to CallLogRow in the Tenant DO.

/** Telephony provider type. */
export type TelephonyProvider = 'twilio' | 'signalwire';

/** Wire codec from the media stream. */
export type WireCodec = 'mulaw' | 'l16';

/** Resolved media format from the telephony provider's WebSocket `start` message. */
export interface TelephonyStream {
  provider: TelephonyProvider;
  streamSid: string;
  callSid: string;
  accountSid: string;
  inboundCodec: WireCodec;
  inboundSampleRate: 8000 | 16000 | 24000;
  outboundCodec: WireCodec;
  outboundSampleRate: 8000 | 16000 | 24000;
}

/** Conversation turn recorded during the call. */
export interface ConversationTurn {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/** Tool execution record captured during the call. */
export interface ToolCallRecord {
  name: string;
  params: Record<string, unknown>;
  result: unknown;
  timestamp: string;
  durationMs: number;
}

/**
 * Ephemeral state held by the Call DO during a live call.
 *
 * The Call DO (VoiceAgent subclass) manages most of this via class fields.
 * This interface documents the full shape for:
 *   - Serializing to Tenant DO on call end (→ CallLogRow)
 *   - Webhook payloads (call.started, call.ended events)
 *   - Real-time monitoring / admin dashboard
 */
export interface LiveCallState {
  // ── Identity ──
  callSid: string;
  tenantSlug: string;
  agentConfigId: number;
  contactId: number | null;
  callerNumber: string | null;
  callerName: string | null;
  calledNumber: string;
  direction: 'inbound' | 'outbound';

  // ── Telephony stream ──
  stream: TelephonyStream | null;

  // ── AI config (snapshot from agent_configs at call start) ──
  llmModel: string;
  voiceProvider: string | null;
  voiceId: string | null;

  // ── Conversation ──
  conversationHistory: ConversationTurn[];
  lastTranscript: string | null;
  lastAgentResponse: string | null;

  // ── TTS / echo cancellation ──
  isSpeaking: boolean;

  // ── Barge-in ──
  bargeInCount: number;
  lastBargeInTs: number;

  // ── Latency instrumentation ──
  turnLatenciesMs: number[];
  lastTurnLatencyMs: number;

  // ── Tool tracking ──
  toolCalls: ToolCallRecord[];

  // ── AI Gateway cost tracking ──
  gatewayLogIds: string[];

  // ── Outbound campaign (if applicable) ──
  isOutbound: boolean;
  campaignId: number | null;
  leadId: number | null;
  attemptId: number | null;
  outboundCustomVars: Record<string, unknown>;

  // ── Timing ──
  startTime: string;
  endTime: string | null;
}

// =============================================================================
// C. API CONTRACT — PAYLOAD ADMIN UI ↔ TENANT DO
// =============================================================================
// These types define what the Payload admin UI sends/receives when it calls
// the Tenant DO's HTTP action handler. The admin UI is purely a client.

/** POST /tenant/{slug}/agent-config-upsert */
export interface AgentConfigUpsert {
  id?: number; // omit for create, include for update
  name: string;
  greeting?: string | null;
  system_prompt?: string | null;
  instructions?: string | null;
  first_message_mode?: string | null;
  llm_provider?: string | null;
  llm_model?: string | null;
  temperature?: number | null;
  max_tokens?: number | null;
  voice_provider?: string | null;
  voice_id?: string | null;
  language?: string | null;
  stt_provider?: string | null;
  stt_language?: string | null;
  custom_keywords?: string[] | null;
  wait_seconds_before_speaking?: number | null;
  num_words_to_interrupt?: number | null;
  interruption_voice_seconds?: number | null;
  backoff_seconds_after_interruption?: number | null;
  backchanneling_enabled?: boolean;
  silence_timeout?: number | null;
  max_duration?: number | null;
  end_call_phrases?: string[] | null;
  end_call_message?: string | null;
  tools?: string[] | null;
  mcp_server_ids?: number[] | null;
  transfer_destinations?: TransferDestination[] | null;
  phone_number?: string | null;
  enable_phone?: boolean;
  enable_chat?: boolean;
  telephony_provider?: TelephonyProvider | null;
  twilio_account_sid?: string | null;
  twilio_auth_token?: string | null;
  voicemail_detection?: string | null;
  voicemail_message?: string | null;
  voicemail_action?: string | null;
  amd_options?: Record<string, unknown> | null;
  recording_enabled?: boolean;
  recording_consent_message?: string | null;
  webhook_url?: string | null;
  webhook_events?: string[] | null;
  webhook_secret?: string | null;
  status?: string;
}

/** POST /tenant/{slug}/campaign-upsert */
export interface CampaignUpsert {
  id?: number;
  name: string;
  timezone?: string;
  run_start_at_utc?: string | null;
  run_end_at_utc?: string | null;
  daily_window_start_local?: string;
  daily_window_end_local?: string;
  max_concurrent?: number;
  min_interval_seconds?: number;
  agent_config_id: number;
  caller_id_number?: string | null;
  voicemail_drop_enabled?: boolean;
  voicemail_drop_mode?: string | null;
  voicemail_drop_text?: string | null;
  voicemail_drop_media_url?: string | null;
  consent_enabled?: boolean;
  consent_media_url?: string | null;
  consent_timeout_seconds?: number;
  amd_options?: Record<string, unknown> | null;
  status?: string;
}

/** POST /tenant/{slug}/lead-import — bulk import */
export interface LeadImportItem {
  name?: string | null;
  phone_number: string; // E.164
  lead_timezone?: string | null;
  context_override?: string | null;
  caller_id_override?: string | null;
  custom_vars?: Record<string, unknown> | null;
}

/** GET /tenant/{slug}/dashboard-summary */
export interface DashboardSummary {
  contacts: number;
  callsTotal: number;
  callsInbound: number;
  callsOutbound: number;
  callsCompleted: number;
  avgCallDuration: number;
  messagesTotal: number;
  agentConfigs: number;
  activeCampaigns: number;
}

/** GET /tenant/{slug}/call-stats */
export interface CallStats {
  total: number;
  inbound: number;
  outbound: number;
  completed: number;
  avgDuration: number;
  avgTurnLatencyMs: number;
  totalBargeIns: number;
}

// =============================================================================
// D. HELPERS
// =============================================================================

/**
 * Parse the `start` WebSocket message from Twilio or SignalWire
 * into a normalized TelephonyStream.
 */
export function parseTelephonyStream(
  startMsg: {
    start: {
      streamSid: string;
      callSid: string;
      accountSid: string;
      mediaFormat?: {
        encoding: string;
        sampleRate: number;
        channels: number;
      };
    };
  },
  provider: TelephonyProvider,
): TelephonyStream {
  const { streamSid, callSid, accountSid, mediaFormat } = startMsg.start;

  if (provider === 'twilio') {
    return {
      provider,
      streamSid,
      callSid,
      accountSid,
      inboundCodec: 'mulaw',
      inboundSampleRate: 8000,
      outboundCodec: 'mulaw',
      outboundSampleRate: 8000,
    };
  }

  // SignalWire: supports PCMU@8k, L16@16k, L16@24k
  const isL16 = mediaFormat?.encoding === 'audio/x-L16';
  const sampleRate = (mediaFormat?.sampleRate ?? 8000) as 8000 | 16000 | 24000;

  return {
    provider,
    streamSid,
    callSid,
    accountSid,
    inboundCodec: isL16 ? 'l16' : 'mulaw',
    inboundSampleRate: sampleRate,
    outboundCodec: isL16 ? 'l16' : 'mulaw',
    outboundSampleRate: sampleRate,
  };
}

/**
 * Convert a LiveCallState to a partial CallLogRow for persistence.
 * Called by the Call DO when the call ends, before writing to Tenant DO.
 */
export function liveCallToCallLog(
  state: LiveCallState,
  outcome: string,
): Omit<CallLogRow, 'id' | 'created_at'> {
  const latencies = state.turnLatenciesMs;
  const avgLatency = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null;
  const maxLatency = latencies.length > 0
    ? Math.max(...latencies)
    : null;

  const durationMs = state.endTime && state.startTime
    ? new Date(state.endTime).getTime() - new Date(state.startTime).getTime()
    : null;

  return {
    agent_config_id: state.agentConfigId,
    contact_id: state.contactId,
    direction: state.direction,
    status: outcome,
    duration_seconds: durationMs !== null ? Math.round(durationMs / 1000) : null,
    started_at: state.startTime,
    ended_at: state.endTime,
    recording_url: null,
    transcript: JSON.stringify(state.conversationHistory),
    summary: null, // populated by post-call analysis
    sentiment: null,
    outcome,
    avg_turn_latency_ms: avgLatency,
    max_turn_latency_ms: maxLatency,
    total_turns: state.conversationHistory.filter(t => t.role === 'user').length,
    barge_in_count: state.bargeInCount,
    tool_calls: state.toolCalls.length > 0 ? JSON.stringify(state.toolCalls) : null,
    cost_breakdown: null, // populated after gateway cost lookup
    gateway_log_ids: state.gatewayLogIds.length > 0 ? JSON.stringify(state.gatewayLogIds) : null,
    telephony_provider: state.stream?.provider ?? null,
    call_sid: state.callSid,
    telephony_account_sid: state.stream?.accountSid ?? null,
    campaign_id: state.campaignId,
    lead_id: state.leadId,
    attempt_id: state.attemptId,
  };
}
