/**
 * Provider factory.
 *
 * Every adapter is imported lazily: selecting Anthropic must not load OpenAI's
 * code, and a missing optional SDK should surface as an actionable message at
 * selection time rather than a module-resolution crash at startup.
 */
import { resolveHost, resolveKey } from './credentials.js';
import { providerInfo } from './registry.js';
import type { ModelInfo, Provider, ProviderId } from './types.js';
import { ProviderError } from './types.js';

export interface CreateOptions {
  /** Overrides the resolved credential — used by the onboarding flow to test a
   *  key the user just typed, before it is written anywhere. */
  apiKey?: string;
  host?: string;
}

export async function createProvider(
  providerId: ProviderId,
  model: ModelInfo,
  opts: CreateOptions = {},
): Promise<Provider> {
  switch (providerId) {
    case 'anthropic': {
      const { AnthropicProvider } = await import('./anthropic.js');
      // May be undefined on purpose: the SDK also resolves ANTHROPIC_API_KEY,
      // ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile on its own.
      return new AnthropicProvider(model, opts.apiKey ?? resolveKey('anthropic'));
    }
    case 'openai': {
      const { OpenAIProvider } = await import('./openai.js');
      const key = opts.apiKey ?? resolveKey('openai');
      if (!key) throw missingKey('openai');
      return new OpenAIProvider(model, key);
    }
    case 'google': {
      const { GoogleProvider } = await import('./google.js');
      const key = opts.apiKey ?? resolveKey('google');
      if (!key) throw missingKey('google');
      return new GoogleProvider(model, key);
    }
    case 'ollama': {
      const { OllamaProvider, DEFAULT_OLLAMA_HOST } = await import('./ollama.js');
      return new OllamaProvider(model, opts.host ?? resolveHost('ollama') ?? DEFAULT_OLLAMA_HOST);
    }
    default: {
      const exhaustive: never = providerId;
      throw new Error(`Unhandled provider: ${String(exhaustive)}`);
    }
  }
}

function missingKey(providerId: ProviderId): ProviderError {
  const info = providerInfo(providerId);
  return new ProviderError(
    providerId,
    `No API key for ${info.label}. Run \`shakeout model\` to set one, or export ${info.envVar}.`,
    { isAuth: true },
  );
}

/** A throwaway model handle for calls that only need the credential, e.g. listModels. */
export function probeModel(providerId: ProviderId): ModelInfo {
  return { id: '', label: '', provider: providerId, toolUse: 'native' };
}

export * from './types.js';
export { PROVIDERS, providerInfo, selectableModels } from './registry.js';
