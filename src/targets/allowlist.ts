/**
 * Deny-by-default navigation guard.
 *
 * This is the single highest-value control in the tool. Shakeout drives a real
 * browser, with real credentials, against real data — an open-source tool that
 * a config typo can aim at production will eventually destroy someone's
 * production data. So: nothing is navigable unless a target explicitly lists
 * it, and a target flagged `production` needs a second, environment-level
 * unlock on top of that.
 *
 * Scope note: this guards NAVIGATION, not subresources. Flows legitimately
 * emit third-party requests — GA4 beacons, Meta Pixel, fonts — and asserting
 * on those beacons is a feature (see observer/oracles). Blocking subresources
 * would break the very thing tracking modules exist to verify.
 */
import type { Target } from './types.js';

export class AllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllowlistError';
  }
}

/** Env unlock required in addition to `production: true` on the target. */
export const PRODUCTION_UNLOCK_ENV = 'SHAKEOUT_ALLOW_PRODUCTION';

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new AllowlistError(`Not a valid absolute URL: ${url}`);
  }
}

/**
 * Hostname markers that suggest a non-production environment. Used only to
 * WARN when a target is not flagged `production` but also carries no such
 * marker — a nudge toward labelling, never an authorisation decision.
 */
const NONPROD_MARKERS = ['staging', 'stage', 'dev', 'test', 'qa', 'sandbox', 'localhost', '127.0.0.1'];

export function looksNonProduction(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return NONPROD_MARKERS.some((m) => host.includes(m));
}

/**
 * Gate a target before any browser opens. Throws unless the target is safe to
 * drive. Call once per run, as early as possible.
 */
export function assertTargetUsable(target: Target): void {
  if (target.allowedOrigins.length === 0) {
    throw new AllowlistError(
      `Target "${target.name}" lists no allowedOrigins. Deny-by-default means ` +
        `an empty allowlist can navigate nowhere — list the origins this target needs.`,
    );
  }

  // The baseUrl must be covered by the target's own allowlist. Catches the
  // common config slip of changing baseUrl and forgetting the allowlist.
  const base = originOf(target.baseUrl);
  const allowed = target.allowedOrigins.map(originOf);
  if (!allowed.includes(base)) {
    throw new AllowlistError(
      `Target "${target.name}" has baseUrl ${base} which is not in its own ` +
        `allowedOrigins [${allowed.join(', ')}].`,
    );
  }

  if (target.production) {
    if (process.env[PRODUCTION_UNLOCK_ENV] !== 'yes') {
      throw new AllowlistError(
        `Target "${target.name}" is flagged production. Shakeout writes real ` +
          `data and runs real teardowns; it refuses production by default.\n` +
          `If you genuinely mean it, set ${PRODUCTION_UNLOCK_ENV}=yes for this ` +
          `invocation only. Do not put it in a shell profile or CI variable.`,
      );
    }
    return;
  }

  if (!looksNonProduction(target.baseUrl)) {
    console.warn(
      `[shakeout] WARNING: target "${target.name}" (${base}) carries no ` +
        `staging/dev/test/sandbox marker in its hostname and is not flagged ` +
        `production. If this IS production, set production: true so the guard applies.`,
    );
  }
}

/** Throws unless `url`'s origin is listed on the target. */
export function assertOriginAllowed(target: Target, url: string): void {
  const origin = originOf(url);
  const allowed = target.allowedOrigins.map(originOf);
  if (!allowed.includes(origin)) {
    throw new AllowlistError(
      `Navigation to ${origin} refused: not in allowedOrigins for target ` +
        `"${target.name}" [${allowed.join(', ')}].\n` +
        `If this origin is a legitimate part of the flow (identity provider, ` +
        `hosted checkout, OAuth consent), add it to the target config.`,
    );
  }
}
