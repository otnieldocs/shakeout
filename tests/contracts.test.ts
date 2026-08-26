/**
 * Contract tests for the guarantees Shakeout makes about itself.
 *
 * These cover the three things that must never silently regress: the target
 * allowlist (which is what stops a config typo aiming a destructive agent at
 * production), redaction (which is what keeps a run folder from being a
 * credential dump), and loader validation (which is what keeps an
 * un-cleanable module out of a shared environment).
 *
 * Zero test-framework dependency on purpose — a tool that handles credentials
 * should keep its dependency surface small enough to audit by reading it.
 */
import { assertTargetUsable, assertOriginAllowed } from '../src/targets/allowlist.js';
import { redactHeaders, redactUrl, redactBody, REDACTED } from '../src/observer/redact.js';
import { validate } from '../src/core/loader.js';
import type { Target } from '../src/targets/types.js';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};
const throws = (fn: () => void) => { try { fn(); return false; } catch { return true; } };

const prod: Target = { name: 'production', baseUrl: 'https://app.example.com',
  allowedOrigins: ['https://app.example.com'], production: true };
const staging: Target = { name: 'staging', baseUrl: 'https://staging.example.com',
  allowedOrigins: ['https://staging.example.com', 'https://tenant.auth0.com'] };

console.log('\n[allowlist]');
delete process.env.SHAKEOUT_ALLOW_PRODUCTION;
check('production target refused without env unlock', throws(() => assertTargetUsable(prod)));
process.env.SHAKEOUT_ALLOW_PRODUCTION = 'yes';
check('production target allowed WITH env unlock', !throws(() => assertTargetUsable(prod)));
delete process.env.SHAKEOUT_ALLOW_PRODUCTION;
check('staging target passes', !throws(() => assertTargetUsable(staging)));
check('empty allowlist refused', throws(() => assertTargetUsable(
  { name: 'x', baseUrl: 'https://a.com', allowedOrigins: [] })));
check('baseUrl outside own allowlist refused', throws(() => assertTargetUsable(
  { name: 'x', baseUrl: 'https://evil.com', allowedOrigins: ['https://staging.example.com'] })));
check('unlisted origin refused', throws(() => assertOriginAllowed(staging, 'https://evil.com/x')));
check('listed origin allowed', !throws(() => assertOriginAllowed(staging, 'https://tenant.auth0.com/authorize')));

console.log('\n[redaction]');
const h = redactHeaders({ Authorization: 'Bearer live-token-abc', Cookie: 'sid=secret', Accept: 'application/json' });
check('Authorization scrubbed', h.Authorization === REDACTED, `got ${h.Authorization}`);
check('Cookie scrubbed', h.Cookie === REDACTED);
check('ordinary header preserved', h.Accept === 'application/json');
const u = redactUrl('https://x.com/cb?code=oauth-code-123&country_code=ID&access_token=zzz');
check('OAuth code scrubbed', u.includes(`code=${encodeURIComponent(REDACTED)}`), u);
check('country_code preserved', u.includes('country_code=ID'), u);
check('access_token scrubbed', !u.includes('zzz'), u);
const b = redactBody(JSON.stringify({ email: 'a@b.com', password: 'hunter2', nested: { api_key: 'k' } }), 'application/json') as Record<string, unknown>;
check('password scrubbed in body', b.password === REDACTED);
check('nested api_key scrubbed', (b.nested as Record<string, unknown>).api_key === REDACTED);
check('non-secret field preserved', b.email === 'a@b.com');
check('binary body not echoed', typeof redactBody('\x00\x01raw', 'video/mp4') === 'string');

console.log('\n[loader validation]');
const base = { manifest: { id: 'm', title: 'T', sideEffects: ['none'] }, flow: async () => {} };
check('module without teardown REJECTED', throws(() => validate('m', base)));
check('module with teardown accepted', !throws(() => validate('m', { ...base, teardown: async () => {} })));
check('module without sideEffects REJECTED', throws(() => validate('m',
  { manifest: { id: 'm', title: 'T' }, flow: async () => {}, teardown: async () => {} })));
check('folder/manifest id mismatch REJECTED', throws(() => validate('other', { ...base, teardown: async () => {} })));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
