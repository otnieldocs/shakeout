/**
 * Run folders under reporting/<module_id>/<run_id>/.
 *
 * Two rules that matter:
 *
 * 1. The folder is created at run START, not on completion. If it were written
 *    only when a run finishes, every hard crash — the most interesting failures
 *    — would leave nothing behind. A run folder with no result.json is itself
 *    the signal that the runner died rather than the module failing.
 *
 * 2. result.json is machine-first and stable. It is the input to the
 *    differential oracle ("same module, versus last run") and to failure
 *    triage, so field ordering is deterministic and volatile values stay out
 *    of the comparable surface.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { RunResult } from '../core/types.js';

export interface RetentionPolicy {
  /** Passing runs are only interesting as the previous baseline. */
  keepPasses: number;
  /** Failures are what people come back to read. */
  keepFailures: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { keepPasses: 5, keepFailures: 30 };

export function makeRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
  const suffix = Math.random().toString(16).slice(2, 6);
  return `${stamp}_${suffix}`;
}

/** Creates reporting/<moduleId>/<runId>/ and returns its absolute path. */
export function createRunFolder(reportingDir: string, moduleId: string, runId: string): string {
  const dir = join(reportingDir, moduleId, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeResult(artifactDir: string, result: RunResult): void {
  writeFileSync(join(artifactDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

/** Points reporting/<moduleId>/latest at the run just finished. */
export function updateLatest(reportingDir: string, moduleId: string, runId: string): void {
  const link = join(reportingDir, moduleId, 'latest');
  try {
    if (existsSync(link) || statSync(link, { throwIfNoEntry: false })) unlinkSync(link);
  } catch {
    /* no existing link */
  }
  try {
    symlinkSync(runId, link, 'dir');
  } catch {
    // Windows without developer mode cannot symlink. Non-fatal: `latest` is a
    // convenience, and the run folder itself is already written.
  }
}

/** Reads the previous run's result, for differential comparison. */
export function readPreviousResult(reportingDir: string, moduleId: string, excludeRunId: string): RunResult | undefined {
  const base = join(reportingDir, moduleId);
  if (!existsSync(base)) return undefined;
  const runs = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== excludeRunId)
    .map((d) => d.name)
    .sort()
    .reverse();
  for (const run of runs) {
    const file = join(base, run, 'result.json');
    if (!existsSync(file)) continue;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as RunResult;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Prune on write. A trace with video runs 5-50MB; a handful of modules at a few
 * runs a day fills a disk quickly. Asymmetric on purpose — passes age out fast,
 * failures stick around.
 */
export function prune(
  reportingDir: string,
  moduleId: string,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): string[] {
  const base = join(reportingDir, moduleId);
  if (!existsSync(base)) return [];

  const runs = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();

  const removed: string[] = [];
  let passes = 0;
  let failures = 0;

  for (const run of runs) {
    const resultFile = join(base, run, 'result.json');
    let outcome = 'fail';
    if (existsSync(resultFile)) {
      try {
        outcome = (JSON.parse(readFileSync(resultFile, 'utf8')) as RunResult).outcome;
      } catch {
        outcome = 'fail';
      }
    }

    const keep =
      outcome === 'pass' ? ++passes <= policy.keepPasses : ++failures <= policy.keepFailures;

    if (!keep) {
      rmSync(join(base, run), { recursive: true, force: true });
      removed.push(run);
    }
  }
  return removed;
}
