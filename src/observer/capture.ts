/**
 * Capture layer: the raw evidence streams.
 *
 * With no mocks and no known-good fixtures, there is often no "expected value"
 * to compare a screen against. The captured streams ARE the assertion surface —
 * a 500 in the network log, an uncaught exception, a console error, a request
 * that never resolved. That class of defect needs no fixture to detect, and it
 * is precisely what unit tests are structurally blind to.
 *
 * Everything here writes through `redact.ts` before it reaches disk.
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { redactBody, redactHeaders, redactUrl } from './redact.js';

export interface ConsoleEvent {
  ts: string;
  type: string;
  text: string;
  url?: string;
}

export interface PageErrorEvent {
  ts: string;
  message: string;
  stack?: string;
}

export interface NetworkEvent {
  ts: string;
  method: string;
  url: string;
  status?: number;
  ok?: boolean;
  resourceType?: string;
  durationMs?: number;
  failure?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: unknown;
}

export interface Evidence {
  console: ConsoleEvent[];
  pageErrors: PageErrorEvent[];
  network: NetworkEvent[];
  screenshots: string[];
}

export interface ObserverOptions {
  /** Extra app-specific header/param/body keys to treat as secret. */
  extraSecretKeys?: string[];
  /** Record request bodies (redacted). Off by default — bodies are the most
   *  likely place for unlabelled PII to hide. */
  captureBodies?: boolean;
}

export class Observer {
  readonly evidence: Evidence = { console: [], pageErrors: [], network: [], screenshots: [] };

  private readonly streams: Record<string, WriteStream>;
  private shotCounter = 0;

  constructor(
    private readonly artifactDir: string,
    private readonly opts: ObserverOptions = {},
  ) {
    mkdirSync(join(artifactDir, 'screenshots'), { recursive: true });
    // Streams open at construction, i.e. at run START. A run that crashes
    // hard still leaves its evidence behind; the missing result.json is what
    // tells you the runner died rather than the module failing.
    this.streams = {
      console: createWriteStream(join(artifactDir, 'console.ndjson'), { flags: 'a' }),
      network: createWriteStream(join(artifactDir, 'network.ndjson'), { flags: 'a' }),
      errors: createWriteStream(join(artifactDir, 'page-errors.ndjson'), { flags: 'a' }),
      log: createWriteStream(join(artifactDir, 'run.log'), { flags: 'a' }),
    };
  }

  private write(stream: keyof typeof this.streams, payload: unknown): void {
    this.streams[stream]?.write(`${JSON.stringify(payload)}\n`);
  }

  /** Structured log line from the module or runner. */
  log(message: string, data?: Record<string, unknown>): void {
    const entry = { ts: new Date().toISOString(), message, ...(data ?? {}) };
    this.write('log', entry);
    console.log(`  · ${message}`);
  }

  attach(page: Page): void {
    const keys = this.opts.extraSecretKeys ?? [];

    page.on('console', (msg) => {
      const event: ConsoleEvent = {
        ts: new Date().toISOString(),
        type: msg.type(),
        text: msg.text().slice(0, 4000),
        url: msg.location()?.url ? redactUrl(msg.location().url, keys) : undefined,
      };
      this.evidence.console.push(event);
      this.write('console', event);
    });

    page.on('pageerror', (err) => {
      const event: PageErrorEvent = {
        ts: new Date().toISOString(),
        message: err.message,
        stack: err.stack,
      };
      this.evidence.pageErrors.push(event);
      this.write('errors', event);
    });

    page.on('requestfailed', (req) => {
      const event: NetworkEvent = {
        ts: new Date().toISOString(),
        method: req.method(),
        url: redactUrl(req.url(), keys),
        resourceType: req.resourceType(),
        failure: req.failure()?.errorText ?? 'unknown',
        requestHeaders: redactHeaders(req.headers(), keys),
      };
      this.evidence.network.push(event);
      this.write('network', event);
    });

    page.on('response', (res) => {
      const req = res.request();
      let durationMs: number | undefined;
      try {
        const t = req.timing();
        durationMs = t.responseEnd > 0 ? Math.round(t.responseEnd) : undefined;
      } catch {
        durationMs = undefined;
      }
      const event: NetworkEvent = {
        ts: new Date().toISOString(),
        method: req.method(),
        url: redactUrl(res.url(), keys),
        status: res.status(),
        ok: res.ok(),
        resourceType: req.resourceType(),
        durationMs,
        requestHeaders: redactHeaders(req.headers(), keys),
        responseHeaders: redactHeaders(res.headers(), keys),
        requestBody: this.opts.captureBodies
          ? redactBody(req.postData() ?? undefined, req.headers()['content-type'], keys)
          : undefined,
      };
      this.evidence.network.push(event);
      this.write('network', event);
    });
  }

  async shot(page: Page, name: string): Promise<void> {
    this.shotCounter += 1;
    const safe = name.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
    const file = `${String(this.shotCounter).padStart(2, '0')}-${safe}.png`;
    await page.screenshot({ path: join(this.artifactDir, 'screenshots', file), fullPage: false });
    this.evidence.screenshots.push(`screenshots/${file}`);
    this.log(`screenshot: ${file}`);
  }

  async close(): Promise<void> {
    await Promise.all(
      Object.values(this.streams).map(
        (s) => new Promise<void>((resolve) => s.end(() => resolve())),
      ),
    );
  }
}
