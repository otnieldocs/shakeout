/**
 * Config loading. The config file is gitignored by default because it names
 * your environments; `shakeout.config.example.ts` is the tracked template.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ShakeoutConfig, Target } from './types.js';

const CONFIG_CANDIDATES = [
  'shakeout.config.ts',
  'shakeout.config.js',
  'shakeout.config.mjs',
  'shakeout.config.example.ts',
];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export async function loadConfig(cwd: string = process.cwd()): Promise<ShakeoutConfig> {
  for (const candidate of CONFIG_CANDIDATES) {
    const file = resolve(cwd, candidate);
    if (!existsSync(file)) continue;
    const imported = (await import(pathToFileURL(file).href)) as {
      default?: ShakeoutConfig;
      config?: ShakeoutConfig;
    };
    const config = imported.default ?? imported.config;
    if (!config) {
      throw new ConfigError(`${candidate} exists but exports no default config object.`);
    }
    if (!Array.isArray(config.targets) || config.targets.length === 0) {
      throw new ConfigError(`${candidate} defines no targets.`);
    }
    return config;
  }
  throw new ConfigError(
    `No config found. Expected one of: ${CONFIG_CANDIDATES.join(', ')}\n` +
      `Copy shakeout.config.example.ts to shakeout.config.ts and edit it.`,
  );
}

export function resolveTarget(config: ShakeoutConfig, name?: string): Target {
  const wanted = name ?? config.defaultTarget;
  if (!wanted) {
    throw new ConfigError(
      `No target specified and no defaultTarget in config. Use --target <name>. ` +
        `Available: ${config.targets.map((t) => t.name).join(', ')}`,
    );
  }
  const target = config.targets.find((t) => t.name === wanted);
  if (!target) {
    throw new ConfigError(
      `Unknown target "${wanted}". Available: ${config.targets.map((t) => t.name).join(', ')}`,
    );
  }
  return target;
}
