/**
 * OpenAI adapter.
 *
 * Uses the REST endpoints directly rather than the SDK: connection and model
 * listing need two plain GETs, and avoiding the dependency keeps the install
 * small for people who never select this provider.
 */
import type { ModelInfo, Provider, TurnRequest, TurnResult } from './types.js';
import { NotImplementedError, ProviderError } from './types.js';

const BASE = 'https://api.openai.com/v1';

/**
 * The model list is mostly things that cannot drive an agent — embeddings,
 * speech, image, moderation. Offering them would guarantee a confusing first
 * run, so they are filtered out by id. This is a heuristic over a list that
 * changes: it errs toward hiding a usable model rather than offering a broken
 * one, and the manual-entry path exists for anything it wrongly excludes.
 */
const NON_CHAT = /embed|tts|whisper|dall-e|moderation|audio|image|realtime|transcribe|search|codex/i;

export class OpenAIProvider implements Provider {
  readonly id = 'openai' as const;

  constructor(
    readonly model: ModelInfo,
    private readonly apiKey: string,
  ) {}

  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: signal ?? null,
      });
    } catch (err) {
      throw new ProviderError('openai', `Could not reach api.openai.com: ${String(err)}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError('openai', 'API key rejected.', { isAuth: true });
    }
    if (!res.ok) {
      throw new ProviderError('openai', `HTTP ${res.status} from ${path}`);
    }
    return res.json();
  }

  async verify(signal?: AbortSignal): Promise<void> {
    await this.get('/models', signal);
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const body = (await this.get('/models', signal)) as { data?: { id: string }[] };
    return (body.data ?? [])
      .filter((m) => !NON_CHAT.test(m.id))
      .map((m) => ({ id: m.id, label: m.id, provider: 'openai' as const, toolUse: 'native' as const }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async turn(_request: TurnRequest): Promise<TurnResult> {
    throw new NotImplementedError('openai', 'turn()');
  }
}
