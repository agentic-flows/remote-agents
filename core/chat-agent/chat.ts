/**
 * ChatAgent — Reusable base class for text chat agents on Cloudflare Workers.
 *
 * Modeled after BaseAgent + LLMToolAgent from common-agents framework.
 * Uses the shared infer() function for LLM calls with tool-calling loop.
 * Manages conversation history in DO state via @callable RPC methods.
 *
 * Subclasses override:
 *   - getSystemPrompt()  — required
 *   - getTools()          — optional, return ToolDefinition[]
 *   - getModelName()      — optional, default gpt-4.1-nano
 *   - getGatewayName()    — optional, for AI Gateway routing
 */

import { Agent, type Connection, callable } from 'agents';
import type { CoreEnv } from '../types';
import type { Message } from '../infer/inferutils/common';
import type { AnyToolDefinition } from '../infer/tools/types';
import type { AIModels } from '../infer/inferutils/config.types';
import { infer } from '../infer/inferutils/core';

// =============================================================================
// TYPES
// =============================================================================

export interface ChatAgentState {
  tenantSlug: string | null;
  initialized: boolean;
  messageCount: number;
  lastActivity: string | null;
  history: Message[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ChatInput {
  message: string;
  token?: string;
}

// =============================================================================
// CHAT AGENT BASE CLASS
// =============================================================================

export abstract class ChatAgent<
  TEnv extends CoreEnv & Cloudflare.Env = CoreEnv & Cloudflare.Env,
  TState extends ChatAgentState = ChatAgentState,
> extends Agent<TEnv, TState> {

  initialState: TState = {
    tenantSlug: null,
    initialized: false,
    messageCount: 0,
    lastActivity: null,
    history: [],
  } as unknown as TState;

  // ===========================================================================
  // LIFECYCLE
  // ===========================================================================

  async onStart(): Promise<void> {
    const slug = this.name;
    if (!slug) return;
    this.setState({
      ...this.state,
      tenantSlug: slug,
      initialized: true,
    });
    this.log(`Started`);
  }

  onStateUpdate(_state: TState | undefined, _source: Connection | 'server'): void {
    // Override in subclasses if needed
  }

  // ===========================================================================
  // ABSTRACT / OPTIONAL HOOKS
  // ===========================================================================

  /** System prompt for the LLM. Required. */
  protected abstract getSystemPrompt(input: ChatInput): string;

  /** Tools available to the LLM. Override to provide tools. */
  protected getTools(_input: ChatInput): AnyToolDefinition[] | undefined {
    return undefined;
  }

  /** LLM model name. Override to change. */
  protected getModelName(): AIModels | string {
    return 'openai/gpt-4.1-nano';
  }

  /** AI Gateway name for edge routing. Override to enable. */
  protected getGatewayName(): string | undefined {
    return undefined;
  }

  /** Max tokens for LLM response. */
  protected getMaxTokens(): number {
    return 4096;
  }

  /** Temperature for LLM. */
  protected getTemperature(): number | undefined {
    return 0.3;
  }

  /** Max history messages to send to the LLM (to avoid token/message limits). */
  protected getMaxHistoryMessages(): number {
    return 80; // Leave room for system prompt + tool call expansion
  }

  /** Called before sending to LLM. Override for pre-processing (e.g., injecting context). */
  protected async onBeforeInfer(_input: ChatInput, messages: Message[]): Promise<Message[]> {
    return messages;
  }

  /** Called after LLM responds. Override for post-processing (e.g., logging, side effects). */
  protected async onAfterInfer(_input: ChatInput, _response: string): Promise<void> {}

  // ===========================================================================
  // @callable RPC METHODS
  // ===========================================================================

  @callable({ description: 'Send a chat message to the agent (streaming via WebSocket broadcast)' })
  async doChat(input: ChatInput): Promise<ChatMessage> {
    const message = typeof input === 'string' ? input : input.message;
    const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Run pre-inference hook FIRST so subclasses can load context (e.g. CMS data)
    // before we build the system prompt that depends on that context.
    const userMsg: Message = { role: 'user', content: message };
    const history = [...(this.state.history || [])];
    history.push(userMsg);

    // onBeforeInfer may load identity context, tools, etc.
    await this.onBeforeInfer(input, []);

    // NOW build the system prompt — after context is loaded
    const systemPrompt = this.getSystemPrompt(input);
    const tools = this.getTools(input);

    const systemMsg: Message = { role: 'system', content: systemPrompt };

    // Truncate history to avoid message limit errors (keep most recent messages)
    const maxHistory = this.getMaxHistoryMessages();
    const trimmedHistory = history.length > maxHistory
      ? history.slice(-maxHistory)
      : history;

    let messages: Message[] = [systemMsg, ...trimmedHistory];

    // Broadcast stream start so client can show typing indicator
    this.broadcast(JSON.stringify({
      type: 'chat:stream:start',
      id: msgId,
    }));

    // Call LLM via shared infer() with streaming — broadcast each chunk
    const result = await infer({
      env: this.env,
      metadata: {
        agentId: this.state.tenantSlug || this.name || 'chat',
        userId: 'chat-user',
      },
      actionKey: 'testModelConfig',
      messages,
      modelName: this.getModelName(),
      gatewayName: this.getGatewayName(),
      tools,
      maxTokens: this.getMaxTokens(),
      temperature: this.getTemperature(),
      stream: {
        chunk_size: 1, // Stream every token for smoothest UX
        onChunk: (chunk: string) => {
          this.broadcast(JSON.stringify({
            type: 'chat:stream:chunk',
            id: msgId,
            content: chunk,
          }));
        },
      },
    });

    const assistantContent = result.string || '';

    // Broadcast stream end with the final full content
    this.broadcast(JSON.stringify({
      type: 'chat:stream:end',
      id: msgId,
      content: assistantContent,
    }));

    // Build updated history including any tool call context messages
    const updatedHistory = [...history];
    if (result.toolCallContext?.messages) {
      for (const msg of result.toolCallContext.messages) {
        updatedHistory.push(msg);
      }
    }
    updatedHistory.push({ role: 'assistant', content: assistantContent });

    // Persist state
    this.setState({
      ...this.state,
      messageCount: (this.state.messageCount || 0) + 1,
      lastActivity: new Date().toISOString(),
      history: updatedHistory,
    });

    await this.onAfterInfer(input, assistantContent);

    return {
      id: msgId,
      role: 'assistant',
      content: assistantContent,
      timestamp: new Date().toISOString(),
    };
  }

  @callable({ description: 'Get conversation history' })
  getHistory(): ChatMessage[] {
    return (this.state.history || [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m, i) => ({
        id: `msg_${i}`,
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        timestamp: this.state.lastActivity || new Date().toISOString(),
      }));
  }

  @callable({ description: 'Clear conversation history' })
  clearHistory(): { cleared: true } {
    this.setState({ ...this.state, history: [], messageCount: 0 });
    return { cleared: true };
  }

  @callable({ description: 'Health check' })
  ping(): { ok: true; slug: string; messageCount: number; timestamp: string } {
    return {
      ok: true,
      slug: this.name || '',
      messageCount: this.state.messageCount || 0,
      timestamp: new Date().toISOString(),
    };
  }

  @callable({ description: 'Get agent state (without history)' })
  getStatus(): Omit<ChatAgentState, 'history'> {
    const { history: _history, ...rest } = this.state;
    return rest;
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  protected log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const prefix = `[${this.constructor.name}:${this.state.tenantSlug || this.name || '?'}]`;
    switch (level) {
      case 'warn': console.warn(prefix, message); break;
      case 'error': console.error(prefix, message); break;
      default: console.log(prefix, message);
    }
  }
}
