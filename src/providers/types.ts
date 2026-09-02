/**
 * Provider abstraction.
 *
 * Shakeout is bring-your-own-key: the user picks a model, supplies their own
 * credential, and pays their own provider. Nothing is proxied through us.
 *
 * The agent loop lives ABOVE this interface, not inside it. Each provider only
 * has to answer one question — given a conversation and a set of tools, what
 * does the model say and which tools does it want called? Keeping the loop in
 * one place is what stops four providers drifting into four subtly different
 * agents.
 */

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'ollama';

/**
 * How well a model can call tools.
 *
 * This is a gate, not a preference. The entire agent is tool calls — navigate,
 * click, read the page. A model that cannot call tools reliably is not slower
 * or cheaper here, it is NON-FUNCTIONAL, and it fails in a way users read as a
 * bug in Shakeout. So the picker surfaces this rather than hiding it.
 */
export type ToolUseSupport =
  /** Reliable native tool calling. Safe to pick. */
  | 'native'
  /** Works, but degrades on long tool chains. Warned about at selection. */
  | 'limited'
  /** Cannot drive the agent at all. Never offered. */
  | 'none';

export interface ModelInfo {
  /** Provider-native model id, sent verbatim on the wire. */
  id: string;
  /** Shown in the picker. */
  label: string;
  provider: ProviderId;
  contextWindow?: number;
  toolUse: ToolUseSupport;
  /** One-line caveat shown beside the model in the picker. */
  note?: string;
}

/** A tool the agent may call. JSON Schema is the common denominator across every provider. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  /** Provider-issued id; must be echoed back with the result. */
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

/**
 * Provider-neutral conversation history. Each adapter serialises this into its
 * own wire format — Anthropic uses content blocks, OpenAI uses a `tool` role,
 * and the differences stay contained in the adapters.
 */
export type ConversationMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool_results'; results: ToolResult[] };

/** Streamed during a turn, so the TUI can render progress instead of a spinner. */
export type TurnEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; call: ToolCall };

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface TurnResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
}

export interface TurnRequest {
  system: string;
  messages: ConversationMessage[];
  tools: ToolDefinition[];
  maxTokens?: number;
  onEvent?: (event: TurnEvent) => void;
  signal?: AbortSignal;
}

export interface Provider {
  readonly id: ProviderId;
  readonly model: ModelInfo;

  /**
   * Cheapest possible round-trip that proves the credential works.
   *
   * Called BEFORE a key is written to disk. Saving an unverified key moves the
   * failure to the middle of a run, where a 401 looks like an agent defect
   * rather than a typo in an API key.
   */
  verify(signal?: AbortSignal): Promise<void>;

  /**
   * Live model list for this provider. Fetched rather than hardcoded so the
   * picker never offers an id that has since been retired.
   */
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;

  /** One model turn. The agent loop calls this repeatedly. */
  turn(request: TurnRequest): Promise<TurnResult>;
}

export class ProviderError extends Error {
  readonly provider: ProviderId;
  /** True when the credential is the problem, so the TUI can re-prompt. */
  readonly isAuth: boolean;

  constructor(provider: ProviderId, message: string, opts: { isAuth?: boolean } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.isAuth = opts.isAuth ?? false;
  }
}

/** Thrown by adapters whose turn() is not wired up yet. */
export class NotImplementedError extends Error {
  constructor(provider: ProviderId, what: string) {
    super(
      `${provider}: ${what} is not implemented yet. Anthropic is the only fully ` +
        `wired provider in this release — see README "Status".`,
    );
    this.name = 'NotImplementedError';
  }
}
