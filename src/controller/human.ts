/**
 * Human handoff.
 *
 * Some steps an agent cannot do and should not try: a Google OAuth consent
 * screen that fights automation, a 2FA code, a sandbox payment approval. Rather
 * than pretending otherwise, Shakeout makes the handoff a first-class,
 * resumable step — the operator does it once, the resulting state goes into the
 * vault, and subsequent runs skip it until it expires.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Page } from 'playwright';
import { BlockedError } from '../core/types.js';

/** Injects a banner so the operator knows which account to use. */
export async function showBanner(page: Page, instruction: string): Promise<void> {
  try {
    await page.evaluate((text: string) => {
      const existing = document.getElementById('shakeout-banner');
      if (existing) existing.remove();
      const el = document.createElement('div');
      el.id = 'shakeout-banner';
      el.setAttribute(
        'style',
        'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:14px 20px;' +
          'background:#1d4ed8;color:#fff;font:600 16px/1.4 system-ui,sans-serif;text-align:center;' +
          'box-shadow:0 2px 8px rgba(0,0,0,.35)',
      );
      el.textContent = `SHAKEOUT — ${text}`;
      document.body.prepend(el);
    }, instruction);
  } catch {
    // A banner is a courtesy. If the page is mid-navigation or CSP blocks the
    // injection, the terminal prompt still carries the instruction.
  }
}

export interface HumanOptions {
  timeoutMs?: number;
  headed: boolean;
}

/**
 * Blocks until the operator confirms. Returns normally on confirmation, throws
 * BlockedError if the run cannot accept a handoff at all (headless), so the
 * outcome is `blocked` rather than a misleading `fail`.
 */
export async function requestHuman(
  page: Page,
  instruction: string,
  opts: HumanOptions,
): Promise<void> {
  if (!opts.headed) {
    throw new BlockedError(
      `This module needs a human step ("${instruction}") but the run is headless.\n` +
        `Complete it once in a headed run — \`shakeout auth <session> --headed\` — ` +
        `and the saved session will carry subsequent headless runs.`,
      'human',
    );
  }

  await showBanner(page, instruction);

  const line = [
    '',
    '  ┌────────────────────────────────────────────────────────────',
    '  │ SHAKEOUT NEEDS YOU',
    `  │ ${instruction}`,
    '  │',
    '  │ Complete it in the open browser, then press Enter here.',
    '  └────────────────────────────────────────────────────────────',
    '',
  ].join('\n');
  stdout.write(line);

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const timeout = opts.timeoutMs ?? 10 * 60 * 1000;
    await Promise.race([
      rl.question('  Press Enter when done… '),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new BlockedError(`Human handoff timed out after ${timeout}ms`, 'human')),
          timeout,
        ),
      ),
    ]);
  } finally {
    rl.close();
  }
}
