# Shakeout

*Intelligent QA Realtime Automation Platform*

**Put the real thing through real conditions.**
Agent-driven QA against a live staging environment — real browser, real data, real integrations. No mocks.

---

## Why

Conventional UI tests assert against mocked data. They prove the frontend renders a fixture
correctly, which is useful, and structurally blind to the bug class that actually reaches
production: the request that silently failed, the integration whose contract drifted, the
defensive `catch` that turned missing data into a plausible-looking zero.

Shakeout runs the other way round. It drives a real browser against a real staging
deployment, wired to real sandbox integrations, and asserts on what actually happened —
the network log, the console, the DOM, the beacons that left the page.

A *shakeout run* is the engineering term for taking a real machine into real operating
conditions to find what breaks. That is the whole design.

## What makes it different

**No mocks, anywhere.** If a flow publishes a video, a video gets published — to a sandbox
account, and then deleted. The sandbox matrix is uneven by nature (Midtrans and TikTok have
real sandboxes; YouTube has quota and a test channel; Instagram has neither), so modules
declare what they touch and the runner schedules accordingly.

**Human handoff is a feature, not a limitation.** Some steps an agent cannot do and should
not fake — a Google consent screen, a 2FA code, a payment approval. `ctx.human()` pauses the
run, the operator does it once, and the resulting session goes into the vault so subsequent
runs skip it. A human is needed once per *era*, not once per run.

**Three outcomes, not two.** `pass`, `fail`, and `blocked`. When a sandbox is down, that is
not your bug. Conflating the two trains people to ignore red, and a suite nobody trusts gets
switched off.

**Evidence is the oracle.** With no fixtures there is often no known-good value to compare
against, so the captured streams *are* the assertion surface: no uncaught errors, no console
errors, no 5xx from the app, no request that died silently.

## Install

```bash
npm install
npx playwright install chromium
cp shakeout.config.example.ts shakeout.config.ts   # then edit it
```

## Use

```bash
shakeout list                       # discovered modules
shakeout auth qa_user --headed      # one-time human handoff, saved to the vault
shakeout example_login              # run a module
shakeout report example_login       # path to the latest run folder
```

## Architecture

```
core/         runner, module loader, the outcome model
controller/   browser control + human handoff — the agent's hands
observer/     console, network, screenshots + the oracles that read them
targets/      environments and the origin allowlist
vault/        human-authenticated sessions, TTL'd, 0600
reporting/    per-module run folders (gitignored — see Security)
modules/      one folder per user intent
```

### Module anatomy

```
modules/tiktok_publish/
├── index.ts        manifest + setup + flow + oracles + teardown
└── fixtures/       sample.mp4, thumbnail.png
```

```ts
export default defineModule({
  manifest: {
    id: 'tiktok_publish',
    title: 'A creator can publish a video to TikTok',
    requires: { session: 'qa_admin', connections: ['tiktok_sandbox'], plan: 'premium' },
    cost: { quota: { youtube: 0 }, wallclockMs: 180_000 },
    sideEffects: ['external_publish', 'db_write'],
  },
  async setup(ctx) { /* preconditions; ctx.human() if needed */ },
  async flow(ctx)  { /* click, type, upload, submit */ },
  async oracles(ctx) { return [/* module-specific assertions */] },
  async teardown(ctx) { /* delete the video it just published */ },
})
```

`teardown` is **required**. The loader refuses a module without one. With no mocks every run
leaves real artifacts behind, and a module that creates without destroying degrades the shared
environment for everything else — silently, and cumulatively.

`sideEffects` is **required** too, including the explicit `['none']`. It is what makes
`--skip-effects external_publish` work without a hand-maintained list.

### Event tracking

Analytics assertions are just network-log oracles — no special mechanism:

```ts
expectBeacon(evidence, 'ga4', { en: 'purchase' })
expectNoBeaconBefore(evidence, 'meta_pixel', consentGrantedAt)   // consent gating
```

Point staging at its **own** GA4 property, GTM container and Pixel ID. If the staging web
build reuses production tracking IDs, every QA run corrupts real analytics — and because
`NEXT_PUBLIC_*`-style vars are inlined at *build* time, that is a CI change, not a config one.

## Security

Shakeout is a privileged runtime: an agent, a real browser, real credentials, real data. Four
controls, built in rather than bolted on.

**1. Deny-by-default navigation.** Nothing is navigable unless a target lists it. A target
flagged `production: true` additionally requires `SHAKEOUT_ALLOW_PRODUCTION=yes` in the
environment — two locks, because one is one typo away from an agent clicking "delete account"
against real customer data.

**2. Redaction at capture time.** `Authorization`, `Cookie`, `Set-Cookie`, OAuth codes and
secret-keyed body fields are scrubbed *before* bytes reach disk. This is why Shakeout does not
use Playwright's built-in HAR recording: it writes the file itself, with no hook to scrub it
first. If redaction were a viewer-side concern the secret would already be on disk — and
already in the CI artifact.

**3. `reporting/` and `.vault/` are gitignored, permanently.** A run folder is a credential
dump by default. A stored session is bearer-equivalent; session files are written `0600`.
Redaction is a best-effort net over an unbounded space of app-specific secrets — it is not a
licence to commit these folders.

**4. Page content is data, never instructions.** The agent reads DOM and screenshots from an
application that may contain user- or third-party-controlled text. Nothing read from a page is
ever routed into an instruction channel, and the runner has no shell access.

Note what leaves your machine: if an AI layer is used to author or triage modules, DOM and
screenshots go to a model provider. Seed staging with synthetic data rather than a production
clone — it is both safer and more deterministic.

## Status

Early. Working today: module loading and validation, the runner and outcome model, browser
control, human handoff, the observer and global oracles, the session vault, run folders with
retention, and JUnit output.

Not built yet:

- **`state/`** — database snapshot/restore. The intended answer to repeatability: social OAuth
  tokens live in the application's database, not in a cookie, so a golden snapshot restored per
  run is what lets `tiktok_publish` run unattended after a single human connect.
- **The agent layer** — natural language → an emitted module. The design rule is that the AI is
  a *compiler*, not an interpreter: it writes modules that are committed and reviewed like code,
  never decisions taken live at runtime. That boundary is a security control as much as a
  quality one.
- **Differential oracles** — comparing a run against the previous `result.json`.

## Contributing

Conventional Commits (`feat:`, `fix:`, `docs:`). `npm test` and `npm run typecheck` must pass.

Because Shakeout is dual-licensed (see below), contributors are asked to sign a Contributor
License Agreement before a first pull request is merged. Without it, that contribution cannot
be included in the commercially licensed build.

## License

Shakeout is licensed under the **GNU Affero General Public License v3.0** — see [LICENSE](LICENSE).

That choice is deliberate. You may use, modify, self-host and run Shakeout freely, including
inside a commercial company, and nothing is owed for doing so. What AGPL section 13 adds over
the GPL is the network clause: if you run a **modified** version of Shakeout as a service that
other people interact with over a network, you must offer those users the complete
corresponding source of your modified version.

### Commercial licensing

If you want to build a proprietary product or a hosted service on top of Shakeout without the
AGPL's source-disclosure obligation, a separate commercial license is available.

Contact **otniel@kreasistudio.co.id**.
