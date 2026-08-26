/**
 * Session vault: browser state a human authenticated once, reused until it
 * expires.
 *
 * The design goal is that a human is needed once per ERA, not once per run.
 * Social OAuth connections are a separate matter — those tokens live in the
 * application's own database, not in a cookie, so they are handled by a
 * database snapshot rather than here (see the roadmap note in README).
 *
 * SECURITY: a stored session is bearer-equivalent. Anyone holding this file is
 * logged in as that user. Files are written 0600, the directory is gitignored,
 * and `shakeout auth purge` exists so revoking is one command.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Auth0 access tokens are typically 24h; expire a little before that. */
export const DEFAULT_TTL_HOURS = 20;

export interface SessionMeta {
  name: string;
  savedAt: string;
  ageHours: number;
  expired: boolean;
}

export class SessionVault {
  constructor(
    private readonly dir: string,
    private readonly ttlHours: number = DEFAULT_TTL_HOURS,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(name: string): string {
    const safe = name.replace(/[^a-z0-9_-]+/gi, '_');
    return join(this.dir, `${safe}.json`);
  }

  has(name: string): boolean {
    return existsSync(this.pathFor(name));
  }

  ageHours(name: string): number | undefined {
    const file = this.pathFor(name);
    if (!existsSync(file)) return undefined;
    return (Date.now() - statSync(file).mtimeMs) / (1000 * 60 * 60);
  }

  isValid(name: string): boolean {
    const age = this.ageHours(name);
    return age !== undefined && age < this.ttlHours;
  }

  /** Absolute path for Playwright's `storageState`, or undefined if unusable. */
  storageStatePath(name: string): string | undefined {
    return this.isValid(name) ? this.pathFor(name) : undefined;
  }

  save(name: string, storageState: unknown): void {
    const file = this.pathFor(name);
    writeFileSync(file, JSON.stringify(storageState), 'utf8');
    // Owner read/write only. The default umask would leave this group-readable
    // on many systems, and this file IS the credential.
    chmodSync(file, 0o600);
  }

  read(name: string): unknown | undefined {
    const file = this.pathFor(name);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, 'utf8'));
  }

  list(): SessionMeta[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const name = f.replace(/\.json$/, '');
        const age = this.ageHours(name) ?? Number.POSITIVE_INFINITY;
        return {
          name,
          savedAt: new Date(statSync(join(this.dir, f)).mtimeMs).toISOString(),
          ageHours: Number(age.toFixed(1)),
          expired: age >= this.ttlHours,
        };
      });
  }

  purge(name?: string): void {
    if (name) {
      rmSync(this.pathFor(name), { force: true });
      return;
    }
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
  }
}
