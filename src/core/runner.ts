/**
 * The runner: setup → flow → oracles → teardown, with the outcome model that
 * makes the whole thing trustworthy.
 *
 * Teardown ALWAYS runs, including when flow throws — that is the entire reason
 * it is mandatory. And a teardown that fails is itself a failure, because the
 * next run inherits the mess.
 */
import { join } from 'node:path';
import { launch } from '../controller/browser.js';
import { requestHuman } from '../controller/human.js';
import { Observer } from '../observer/capture.js';
import { runGlobalOracles, thirdPartyFailures } from '../observer/oracles.js';
import { createRunFolder, makeRunId, prune, updateLatest, writeResult } from '../reporting/writer.js';
import { assertTargetUsable } from '../targets/allowlist.js';
import type { Target } from '../targets/types.js';
import { SessionVault } from '../vault/sessions.js';
import type { ShakeoutModule } from './types.js';
import { BlockedError, type OracleResult, type RunContext, type RunResult } from './types.js';

export interface RunOptions {
  target: Target;
  reportingDir: string;
  vaultDir: string;
  headed: boolean;
  /** Extra app-specific secret keys for the redactor. */
  extraSecretKeys?: string[];
  ignoreConsole?: (string | RegExp)[];
  captureBodies?: boolean;
}

export async function runModule(mod: ShakeoutModule, opts: RunOptions): Promise<RunResult> {
  // Gate the target before anything opens. Cheapest possible place to refuse.
  assertTargetUsable(opts.target);

  const { manifest } = mod;
  const runId = makeRunId();
  const artifactDir = createRunFolder(opts.reportingDir, manifest.id, runId);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const observer = new Observer(artifactDir, {
    extraSecretKeys: opts.extraSecretKeys,
    captureBodies: opts.captureBodies,
  });

  const vault = new SessionVault(opts.vaultDir);
  const oracles: OracleResult[] = [];
  let outcome: RunResult['outcome'] = 'pass';
  let error: RunResult['error'];
  const teardownState: RunResult['teardown'] = { ran: false, ok: false };

  observer.log(`run ${runId} — ${manifest.id} against ${opts.target.name} (${opts.target.baseUrl})`);
  if (manifest.sideEffects.includes('external_publish')) {
    observer.log('module declares external_publish — this run touches a real third-party platform');
  }

  const sessionName = manifest.requires?.session;
  const storageStatePath = sessionName ? vault.storageStatePath(sessionName) : undefined;
  if (sessionName && !storageStatePath) {
    observer.log(`session "${sessionName}" missing or expired; a human handoff may be required`);
  }

  const session = await launch(opts.target, {
    headed: opts.headed,
    storageStatePath,
  });
  observer.attach(session.page);

  const ctx: RunContext = {
    page: session.page,
    context: session.context,
    baseUrl: opts.target.baseUrl,
    artifactDir,
    log: (message, data) => observer.log(message, data),
    shot: (name) => observer.shot(session.page, name),
    human: async (instruction, humanOpts) => {
      await requestHuman(session.page, instruction, {
        headed: opts.headed,
        timeoutMs: humanOpts?.timeoutMs,
      });
      // Persist whatever the human just unlocked, so the next run skips it.
      if (sessionName) {
        vault.save(sessionName, await session.context.storageState());
        observer.log(`saved session "${sessionName}" to vault`);
      }
    },
  };

  try {
    if (mod.setup) {
      observer.log('setup');
      await mod.setup(ctx);
    }
    observer.log('flow');
    await mod.flow(ctx);

    if (mod.oracles) {
      observer.log('module oracles');
      oracles.push(...(await mod.oracles(ctx)));
    }
  } catch (err) {
    const e = err as Error;
    error = { message: e.message, stack: e.stack };
    outcome = e instanceof BlockedError ? 'blocked' : 'fail';
    observer.log(`${outcome}: ${e.message}`);
    await observer.shot(session.page, 'failure').catch(() => undefined);
  }

  // Global invariants read the evidence regardless of how the flow ended.
  oracles.push(
    ...runGlobalOracles(observer.evidence, {
      appOrigins: opts.target.allowedOrigins.map((o) => new URL(o).origin),
      ignoreConsole: opts.ignoreConsole,
    }),
  );

  oracles.push({
    name: 'no-allowlist-violations',
    passed: session.allowlistViolations.length === 0,
    detail:
      session.allowlistViolations.length === 0
        ? undefined
        : `Blocked navigation to: ${session.allowlistViolations.join(', ')}`,
  });

  // Teardown ALWAYS runs. This is why it is mandatory.
  try {
    observer.log('teardown');
    await mod.teardown(ctx);
    teardownState.ran = true;
    teardownState.ok = true;
  } catch (err) {
    const e = err as Error;
    teardownState.ran = true;
    teardownState.ok = false;
    teardownState.error = e.message;
    observer.log(`teardown FAILED: ${e.message}`);
  }

  await session.close();

  // Outcome resolution, in priority order.
  if (outcome !== 'blocked') {
    const thirdParty = thirdPartyFailures(observer.evidence, opts.target.allowedOrigins.map((o) => new URL(o).origin));
    const failedOracles = oracles.filter((o) => !o.passed);

    if (failedOracles.length > 0 || !teardownState.ok) {
      outcome = 'fail';
      if (!error && !teardownState.ok) {
        error = { message: `teardown failed: ${teardownState.error ?? 'unknown'}` };
      }
    } else if (outcome === 'pass' && thirdParty.length > 0) {
      // Flow survived, but a dependency misbehaved. Worth surfacing, not worth
      // failing a pipeline over.
      observer.log(`${thirdParty.length} third-party failure(s) observed — not counted as a defect`);
    }
  }

  const finishedAt = new Date().toISOString();
  const result: RunResult = {
    moduleId: manifest.id,
    outcome,
    target: opts.target.name,
    startedAt,
    finishedAt,
    durationMs: Date.now() - startMs,
    oracles,
    error,
    teardown: teardownState,
    cost: manifest.cost,
    artifactDir,
  };

  observer.log(`outcome: ${outcome}`);
  await observer.close();

  writeResult(artifactDir, result);
  updateLatest(opts.reportingDir, manifest.id, runId);
  const removed = prune(opts.reportingDir, manifest.id);
  if (removed.length > 0) {
    console.log(`  · pruned ${removed.length} old run folder(s)`);
  }

  return result;
}

export function reportPath(reportingDir: string, moduleId: string): string {
  return join(reportingDir, moduleId, 'latest');
}
