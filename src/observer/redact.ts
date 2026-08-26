/**
 * Redaction at CAPTURE time.
 *
 * A run folder is a credential dump by default: an authenticated session's
 * traffic carries `Authorization: Bearer <live token>`, `Cookie`, `Set-Cookie`,
 * and OAuth codes in query strings. If redaction were a viewer-side concern the
 * raw secret would already be on disk — and already inside the CI artifact, the
 * Jira attachment, and the "here's my repro" zip someone posts in an issue.
 *
 * So nothing unredacted is ever written. This is also why Shakeout does NOT use
 * Playwright's built-in `recordHar`: that writes the file itself, with no hook
 * to scrub it first.
 *
 * This is a best-effort net over an unbounded space of app-specific secrets. It
 * is not a substitute for keeping `reporting/` out of version control.
 */

export const REDACTED = '[REDACTED:shakeout]';

/** Headers whose VALUE is always secret. Compared case-insensitively. */
const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
  'x-session-token',
  'x-refresh-token',
  'x-amz-security-token',
]);

/** Query/body keys whose value is secret. Substring match, case-insensitive. */
const SECRET_KEY_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'client_secret',
  'authorization',
  'credential',
  'signature',
  'private_key',
  'session',
  'otp',
  'code_verifier',
];

function isSecretKey(key: string, extra: string[] = []): boolean {
  const k = key.toLowerCase();
  return (
    SECRET_KEY_PATTERNS.some((p) => k.includes(p)) ||
    extra.some((p) => k.toLowerCase().includes(p.toLowerCase()))
  );
}

export function redactHeaders(
  headers: Record<string, string>,
  extraKeys: string[] = [],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SECRET_HEADERS.has(k.toLowerCase()) || isSecretKey(k, extraKeys) ? REDACTED : v;
  }
  return out;
}

/** Strips secret-looking query parameters while keeping the URL readable. */
export function redactUrl(url: string, extraKeys: string[] = []): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  let touched = false;
  for (const key of [...parsed.searchParams.keys()]) {
    // `code` is an OAuth authorization code — exact match only, so ordinary
    // params like `country_code` or `plan_code` survive intact.
    if (isSecretKey(key, extraKeys) || key.toLowerCase() === 'code') {
      parsed.searchParams.set(key, REDACTED);
      touched = true;
    }
  }
  return touched ? parsed.toString() : url;
}

/**
 * Walks a parsed JSON body and redacts secret-keyed values at any depth.
 * Non-JSON bodies are returned as a size marker rather than content: an
 * arbitrary form post or binary upload cannot be scrubbed reliably, and
 * guessing is how secrets leak.
 */
export function redactJson(value: unknown, extraKeys: string[] = [], depth = 0): unknown {
  if (depth > 12) return '[truncated:depth]';
  if (Array.isArray(value)) return value.map((v) => redactJson(v, extraKeys, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k, extraKeys) ? REDACTED : redactJson(v, extraKeys, depth + 1);
    }
    return out;
  }
  return value;
}

export function redactBody(
  body: string | undefined,
  contentType: string | undefined,
  extraKeys: string[] = [],
): unknown {
  if (body === undefined || body === '') return undefined;
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      return redactJson(JSON.parse(body), extraKeys);
    } catch {
      return `[unparseable json, ${body.length} bytes]`;
    }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(body);
    const out: Record<string, string> = {};
    for (const [k, v] of params.entries()) out[k] = isSecretKey(k, extraKeys) ? REDACTED : v;
    return out;
  }
  return `[${ct || 'unknown content-type'}, ${body.length} bytes]`;
}
