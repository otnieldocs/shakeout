/**
 * Module discovery and validation.
 *
 * Validation is strict on purpose. A module that cannot clean up after itself
 * is not merely lower quality — it actively degrades the shared staging
 * environment for every other module, and the damage compounds silently. So the
 * loader refuses it rather than warning about it.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ShakeoutModule } from './types.js';

export class ModuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleValidationError';
  }
}

const ENTRY_CANDIDATES = ['index.ts', 'index.js', 'module.ts', 'module.js'];

export function listModuleIds(modulesDir: string): string[] {
  if (!existsSync(modulesDir)) return [];
  return readdirSync(modulesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
    .map((d) => d.name)
    .filter((name) => ENTRY_CANDIDATES.some((f) => existsSync(join(modulesDir, name, f))))
    .sort();
}

function entryPointFor(modulesDir: string, id: string): string {
  for (const candidate of ENTRY_CANDIDATES) {
    const file = join(modulesDir, id, candidate);
    if (existsSync(file)) return file;
  }
  throw new ModuleValidationError(
    `Module "${id}" has no entry point. Expected one of: ${ENTRY_CANDIDATES.join(', ')}`,
  );
}

export function validate(id: string, mod: unknown): ShakeoutModule {
  const m = mod as Partial<ShakeoutModule>;

  if (!m || typeof m !== 'object') {
    throw new ModuleValidationError(`Module "${id}" did not export a module object as default.`);
  }
  if (!m.manifest || typeof m.manifest.id !== 'string' || m.manifest.id.length === 0) {
    throw new ModuleValidationError(`Module "${id}" is missing manifest.id.`);
  }
  if (m.manifest.id !== id) {
    throw new ModuleValidationError(
      `Module in folder "${id}" declares manifest.id "${m.manifest.id}". They must match — ` +
        `the id is also the reporting/ folder name.`,
    );
  }
  if (typeof m.manifest.title !== 'string' || m.manifest.title.length === 0) {
    throw new ModuleValidationError(`Module "${id}" is missing manifest.title.`);
  }
  if (!Array.isArray(m.manifest.sideEffects) || m.manifest.sideEffects.length === 0) {
    throw new ModuleValidationError(
      `Module "${id}" must declare manifest.sideEffects. If it genuinely changes nothing, ` +
        `declare ['none'] explicitly — the runner uses this to filter runs, and an omitted ` +
        `value would silently opt the module into every "safe" run.`,
    );
  }
  if (typeof m.flow !== 'function') {
    throw new ModuleValidationError(`Module "${id}" must export a flow() function.`);
  }
  if (typeof m.teardown !== 'function') {
    throw new ModuleValidationError(
      `Module "${id}" must export a teardown() function.\n` +
        `Shakeout runs against real systems with no mocks, so every run leaves real artifacts ` +
        `behind — a real draft post, a real transaction, a real uploaded file. A module that ` +
        `creates without destroying rots the staging environment for everyone. If this module ` +
        `truly creates nothing, export an empty teardown and declare sideEffects: ['none'].`,
    );
  }

  return m as ShakeoutModule;
}

export async function loadModule(modulesDir: string, id: string): Promise<ShakeoutModule> {
  const entry = entryPointFor(modulesDir, id);
  const imported = (await import(pathToFileURL(resolve(entry)).href)) as {
    default?: unknown;
    module?: unknown;
  };
  return validate(id, imported.default ?? imported.module);
}
