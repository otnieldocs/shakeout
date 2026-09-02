/**
 * Google (Gemini) adapter — REST, for the same reasons as the OpenAI one.
 */
import type { ModelInfo, Provider, TurnRequest, TurnResult } from './types.js';
import { NotImplementedError, ProviderError } from './types.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiModel {
  name: string;
  displayName?: string;
  inputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

export class GoogleProvider implements Provider {
  readonly id = 'google' as const;

  constructor(
    readonly model: ModelInfo,
    private readonly apiKey: string,
  ) {}

  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
      // The key goes in a header rather than the query string so it cannot end
      // up in a proxy or server access log.
      res = await fetch(`${BASE}${path}`, {
        headers: { 'x-goog-api-key': this.apiKey },
        signal: signal ?? null,
      });
    } catch (err) {
      throw new ProviderError('google', `Could not reach generativelanguage.googleapis.com: ${String(err)}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError('google', 'API key rejected.', { isAuth: true });
    }
    if (!res.ok) throw new ProviderError('google', `HTTP ${res.status} from ${path}`);
    return res.json();
  }

  async verify(signal?: AbortSignal): Promise<void> {
    await this.get('/models', signal);
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const body = (await this.get('/models', signal)) as { models?: GeminiModel[] };
    return (body.models ?? [])
      // Only generateContent models can run an agent; the list also contains
      // embedding and token-counting endpoints.
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => ({
        id: m.name.replace(/^models\//, ''),
        label: m.displayName ?? m.name,
        provider: 'google' as const,
        contextWindow: m.inputTokenLimit,
        toolUse: 'native' as const,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async turn(_request: TurnRequest): Promise<TurnResult> {
    throw new NotImplementedError('google', 'turn()');
  }
}
