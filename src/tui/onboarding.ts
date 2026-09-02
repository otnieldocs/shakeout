/**
 * First-run flow: pick a provider, supply a credential, pick a model.
 *
 * Bring-your-own-key throughout — the credential goes to the provider and
 * nowhere else, and it is verified with a real call BEFORE being written. An
 * unverified key that gets saved turns a typo into a 401 halfway through a run,
 * where it reads as an agent defect rather than a setup mistake.
 */
import { password, select } from '@inquirer/prompts';
import {
  configDir,
  keyIsFromEnv,
  resolveKey,
  setHost,
  setKey,
  setSelection,
  getSelection,
} from '../providers/credentials.js';
import { createProvider, probeModel } from '../providers/index.js';
import { PROVIDERS, providerInfo, selectableModels } from '../providers/registry.js';
import type { ModelInfo, ProviderId } from '../providers/types.js';
import { ProviderError } from '../providers/types.js';

export interface Selection {
  provider: ProviderId;
  model: ModelInfo;
}

function fmtContext(tokens?: number): string {
  if (!tokens) return '';
  return tokens >= 1_000_000 ? `${Math.round(tokens / 1_000_000)}M context` : `${Math.round(tokens / 1000)}K context`;
}

async function pickProvider(): Promise<ProviderId> {
  return select<ProviderId>({
    message: 'Choose a provider',
    choices: PROVIDERS.map((p) => ({
      name: p.label,
      value: p.id,
      description: p.needsKey ? `API key required — ${p.docsUrl}` : 'runs locally, no API key',
    })),
  });
}

/**
 * Returns a verified credential. Loops until one works rather than failing out,
 * because a mistyped key is the single most likely thing to go wrong here.
 */
async function obtainCredential(providerId: ProviderId): Promise<{ apiKey?: string; host?: string }> {
  const info = providerInfo(providerId);

  if (!info.needsKey) {
    process.stdout.write(`  Checking for a local ${info.label} daemon…\n`);
    return {};
  }

  // Already exported? Use it and say so, rather than asking for something the
  // environment has already answered.
  const existing = resolveKey(providerId);
  if (existing) {
    const origin = keyIsFromEnv(providerId) ? `$${info.envVar}` : 'saved credentials';
    process.stdout.write(`  Using the key from ${origin}.\n`);
    return { apiKey: existing };
  }

  for (;;) {
    const hint = info.keyHint ? ` (${info.keyHint})` : '';
    const key = await password({
      message: `${info.label} API key${hint}`,
      mask: true,
    });
    if (key.trim() === '') {
      process.stdout.write(`  A key is required. Get one at ${info.docsUrl}\n`);
      continue;
    }
    return { apiKey: key.trim() };
  }
}

async function verifyAndList(
  providerId: ProviderId,
  credential: { apiKey?: string; host?: string },
): Promise<ModelInfo[]> {
  const provider = await createProvider(providerId, probeModel(providerId), credential);
  process.stdout.write('  Verifying…\n');
  const models = await provider.listModels();
  return selectableModels(models);
}

async function pickModel(providerId: ProviderId, models: ModelInfo[]): Promise<ModelInfo> {
  const info = providerInfo(providerId);
  const sorted = [...models].sort((a, b) => {
    if (a.id === info.defaultModel) return -1;
    if (b.id === info.defaultModel) return 1;
    return 0;
  });

  return select<ModelInfo>({
    message: 'Choose a model',
    pageSize: 12,
    choices: sorted.map((m) => ({
      name: m.label,
      value: m,
      description: [
        fmtContext(m.contextWindow),
        m.toolUse === 'limited' ? '⚠ tool-calling quality varies — the agent may stall' : '',
        m.note ?? '',
      ]
        .filter(Boolean)
        .join('  ·  '),
    })),
  });
}

/** Runs the picker and persists the result. */
export async function runOnboarding(): Promise<Selection> {
  process.stdout.write('\n  Shakeout — real browser, real data, real integrations. No mocks.\n\n');

  for (;;) {
    const providerId = await pickProvider();
    const info = providerInfo(providerId);

    try {
      const credential = await obtainCredential(providerId);
      const models = await verifyAndList(providerId, credential);

      if (models.length === 0) {
        process.stdout.write(
          `  ${info.label} returned no models capable of driving the agent.\n` +
            (providerId === 'ollama' ? '  Pull one first, e.g. `ollama pull llama3.1`.\n\n' : '\n'),
        );
        continue;
      }

      // Only persist AFTER a real round-trip proved the credential works.
      if (credential.apiKey && !keyIsFromEnv(providerId)) setKey(providerId, credential.apiKey);
      if (credential.host) setHost(providerId, credential.host);

      const model = await pickModel(providerId, models);
      setSelection(providerId, model.id);

      process.stdout.write(
        `\n  Ready: ${model.label} (${info.label})\n` +
          `  Credentials: ${configDir()}/credentials.json (0600)\n` +
          `  Change it any time with \`shakeout model\`.\n\n`,
      );
      return { provider: providerId, model };
    } catch (err) {
      if (err instanceof ProviderError) {
        process.stdout.write(`\n  ${err.isAuth ? 'Credential rejected' : 'Could not connect'}: ${err.message}\n\n`);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Returns the saved selection without prompting, or undefined if the user has
 * not configured one yet (or the credential has since gone missing).
 */
export async function loadSelection(): Promise<Selection | undefined> {
  const saved = getSelection();
  if (!saved) return undefined;
  const info = providerInfo(saved.provider);
  if (info.needsKey && !resolveKey(saved.provider)) return undefined;
  return {
    provider: saved.provider,
    model: { id: saved.model, label: saved.model, provider: saved.provider, toolUse: 'native' },
  };
}
