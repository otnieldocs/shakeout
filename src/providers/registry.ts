/**
 * Provider catalogue.
 *
 * Deliberately holds PROVIDERS, not a hardcoded list of every model. Model
 * line-ups change every few months; a baked-in list is wrong shortly after
 * release and then quietly offers ids that 404. So the picker asks for a
 * provider, takes the credential, and then fetches that provider's live model
 * list — one extra keystroke, and it is never stale.
 *
 * `fallbackModels` exists only for when the list endpoint is unreachable, so a
 * flaky network degrades to a usable default instead of a dead end.
 */
import type { ModelInfo, ProviderId } from './types.js';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Checked before prompting — an exported key means we never ask. */
  envVar?: string;
  needsKey: boolean;
  /** Shown at the credential prompt so people know what they are pasting. */
  keyHint?: string;
  docsUrl: string;
  /** Pre-selected in the model picker. */
  defaultModel: string;
  fallbackModels: ModelInfo[];
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'anthropic',
    label: 'Anthropic  (Claude)',
    envVar: 'ANTHROPIC_API_KEY',
    needsKey: true,
    keyHint: 'starts with sk-ant-',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-opus-5',
    fallbackModels: [
      { id: 'claude-opus-5', label: 'Claude Opus 5', provider: 'anthropic', contextWindow: 1_000_000, toolUse: 'native' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic', contextWindow: 1_000_000, toolUse: 'native' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic', contextWindow: 200_000, toolUse: 'native', note: 'fastest, cheapest' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    needsKey: true,
    keyHint: 'starts with sk-',
    docsUrl: 'https://platform.openai.com/api-keys',
    defaultModel: '',
    fallbackModels: [],
  },
  {
    id: 'google',
    label: 'Google  (Gemini)',
    envVar: 'GEMINI_API_KEY',
    needsKey: true,
    docsUrl: 'https://aistudio.google.com/apikey',
    defaultModel: '',
    fallbackModels: [],
  },
  {
    id: 'ollama',
    label: 'Ollama  (local)',
    envVar: 'OLLAMA_HOST',
    needsKey: false,
    docsUrl: 'https://ollama.com/download',
    defaultModel: '',
    fallbackModels: [],
  },
];

export function providerInfo(id: ProviderId): ProviderInfo {
  const found = PROVIDERS.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown provider "${id}"`);
  return found;
}

/**
 * Models that cannot drive the agent are filtered out entirely; `limited` ones
 * are kept but carry their warning into the picker. Embedding, moderation and
 * image models are the bulk of what a raw list endpoint returns, and offering
 * them would guarantee a confusing first run.
 */
export function selectableModels(models: ModelInfo[]): ModelInfo[] {
  return models.filter((m) => m.toolUse !== 'none');
}
