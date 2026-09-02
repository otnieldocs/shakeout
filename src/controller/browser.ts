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
  /**
   * Attach to a browser Shakeout did NOT start, over the Chrome DevTools
   * Protocol — `ws://host:port/devtools/browser/<id>`.
   *
   * This is what makes a human handoff possible on a headless host. Shakeout
   * deliberately does not provision remote desktops: how the browser becomes
   * visible (VNC, a hosted Chrome, a tunnel to your laptop) is an infrastructure
   * decision, and bundling one would hand every adopter a remote-access surface
   * they did not ask for. Exposing the browser is your problem; driving it is ours.
   *
   * Implies headed: a browser someone can watch is the only reason to connect.
   */
  browserWsEndpoint?: string;
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
  /*
   * OWNERSHIP: close what you opened, and nothing else.
   *
   * A connected browser outlives the run — it is somebody's long-running
   * session, quite possibly the one they just signed into by hand. Calling
   * browser.close() on it would tear that down and make the vaulted session
   * a one-shot, which defeats the point of connecting at all.
   */
  const weOwnTheBrowser = opts.browserWsEndpoint === undefined;

  const browser = weOwnTheBrowser
    ? await chromium.launch({ headless: !opts.headed, slowMo: opts.slowMoMs })
    : await chromium.connectOverCDP(opts.browserWsEndpoint as string);

  /*
   * ⚠️ When attached, REUSE the browser's existing context — do not create one.
   *
   * The human signs in to the window they can actually see, which lives in the
   * browser's default context. A fresh newContext() is isolated from it, so
   * storageState() returns ZERO cookies and the vault records a session that
   * authenticates nobody — while `shakeout auth` prints "Saved session".
   *
   * Measured, not assumed: after a login in the default context,
   * context.storageState() there had 1 cookie and a sibling newContext() had 0.
   */
  const attachedContext = weOwnTheBrowser ? undefined : browser.contexts()[0];
  const weOwnTheContext = attachedContext === undefined;

  if (attachedContext !== undefined && opts.storageStatePath !== undefined) {
    // A vaulted session cannot be injected into a context that already exists.
    // Say so rather than silently ignoring it and running as the wrong user.
    console.warn(
      '[shakeout] attached to a running browser, so the vaulted session was NOT ' +
        'applied — the browser\'s own session is used instead.',
    );
  }

  const context =
    attachedContext ??
    (await browser.newContext({
      viewport: opts.viewport ?? { width: 1440, height: 900 },
      storageState: opts.storageStatePath,
    }));

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

  // Reuse the tab the human is looking at, so they can watch what happens.
  const page = attachedContext ? (attachedContext.pages()[0] ?? (await context.newPage())) : await context.newPage();

  return {
    browser,
    context,
    page,
    allowlistViolations,
    close: async () => {
      // Same ownership rule as the browser: close only what we created. An
      // attached context belongs to the running browser, and closing it would
      // destroy the session the human just established.
      if (weOwnTheContext) await context.close().catch(() => undefined);
      // Only close a browser we started. See the ownership note in launch().
      // A connected browser is deliberately left running — it is not ours, and
      // it is very likely the session a human just authenticated in. Playwright
      // drops the CDP connection when this process exits.
      if (weOwnTheBrowser) await browser.close().catch(() => undefined);
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
