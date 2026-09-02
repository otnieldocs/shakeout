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
import { runGlobalOracles } from '../src/observer/oracles.js';
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


// ---------------------------------------------------------------------------
// Provider layer
// ---------------------------------------------------------------------------
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'shakeout-test-'));
process.env.SHAKEOUT_CONFIG_DIR = tmp;

const creds = await import('../src/providers/credentials.js');
const { selectableModels, providerInfo } = await import('../src/providers/registry.js');
const { createProvider, probeModel } = await import('../src/providers/index.js');

console.log('\n[credentials]');
delete process.env.ANTHROPIC_API_KEY;
check('no key before anything is stored', creds.resolveKey('anthropic') === undefined);

creds.setKey('anthropic', 'sk-ant-stored');
check('stored key resolves', creds.resolveKey('anthropic') === 'sk-ant-stored');
check('reports stored, not env', creds.keyIsFromEnv('anthropic') === false);

// Environment must win: a key exported for this shell should never be
// shadowed by a stale saved one.
process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
check('env key OVERRIDES stored key', creds.resolveKey('anthropic') === 'sk-ant-from-env');
check('reports env source', creds.keyIsFromEnv('anthropic') === true);
delete process.env.ANTHROPIC_API_KEY;

const credFile = join(tmp, 'credentials.json');
check('credentials file exists', existsSync(credFile));
const mode = statSync(credFile).mode & 0o777;
check('credentials file is 0600', mode === 0o600, `got ${mode.toString(8)}`);
const dirMode = statSync(tmp).mode & 0o777;
check('config dir is 0700', dirMode === 0o700, `got ${dirMode.toString(8)}`);

creds.setSelection('anthropic', 'claude-opus-5');
check('selection round-trips', creds.getSelection()?.model === 'claude-opus-5');

creds.logout('anthropic');
check('logout clears the key', creds.resolveKey('anthropic') === undefined);
check('logout clears its selection', creds.getSelection() === undefined);

console.log('\n[registry]');
check('models that cannot call tools are never offered', selectableModels([
  { id: 'a', label: 'a', provider: 'openai', toolUse: 'none' },
  { id: 'b', label: 'b', provider: 'openai', toolUse: 'native' },
  { id: 'c', label: 'c', provider: 'ollama', toolUse: 'limited' },
]).map((m) => m.id).join(',') === 'b,c');
check('unknown provider rejected', throws(() => providerInfo('nope' as never)));
check('anthropic default model is opus 5', providerInfo('anthropic').defaultModel === 'claude-opus-5');
check('ollama needs no key', providerInfo('ollama').needsKey === false);

console.log('\n[provider factory]');
let missingKeyThrew = false;
try { await createProvider('openai', probeModel('openai')); } catch { missingKeyThrew = true; }
check('openai without a key is refused', missingKeyThrew);

const ollama = await createProvider('ollama', probeModel('ollama'));
check('ollama constructs without a key', ollama.id === 'ollama');
let notImpl = false;
try {
  await ollama.turn({ system: '', messages: [], tools: [] });
} catch (e) { notImpl = (e as Error).name === 'NotImplementedError'; }
check('unimplemented turn() fails loudly', notImpl);

console.log('\n[oracle noise filters]');
// A request the FRAMEWORK cancelled (Next.js speculative RSC prefetch) next to
// a genuinely dead one. The oracle must be able to tell them apart — ignoring
// both would defeat the "UI showed 0 because the request died" case it exists
// for, and ignoring neither makes every run on a Next.js app cry wolf.
const APP = 'https://staging.example.com';
const netEvidence = {
  console: [{ type: 'error', text: 'Download the React DevTools' }],
  pageErrors: [],
  network: [
    { url: `${APP}/pricing?_rsc=1p-R`, failure: 'net::ERR_ABORTED' },
    { url: `${APP}/api/public/pricing`, failure: 'net::ERR_CONNECTION_REFUSED' },
  ],
} as never;

const byName = (rs: { name: string; passed: boolean; detail?: string }[], n: string) =>
  rs.find((r) => r.name === n)!;

const unfiltered = runGlobalOracles(netEvidence, { appOrigins: [APP] });
check('without a filter, both failed requests are reported',
  byName(unfiltered, 'no-failed-app-requests').passed === false);
check('without a filter, the noisy console error is reported',
  byName(unfiltered, 'no-console-errors').passed === false);

const filtered = runGlobalOracles(netEvidence, {
  appOrigins: [APP],
  ignoreNetwork: [/\?_rsc=/],
  ignoreConsole: ['React DevTools'],
});
check('ignoreNetwork silences the prefetch abort but NOT the dead request',
  byName(filtered, 'no-failed-app-requests').passed === false
  && byName(filtered, 'no-failed-app-requests').detail!.includes('CONNECTION_REFUSED'),
  byName(filtered, 'no-failed-app-requests').detail);
check('ignoreConsole silences the third-party console error',
  byName(filtered, 'no-console-errors').passed === true);

const onlyPrefetch = runGlobalOracles(
  { console: [], pageErrors: [], network: [{ url: `${APP}/x?_rsc=1`, failure: 'net::ERR_ABORTED' }] } as never,
  { appOrigins: [APP], ignoreNetwork: [/\?_rsc=/] },
);
check('a run whose only failure is a prefetch abort passes',
  byName(onlyPrefetch, 'no-failed-app-requests').passed === true);

rmSync(tmp, { recursive: true, force: true });

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
