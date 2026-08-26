/**
 * JUnit XML roll-up.
 *
 * GitLab and GitHub both ingest this format to build the per-MR test widget and
 * "newly failed" history. Without it a report is an opaque folder someone has
 * to go and open, which means a red run gets ignored and then switched off.
 *
 * `blocked` maps to <skipped>, deliberately: a dependency being down must not
 * fail the pipeline, but it must still be visible rather than silently absent.
 */
import { writeFileSync } from 'node:fs';
import type { RunResult } from '../core/types.js';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function toJUnitXml(results: RunResult[]): string {
  const failures = results.filter((r) => r.outcome === 'fail').length;
  const skipped = results.filter((r) => r.outcome === 'blocked').length;
  const totalTime = results.reduce((sum, r) => sum + r.durationMs, 0) / 1000;

  const cases = results
    .map((r) => {
      const time = (r.durationMs / 1000).toFixed(3);
      const head = `    <testcase classname="shakeout.${escapeXml(r.target)}" name="${escapeXml(r.moduleId)}" time="${time}">`;

      if (r.outcome === 'blocked') {
        const reason = r.error?.message ?? 'dependency unavailable';
        return `${head}\n      <skipped message="${escapeXml(reason)}"/>\n    </testcase>`;
      }

      if (r.outcome === 'fail') {
        const failed = r.oracles.filter((o) => !o.passed);
        const summary =
          r.error?.message ?? failed.map((o) => `${o.name}: ${o.detail ?? 'failed'}`).join('; ');
        const body = [
          r.error?.stack ?? '',
          ...failed.map((o) => `${o.name}: ${o.detail ?? ''} (${o.evidence ?? 'no evidence'})`),
          `artifacts: ${r.artifactDir}`,
        ]
          .filter(Boolean)
          .join('\n');
        return `${head}\n      <failure message="${escapeXml(summary)}">${escapeXml(body)}</failure>\n    </testcase>`;
      }

      return `${head}</testcase>`;
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites name="shakeout">',
    `  <testsuite name="shakeout" tests="${results.length}" failures="${failures}" skipped="${skipped}" time="${totalTime.toFixed(3)}">`,
    cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

export function writeJUnit(path: string, results: RunResult[]): void {
  writeFileSync(path, toJUnitXml(results), 'utf8');
}
