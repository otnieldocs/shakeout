/**
 * Anthropic adapter.
 *
 * The SDK ships a Tool Runner that would drive the agent loop for us, but
 * Shakeout is multi-provider and the loop has to behave identically whichever
 * model is selected. So the loop lives above this file and every adapter
 * implements the same single-turn contract.
 */
import type {
  ConversationMessage,
  ModelInfo,
  Provider,
  TurnRequest,
  TurnResult,
  StopReason,
} from './types.js';
import { ProviderError } from './types.js';

/** Loaded lazily so a user on another provider never pays for this import. */
async function sdk(): Promise<typeof import('@anthropic-ai/sdk').default> {
  try {
    const mod = await import('@anthropic-ai/sdk');
    return mod.default;
  } catch {
    throw new ProviderError(
      'anthropic',
      'The @anthropic-ai/sdk package is not installed. Run: npm install @anthropic-ai/sdk',
    );
  }
}

function isAuthFailure(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 401 || status === 403;
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
      return 'end';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

/** Serialise neutral history into Anthropic's content-block format. */
function toMessages(messages: ConversationMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.text };

    if (m.role === 'tool_results') {
      return {
        role: 'user',
        content: m.results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      };
    }

    // Assistant turns must replay text and tool_use blocks together, in order,
    // or the next request is rejected for referencing an unknown tool_use_id.
    const content: unknown[] = [];
    if (m.text) content.push({ type: 'text', text: m.text });
    for (const call of m.toolCalls) {
      content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
    }
    return { role: 'assistant', content };
  });
}

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic' as const;

  constructor(
    readonly model: ModelInfo,
    private readonly apiKey?: string,
  ) {}

  private async client(): Promise<InstanceType<Awaited<ReturnType<typeof sdk>>>> {
    const Anthropic = await sdk();
    // A bare constructor also resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
    // or an `ant auth login` profile — so subscribers need no key at all.
    return this.apiKey ? new Anthropic({ apiKey: this.apiKey }) : new Anthropic();
  }

  async verify(signal?: AbortSignal): Promise<void> {
    const client = await this.client();
    try {
      await client.messages.create(
        {
          model: this.model.id,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal },
      );
    } catch (err) {
      throw new ProviderError('anthropic', describe(err), { isAuth: isAuthFailure(err) });
    }
  }

  /** Live model list, so the picker never offers an id that has been retired. */
  async listModels(): Promise<ModelInfo[]> {
    const client = await this.client();
    try {
      const out: ModelInfo[] = [];
      for await (const m of client.models.list()) {
        out.push({
          id: m.id,
          label: m.display_name ?? m.id,
          provider: 'anthropic',
          contextWindow: (m as { max_input_tokens?: number }).max_input_tokens,
          // Every Claude model in the current line-up does native tool use.
          toolUse: 'native',
        });
      }
      return out;
    } catch (err) {
      throw new ProviderError('anthropic', describe(err), { isAuth: isAuthFailure(err) });
    }
  }

  async turn(request: TurnRequest): Promise<TurnResult> {
    const client = await this.client();

    const tools = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));

    try {
      const stream = client.messages.stream(
        {
          model: this.model.id,
          // Streaming, so a generous ceiling costs nothing until it is used and
          // there is no HTTP timeout risk.
          max_tokens: request.maxTokens ?? 64_000,
          system: request.system,
          thinking: { type: 'adaptive', display: 'summarized' },
          tools,
          messages: toMessages(request.messages),
        } as never,
        { signal: request.signal },
      );

      if (request.onEvent) {
        stream.on('text', (delta: string) => request.onEvent?.({ type: 'text', text: delta }));
      }

      const message = await stream.finalMessage();

      let text = '';
      const toolCalls: TurnResult['toolCalls'] = [];
      for (const block of message.content) {
        if (block.type === 'text') text += block.text;
        if (block.type === 'tool_use') {
          const call = { id: block.id, name: block.name, input: block.input };
          toolCalls.push(call);
          request.onEvent?.({ type: 'tool_call', call });
        }
      }

      // A refusal arrives as HTTP 200 with stop_reason "refusal" — reading
      // content without checking would silently treat it as a normal turn.
      const stopReason = mapStopReason(message.stop_reason);
      if (stopReason === 'refusal') {
        const details = (message as { stop_details?: { explanation?: string } }).stop_details;
        text = details?.explanation ?? 'The model declined to continue with this request.';
      }

      return { text, toolCalls, stopReason };
    } catch (err) {
      throw new ProviderError('anthropic', describe(err), { isAuth: isAuthFailure(err) });
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
