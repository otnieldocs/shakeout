/**
 * Reference module — the anatomy every other module follows.
 *
 * Deliberately the simplest possible case: it signs in and confirms the app
 * renders an authenticated shell. Copy this shape, not its triviality — see the
 * teardown note at the bottom for what a module with real side effects owes.
 */
import { defineModule } from '../../src/index.js';
import type { OracleResult, RunContext } from '../../src/index.js';

export default defineModule({
  manifest: {
    id: 'example_login',
    title: 'A signed-out visitor can sign in and reach the app',
    description:
      'Smoke test for the authentication round-trip: the identity provider hands back a ' +
      'session, the app accepts it, and an authenticated shell renders.',

    requires: {
      // The runner looks this session up in the vault. If it is missing or
      // expired, setup() falls through to a human handoff (headed runs only).
      session: 'qa_user',
    },

    // Declared honestly: this module reads, it does not write. Anything that
    // creates data must say so — the runner filters runs on this.
    sideEffects: ['none'],

    cost: { wallclockMs: 30_000 },
    tags: ['smoke', 'auth'],
  },

  /** Bring the world to the module's preconditions. */
  async setup(ctx: RunContext) {
    await ctx.page.goto(ctx.baseUrl, { waitUntil: 'domcontentloaded' });

    // Already authenticated from a vaulted session? Nothing to do.
    const signedIn = await ctx.page
      .locator('[data-testid="user-menu"]')
      .isVisible()
      .catch(() => false);

    if (signedIn) {
      ctx.log('vaulted session is still good — skipping handoff');
      return;
    }

    // Otherwise ask the operator once. In a headless run this raises
    // BlockedError, so the outcome is `blocked` rather than a confusing `fail`.
    await ctx.human('Sign in as the QA user, then return here');
  },

  /** The manual-test itself. */
  async flow(ctx: RunContext) {
    await ctx.page.goto(`${ctx.baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
    await ctx.page.waitForLoadState('networkidle');
    await ctx.shot('dashboard');
  },

  /**
   * Module-specific assertions. The global invariants — no uncaught errors, no
   * console errors, no 5xx, no dead requests — always run on top of these, so
   * only assert what is specific to this journey.
   */
  async oracles(ctx: RunContext): Promise<OracleResult[]> {
    const results: OracleResult[] = [];

    const userMenu = await ctx.page
      .locator('[data-testid="user-menu"]')
      .isVisible()
      .catch(() => false);
    results.push({
      name: 'authenticated-shell-rendered',
      passed: userMenu,
      detail: userMenu ? undefined : 'user menu never appeared — session was not accepted',
      evidence: 'screenshots/',
    });

    // Not redirected back to the login wall.
    const url = ctx.page.url();
    const bounced = url.includes('/login') || url.includes('/signin');
    results.push({
      name: 'not-bounced-to-login',
      passed: !bounced,
      detail: bounced ? `landed on ${url}` : undefined,
    });

    return results;
  },

  /**
   * Required, even here.
   *
   * This module creates nothing, so there is nothing to destroy — but the
   * export is still mandatory, because "I forgot" and "there is genuinely
   * nothing" are indistinguishable to the loader, and only one of them is safe.
   * A module that uploads a video deletes that video here; one that creates a
   * subscription cancels it. Teardown runs even when flow() throws.
   */
  async teardown(ctx: RunContext) {
    ctx.log('nothing to tear down (sideEffects: none)');
  },
});
