/**
 * The contracts every layer binds to. Changing anything here is a breaking
 * change for module authors, so it is deliberately small.
 */
import type { Page, BrowserContext } from 'playwright';

/**
 * Three outcomes, not two.
 *
 * `blocked` is the load-bearing one. Shakeout runs against real integrations,
 * so "TikTok's sandbox is down" and "our publish flow is broken" are different
 * events that a pass/fail model is forced to conflate. Conflating them trains
 * people to ignore red, and a suite nobody trusts gets disabled. Anything that
 * fails OUTSIDE the system under test is `blocked`, and blocked never fails CI.
 */
export type Outcome = 'pass' | 'fail' | 'blocked';

/**
 * Side effects a module produces in the real world. The runner uses these for
 * filtering (`--skip-effects external_publish`) so "run everything that does
 * not post to a real social platform" never requires a hand-maintained list.
 */
export type SideEffect =
  | 'db_write'
  | 'external_publish'
  | 'payment'
  | 'email'
  | 'file_upload'
  | 'none';

/** Preconditions the runner verifies BEFORE the browser opens. */
export interface ModuleRequires {
  /** Named session in the vault, e.g. 'qa_admin'. */
  session?: string;
  /** Connected third-party accounts that must already exist, e.g. ['tiktok_sandbox']. */
  connections?: string[];
  /** Subscription tier the acting user must be on. */
  plan?: string;
  /** Free-form gates a target adapter can interpret, e.g. { posts: '>=1' }. */
  data?: Record<string, string>;
}

/**
 * Declared cost. Real integrations have hard ceilings — a YouTube upload burns
 * ~1600 units of a 10,000/day quota, which is about six runs per day, total.
 * The scheduler cannot budget what modules do not declare.
 */
export interface ModuleCost {
  wallclockMs?: number;
  /** Quota units consumed, keyed by provider: { youtube: 1600 }. */
  quota?: Record<string, number>;
}

export interface ModuleManifest {
  /** Unique, filesystem-safe. Also the reporting/ subfolder name. */
  id: string;
  title: string;
  description?: string;
  requires?: ModuleRequires;
  cost?: ModuleCost;
  /** Required — declare `['none']` explicitly rather than omitting. */
  sideEffects: SideEffect[];
  tags?: string[];
}

export interface OracleResult {
  name: string;
  passed: boolean;
  /** Why it failed, in terms a human can act on. */
  detail?: string;
  /** Evidence pointer, e.g. 'network.har#request-42' or 'screenshots/03.png'. */
  evidence?: string;
}

/** What a module's functions receive. */
export interface RunContext {
  page: Page;
  context: BrowserContext;
  /** Resolved base URL for the active target. Already allowlist-checked. */
  baseUrl: string;
  /** Structured logging into the run folder. */
  log: (message: string, data?: Record<string, unknown>) => void;
  /** Capture a named screenshot into the run folder. */
  shot: (name: string) => Promise<void>;
  /**
   * Pause for a human to do something the agent cannot — complete a Google
   * OAuth consent, type a 2FA code, approve a sandbox payment. Opens headed,
   * waits, and records the resulting state into the vault so subsequent runs
   * skip it while the session is still valid.
   */
  human: (instruction: string, opts?: { timeoutMs?: number }) => Promise<void>;
  /** Absolute path to this run's artifact folder. */
  artifactDir: string;
}

/**
 * A module. `flow` is the manual-test; `teardown` is REQUIRED because with no
 * mocks every run leaves real artifacts behind — a real draft video, a real
 * transaction — and a suite that cannot clean up rots its own environment
 * within weeks. The loader refuses to load a module without one.
 */
export interface ShakeoutModule {
  manifest: ModuleManifest;
  /** Bring the world to the module's preconditions. May call ctx.human(). */
  setup?: (ctx: RunContext) => Promise<void>;
  /** The manual-test: click, type, upload, submit. */
  flow: (ctx: RunContext) => Promise<void>;
  /** Module-specific assertions. Global invariant oracles always also run. */
  oracles?: (ctx: RunContext) => Promise<OracleResult[]>;
  /** Destroy everything `flow` created. Runs even when `flow` throws. */
  teardown: (ctx: RunContext) => Promise<void>;
}

/** Identity helper that gives module authors inference without a decorator. */
export function defineModule(mod: ShakeoutModule): ShakeoutModule {
  return mod;
}

/** Signals "not our bug" — a dependency was unavailable. Yields `blocked`. */
export class BlockedError extends Error {
  readonly dependency?: string;
  constructor(message: string, dependency?: string) {
    super(message);
    this.name = 'BlockedError';
    this.dependency = dependency;
  }
}

export interface RunResult {
  moduleId: string;
  outcome: Outcome;
  target: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  oracles: OracleResult[];
  /** Populated when outcome is 'fail' or 'blocked'. */
  error?: { message: string; stack?: string };
  teardown: { ran: boolean; ok: boolean; error?: string };
  cost?: ModuleCost;
  artifactDir: string;
}
