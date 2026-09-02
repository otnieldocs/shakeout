/**
 * Ollama adapter — a local daemon, so there is no API key and nothing leaves
 * the machine.
 */
import type { ModelInfo, Provider, TurnRequest, TurnResult } from './types.js';
import { NotImplementedError, ProviderError } from './types.js';

export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

export class OllamaProvider implements Provider {
  readonly id = 'ollama' as const;

  constructor(
    readonly model: ModelInfo,
    private readonly host: string = DEFAULT_OLLAMA_HOST,
  ) {}

  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.host.replace(/\/$/, '')}${path}`, { signal: signal ?? null });
    } catch (err) {
      throw new ProviderError(
        'ollama',
        `Could not reach the Ollama daemon at ${this.host}. Is it running? ` +
          `Start it with \`ollama serve\`, or set OLLAMA_HOST. (${String(err)})`,
      );
    }
    if (!res.ok) throw new ProviderError('ollama', `HTTP ${res.status} from ${path}`);
    return res.json();
  }

  async verify(signal?: AbortSignal): Promise<void> {
    await this.get('/api/tags', signal);
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const body = (await this.get('/api/tags', signal)) as { models?: { name: string }[] };
    return (body.models ?? [])
      .map((m) => ({
        id: m.name,
        label: m.name,
        provider: 'ollama' as const,
        // Deliberately 'limited' for every local model. Tool-calling quality
        // varies enormously between them, and a model that cannot hold a tool
        // chain produces an agent that spins with no explanation — which reads
        // as a bug in Shakeout rather than a limitation of the model chosen.
        toolUse: 'limited' as const,
        note: 'local — tool-calling quality varies by model',
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async turn(_request: TurnRequest): Promise<TurnResult> {
    throw new NotImplementedError('ollama', 'turn()');
  }
}
