/**
 * Credential store for provider API keys.
 *
 * Lives in ~/.shakeout/, NOT in the project's .vault/. Those are different
 * things with different lifetimes: a vaulted browser session belongs to one
 * project and expires in hours; an API key is user-global and long-lived, the
 * same way ~/.aws/credentials is. Storing it per-project would mean re-entering
 * it for every repo you point Shakeout at.
 *
 * SECURITY: the file is a bearer credential. Directory 0700, file 0600, and a
 * key is never logged, echoed, or included in a run report. `shakeout auth
 * logout` removes it.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { providerInfo } from './registry.js';
import type { ProviderId } from './types.js';

export interface ProviderCredential {
  apiKey?: string;
  /** Ollama only — base URL of the local daemon. */
  host?: string;
}

export interface StoredConfig {
  version: 1;
  providers: Partial<Record<ProviderId, ProviderCredential>>;
  /** Last chosen model, so subsequent runs start without asking. */
  selected?: { provider: ProviderId; model: string };
}

const EMPTY: StoredConfig = { version: 1, providers: {} };

export function configDir(): string {
  return process.env.SHAKEOUT_CONFIG_DIR ?? join(homedir(), '.shakeout');
}

function configPath(): string {
  return join(configDir(), 'credentials.json');
}

export function load(): StoredConfig {
  const file = configPath();
  if (!existsSync(file)) return { ...EMPTY, providers: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoredConfig;
    if (parsed.version !== 1) return { ...EMPTY, providers: {} };
    return parsed;
  } catch {
    // A corrupt config must not brick the CLI. Treat it as absent; the next
    // save overwrites it cleanly.
    return { ...EMPTY, providers: {} };
  }
}

export function save(config: StoredConfig): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is subject to umask, so set it explicitly afterwards too.
  chmodSync(dir, 0o700);
  const file = configPath();
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(file, 0o600);
}

/**
 * Resolution order: environment first, then the stored file.
 *
 * Environment wins so CI and one-off overrides work without touching the file,
 * and so a key exported for a session is never silently shadowed by a stale
 * saved one.
 */
export function resolveKey(provider: ProviderId): string | undefined {
  const info = providerInfo(provider);
  if (info.envVar) {
    const fromEnv = process.env[info.envVar];
    if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim();
  }
  return load().providers[provider]?.apiKey;
}

/** True when the key came from the environment rather than the stored file. */
export function keyIsFromEnv(provider: ProviderId): boolean {
  const info = providerInfo(provider);
  if (!info.envVar) return false;
  const fromEnv = process.env[info.envVar];
  return Boolean(fromEnv && fromEnv.trim() !== '');
}

export function setKey(provider: ProviderId, apiKey: string): void {
  const config = load();
  config.providers[provider] = { ...config.providers[provider], apiKey };
  save(config);
}

export function setHost(provider: ProviderId, host: string): void {
  const config = load();
  config.providers[provider] = { ...config.providers[provider], host };
  save(config);
}

export function resolveHost(provider: ProviderId): string | undefined {
  const info = providerInfo(provider);
  if (info.envVar) {
    const fromEnv = process.env[info.envVar];
    if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim();
  }
  return load().providers[provider]?.host;
}

export function getSelection(): StoredConfig['selected'] {
  return load().selected;
}

export function setSelection(provider: ProviderId, model: string): void {
  const config = load();
  config.selected = { provider, model };
  save(config);
}

/** Removes one provider's credential, or the whole file. */
export function logout(provider?: ProviderId): void {
  if (!provider) {
    rmSync(configPath(), { force: true });
    return;
  }
  const config = load();
  delete config.providers[provider];
  if (config.selected?.provider === provider) delete config.selected;
  save(config);
}

/** For `shakeout auth status` — never returns key material. */
export function status(): { provider: ProviderId; source: 'env' | 'stored' }[] {
  const config = load();
  const out: { provider: ProviderId; source: 'env' | 'stored' }[] = [];
  for (const info of [...new Set(Object.keys(config.providers) as ProviderId[])]) {
    out.push({ provider: info, source: keyIsFromEnv(info) ? 'env' : 'stored' });
  }
  for (const p of (['anthropic', 'openai', 'google'] as ProviderId[])) {
    if (!out.some((o) => o.provider === p) && keyIsFromEnv(p)) {
      out.push({ provider: p, source: 'env' });
    }
  }
  return out;
}
