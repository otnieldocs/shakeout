/**
 * Oracles: assertions that read the evidence streams.
 *
 * Every module gets the global invariants for free. They need no fixture and no
 * known-good value, which is what makes them work in a no-mocks world — and
 * they catch the specific failure mode where defensive UI code swallows a
 * failed request and renders a plausible-looking zero instead of an error.
 */
import type { OracleResult } from '../core/types.js';
import type { Evidence, NetworkEvent } from './capture.js';

export interface OracleOptions {
  /** Origins considered "the system under test". A 5xx here is a FAIL. */
  appOrigins: string[];
  /** Console messages matching any of these are ignored (noisy third parties). */
  ignoreConsole?: (string | RegExp)[];
  /**
   * Request URLs matching any of these are ignored by `no-failed-app-requests`.
   *
   * ⚠️ Use this for requests the FRAMEWORK cancels as a matter of course, not
   * for failures you would rather not see. The motivating case is Next.js App
   * Router speculative prefetches (`?_rsc=`): the browser aborts in-flight
   * prefetches whenever the user navigates away, so every run of every module
   * on a Next.js app reports `net::ERR_ABORTED` for a request nothing was
   * waiting on. That is normal browser behaviour, and reporting it as a defect
   * is how a suite loses the credibility it needs to be acted on.
   *
   * ⚠️ Do NOT use it to ignore `net::ERR_ABORTED` in general. Aborting is also
   * how a genuine cancelled fetch appears — the exact "the UI showed 0 because
   * the request died" case this oracle exists to catch. Match on a URL shape
   * that is unambiguously speculative, never on the failure reason.
   */
  ignoreNetwork?: (string | RegExp)[];
}

function matchesAny(text: string, patterns: (string | RegExp)[] = []): boolean {
  return patterns.some((p) => (typeof p === 'string' ? text.includes(p) : p.test(text)));
}

function isAppRequest(event: NetworkEvent, appOrigins: string[]): boolean {
  try {
    return appOrigins.includes(new URL(event.url).origin);
  } catch {
    return false;
  }
}

/**
 * Third-party failures are `blocked`, not `fail`. A 502 from a sandbox
 * provider is not a defect in the system under test, and reporting it as one
 * is how a suite loses the credibility it needs to be acted on.
 */
export function thirdPartyFailures(evidence: Evidence, appOrigins: string[]): NetworkEvent[] {
  return evidence.network.filter(
    (e) => !isAppRequest(e, appOrigins) && (e.failure !== undefined || (e.status ?? 0) >= 500),
  );
}

export function runGlobalOracles(evidence: Evidence, opts: OracleOptions): OracleResult[] {
  const results: OracleResult[] = [];

  // 1. Uncaught exceptions in the page. Never acceptable.
  results.push({
    name: 'no-uncaught-page-errors',
    passed: evidence.pageErrors.length === 0,
    detail:
      evidence.pageErrors.length === 0
        ? undefined
        : `${evidence.pageErrors.length} uncaught error(s); first: ${evidence.pageErrors[0]?.message}`,
    evidence: 'page-errors.ndjson',
  });

  // 2. console.error — the cheapest signal of a swallowed failure.
  const consoleErrors = evidence.console.filter(
    (c) => c.type === 'error' && !matchesAny(c.text, opts.ignoreConsole),
  );
  results.push({
    name: 'no-console-errors',
    passed: consoleErrors.length === 0,
    detail:
      consoleErrors.length === 0
        ? undefined
        : `${consoleErrors.length} console error(s); first: ${consoleErrors[0]?.text.slice(0, 200)}`,
    evidence: 'console.ndjson',
  });

  // 3. Server errors from the system under test.
  const appServerErrors = evidence.network.filter(
    (e) => isAppRequest(e, opts.appOrigins) && (e.status ?? 0) >= 500,
  );
  results.push({
    name: 'no-server-errors',
    passed: appServerErrors.length === 0,
    detail:
      appServerErrors.length === 0
        ? undefined
        : `${appServerErrors.length} 5xx; first: ${appServerErrors[0]?.status} ${appServerErrors[0]?.url}`,
    evidence: 'network.ndjson',
  });

  // 4. Requests to the app that never completed. This is the one that catches
  //    "the UI showed 0 users" when the request actually died.
  const appFailed = evidence.network.filter(
    (e) =>
      isAppRequest(e, opts.appOrigins) &&
      e.failure !== undefined &&
      !matchesAny(e.url, opts.ignoreNetwork),
  );
  results.push({
    name: 'no-failed-app-requests',
    passed: appFailed.length === 0,
    detail:
      appFailed.length === 0
        ? undefined
        : `${appFailed.length} failed; first: ${appFailed[0]?.failure} ${appFailed[0]?.url}`,
    evidence: 'network.ndjson',
  });

  return results;
}

/** Known analytics endpoints, for event-tracking modules. */
const BEACON_HOSTS: Record<string, RegExp> = {
  ga4: /google-analytics\.com\/(g\/)?collect|analytics\.google\.com\/g\/collect/,
  gtm: /googletagmanager\.com\/gtm\.js|googletagmanager\.com\/g\/collect/,
  meta_pixel: /facebook\.com\/tr/,
  tiktok_pixel: /analytics\.tiktok\.com/,
};

/**
 * Assert an analytics beacon fired. Event-tracking is verified by reading the
 * network log — no special mechanism, and no mock, which is the point: the
 * beacon either physically left the browser or it did not.
 */
export function expectBeacon(
  evidence: Evidence,
  provider: keyof typeof BEACON_HOSTS,
  params: Record<string, string> = {},
): OracleResult {
  const pattern = BEACON_HOSTS[provider];
  const name = `beacon:${provider}${Object.keys(params).length ? `:${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')}` : ''}`;
  if (!pattern) {
    return { name, passed: false, detail: `Unknown beacon provider "${provider}"` };
  }

  const candidates = evidence.network.filter((e) => pattern.test(e.url));
  if (candidates.length === 0) {
    return { name, passed: false, detail: `No ${provider} request observed`, evidence: 'network.ndjson' };
  }

  const match = candidates.find((e) => {
    const url = new URL(e.url);
    return Object.entries(params).every(([k, v]) => url.searchParams.get(k) === v);
  });

  return {
    name,
    passed: match !== undefined,
    detail: match
      ? undefined
      : `${candidates.length} ${provider} beacon(s) fired but none matched ${JSON.stringify(params)}`,
    evidence: 'network.ndjson',
  };
}

/**
 * Assert no beacon fired BEFORE a given moment — the consent-gating check.
 * Firing order around cookie consent breaks silently and carries legal weight.
 */
export function expectNoBeaconBefore(
  evidence: Evidence,
  provider: keyof typeof BEACON_HOSTS,
  isoTimestamp: string,
): OracleResult {
  const pattern = BEACON_HOSTS[provider];
  const name = `no-beacon-before:${provider}`;
  if (!pattern) return { name, passed: false, detail: `Unknown beacon provider "${provider}"` };

  const early = evidence.network.filter((e) => pattern.test(e.url) && e.ts < isoTimestamp);
  return {
    name,
    passed: early.length === 0,
    detail: early.length === 0 ? undefined : `${early.length} ${provider} beacon(s) fired before ${isoTimestamp}`,
    evidence: 'network.ndjson',
  };
}
