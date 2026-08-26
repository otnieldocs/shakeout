# Contributing to Shakeout

Thanks for considering it. This document covers the CLA, the gates your change has to
pass, and the few invariants that are non-negotiable because they protect the shared
staging environments Shakeout runs against.

## Before your first pull request: sign the CLA

Shakeout is dual-licensed — AGPL-3.0 publicly, plus a paid commercial license for
organisations that need to build proprietary products on it. Offering that second
license requires the project owner to hold sufficient rights over all the code.

**Read [CLA.md](CLA.md) and post the signature block from its "How to sign" section as a
comment on your pull request.** It takes a minute, you keep the copyright in your work,
and you only ever do it once.

The agreement is explicit that your contribution may end up in a commercially licensed
version sold for money, with no payment to you. If that is not a trade you want to make,
please don't sign — that is a completely reasonable position, and it's better to know
before you spend time on a patch.

## Getting set up

```bash
npm install
npx playwright install chromium      # only needed to actually run modules
cp shakeout.config.example.ts shakeout.config.ts
```

## The gates

CI runs these on every push and pull request, and they must be green:

```bash
npm run typecheck    # tsc across src, tests and modules
npm test             # contract tests — zero test-framework dependency
npm run build        # emits dist/ from src/ only
```

There are two custom gates beyond the usual. **`module invariants`** loads every module
in `modules/` and fails if any is invalid. **`repo hygiene`** fails if `reporting/`,
`.vault/`, `dist/` or any `.env` is ever tracked, and if `.gitignore` stops covering the
first two in their anchored form.

That last check exists because of a real bug: a bare `reporting/` pattern matches at any
depth and silently swallowed `src/reporting/`, producing a repo that built fine locally
and could not compile in CI. Leading slashes on those entries are load-bearing.

## Invariants that will not be relaxed

**Every module exports `teardown()`.** The loader refuses modules without one. Shakeout
runs against real systems with no mocks, so every run leaves real artifacts behind — a
real draft post, a real transaction, a real uploaded file. A module that creates without
destroying degrades a shared environment cumulatively and silently, which is the kind of
damage no reviewer catches. If your module genuinely creates nothing, export an empty
`teardown()` and declare `sideEffects: ['none']` explicitly.

**Every module declares `sideEffects`.** Including `['none']`. It is what makes
`--skip-effects external_publish` work without a hand-maintained list.

**No mocks.** If you find yourself wanting to stub an integration, you are writing a
different kind of test than this tool exists for.

**Secrets are redacted at capture time**, never on read. If you add a capture path, it
must go through `src/observer/redact.ts` before anything reaches disk. Changes to
`redact.ts`, `src/targets/allowlist.ts` or `src/vault/sessions.ts` are security-relevant
and will get close review — please explain your reasoning in the PR description.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`,
`ci:`, `chore:`, `build:`, `test:`, `refactor:`.

Write the body to explain *why*, not what — the diff already says what.

## Reporting a security issue

Please do **not** open a public issue. Email **otniel@kreasistudio.co.id** with details
and, where possible, a reproduction. Shakeout handles live credentials, so vulnerability
reports are taken seriously and acknowledged quickly.
