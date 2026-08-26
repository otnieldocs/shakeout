#!/usr/bin/env node
/**
 * shakeout — put the real thing through real conditions.
 *
 *   shakeout <module>            run one module
 *   shakeout list                list discovered modules
 *   shakeout auth <session>      capture a session via human handoff
 *   shakeout auth list|purge     inspect or revoke stored sessions
 *   shakeout report <module>     print the path to the latest run folder
 */
import { resolve } from 'node:path';
import { launch } from './controller/browser.js';
import { requestHuman } from './controller/human.js';
import { listModuleIds, loadModule } from './core/loader.js';
import { runModule } from './core/runner.js';
import type { RunResult, SideEffect } from './core/types.js';
import { writeJUnit } from './reporting/junit.js';
import { loadConfig, resolveTarget } from './targets/config.js';
import { assertTargetUsable } from './targets/allowlist.js';
import { SessionVault } from './vault/sessions.js';

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }

  return { command: positional[0] ?? 'help', positional: positional.slice(1), flags };
}

function usage(): void {
  console.log(`
shakeout — real browser, real data, real integrations. No mocks.

  shakeout <module> [options]     Run one module
  shakeout list                   List discovered modules
  shakeout auth <session>         Capture a session (opens headed, waits for you)
  shakeout auth list              Show stored sessions and their age
  shakeout auth purge [session]   Delete stored session(s)
  shakeout report <module>        Print path to the latest run folder

Options
  --target <name>        Target from your config (default: config.defaultTarget)
  --headed               Show the browser. Required for any human handoff.
  --modules-dir <path>   Where modules live (default: ./modules)
  --skip-effects <list>  Comma-separated side effects to refuse, e.g. external_publish
  --capture-bodies       Record request bodies (redacted). Off by default.
  --junit <path>         Also write a JUnit XML roll-up
`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help' || args.flags.help === true) {
    usage();
    return 0;
  }

  const config = await loadConfig();
  const modulesDir = resolve(String(args.flags['modules-dir'] ?? './modules'));
  const reportingDir = resolve(config.reportingDir ?? './reporting');
  const vaultDir = resolve(config.vaultDir ?? './.vault');
  const headed = args.flags.headed === true;

  if (args.command === 'list') {
    const ids = listModuleIds(modulesDir);
    if (ids.length === 0) {
      console.log(`No modules found in ${modulesDir}`);
      return 0;
    }
    console.log(`Modules in ${modulesDir}:\n`);
    for (const id of ids) {
      try {
        const mod = await loadModule(modulesDir, id);
        const effects = mod.manifest.sideEffects.join(', ');
        console.log(`  ${id.padEnd(28)} ${mod.manifest.title}`);
        console.log(`  ${''.padEnd(28)} effects: ${effects}`);
      } catch (err) {
        console.log(`  ${id.padEnd(28)} INVALID — ${(err as Error).message.split('\n')[0]}`);
      }
    }
    return 0;
  }

  if (args.command === 'auth') {
    const vault = new SessionVault(vaultDir);
    const sub = args.positional[0];

    if (sub === 'list' || sub === undefined) {
      const sessions = vault.list();
      if (sessions.length === 0) {
        console.log('No stored sessions.');
        return 0;
      }
      for (const s of sessions) {
        console.log(`  ${s.name.padEnd(20)} ${s.ageHours}h old  ${s.expired ? 'EXPIRED' : 'valid'}`);
      }
      return 0;
    }

    if (sub === 'purge') {
      vault.purge(args.positional[1]);
      console.log(args.positional[1] ? `Purged session "${args.positional[1]}".` : 'Purged all sessions.');
      return 0;
    }

    // shakeout auth <session> — capture via human handoff.
    const target = resolveTarget(config, args.flags.target as string | undefined);
    assertTargetUsable(target);
    const session = await launch(target, { headed: true });
    try {
      await session.page.goto(target.baseUrl, { waitUntil: 'domcontentloaded' });
      await requestHuman(session.page, `Log in as "${sub}" on ${target.baseUrl}`, { headed: true });
      vault.save(sub, await session.context.storageState());
      console.log(`\nSaved session "${sub}".`);
    } finally {
      await session.close();
    }
    return 0;
  }

  if (args.command === 'report') {
    const id = args.positional[0];
    if (!id) {
      console.error('Usage: shakeout report <module>');
      return 2;
    }
    console.log(resolve(reportingDir, id, 'latest'));
    return 0;
  }

  // Default: run a module.
  const moduleId = args.command;
  const target = resolveTarget(config, args.flags.target as string | undefined);
  const mod = await loadModule(modulesDir, moduleId);

  const skipEffects = String(args.flags['skip-effects'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as SideEffect[];

  const blockedBy = mod.manifest.sideEffects.filter((e) => skipEffects.includes(e));
  if (blockedBy.length > 0) {
    console.log(`Skipping "${moduleId}" — declares side effect(s): ${blockedBy.join(', ')}`);
    return 0;
  }

  const result: RunResult = await runModule(mod, {
    target,
    reportingDir,
    vaultDir,
    headed,
    captureBodies: args.flags['capture-bodies'] === true,
  });

  if (args.flags.junit) {
    writeJUnit(resolve(String(args.flags.junit)), [result]);
  }

  const failed = result.oracles.filter((o) => !o.passed);
  console.log(`\n  ${result.outcome.toUpperCase()}  ${moduleId}  (${result.durationMs}ms)`);
  for (const oracle of failed) {
    console.log(`    ✗ ${oracle.name}: ${oracle.detail ?? ''}`);
  }
  console.log(`  artifacts: ${result.artifactDir}\n`);

  // blocked never fails CI — a dependency being down is not a defect.
  return result.outcome === 'fail' ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: Error) => {
    console.error(`\n[shakeout] ${err.name}: ${err.message}\n`);
    process.exit(2);
  });
