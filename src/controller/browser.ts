/**
 * Browser control — the agent's hands.
 *
 * Also where the allowlist stops being advice and starts being enforcement: a
 * document request to an unlisted origin is ABORTED, not merely logged.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { AllowlistError, assertOriginAllowed } from '../targets/allowlist.js';
import type { Target } from '../targets/types.js';

export interface LaunchOptions {
  headed: boolean;
  /** Path to a Playwright storageState file from the vault. */
  storageStatePath?: string;
  viewport?: { width: number; height: number };
  slowMoMs?: number;
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Origins a document request was refused for. Surfaced as an oracle. */
  allowlistViolations: string[];
  close: () => Promise<void>;
}

export async function launch(target: Target, opts: LaunchOptions): Promise<BrowserSession> {
  const browser = await chromium.launch({
    headless: !opts.headed,
    slowMo: opts.slowMoMs,
  });

  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1440, height: 900 },
    storageState: opts.storageStatePath,
  });

  const allowlistViolations: string[] = [];

  /*
   * NAVIGATION-scoped enforcement. Subresources are deliberately left alone:
   * flows legitimately emit third-party requests (GA4, Meta Pixel, fonts), and
   * asserting on those beacons is a supported feature. Blocking them would
   * break the very modules that verify event tracking.
   */
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (request.resourceType() !== 'document') {
      await route.continue();
      return;
    }
    try {
      assertOriginAllowed(target, request.url());
      await route.continue();
    } catch (err) {
      if (err instanceof AllowlistError) {
        const origin = safeOrigin(request.url());
        if (!allowlistViolations.includes(origin)) allowlistViolations.push(origin);
        console.error(`[shakeout] BLOCKED navigation to ${origin} — not in allowedOrigins`);
        await route.abort('blockedbyclient');
        return;
      }
      throw err;
    }
  });

  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    allowlistViolations,
    close: async () => {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
