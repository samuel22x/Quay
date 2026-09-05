import { createHmac } from "node:crypto";
import type { Logger } from "@checkout/core";
import { NOOP_LOGGER } from "@checkout/core";
import type { Webhook, WebhookRepository } from "@checkout/core";
import { decryptSecret } from "./secret-crypto";
import { newId } from "./ids";
import { metrics } from "../metrics";
import { guardWebhookUrl } from "./ssrf-guard";

const HOST_ALLOWLIST = process.env.WEBHOOK_HOST_ALLOWLIST
  ? process.env.WEBHOOK_HOST_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
  : undefined;

export interface WebhookEvent {
  event: string; // e.g. "link.paid"
  data: Record<string, unknown>;
}

/** Result of a single delivery attempt. */
export interface DeliveryOutcome {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
  /** True when retrying cannot help: 4xx (not 429), a 3xx, or a guard rejection. */
  permanent: boolean;
}

export interface WebhookSenderOptions {
  /** Total delivery attempts per hook before giving up (default 4). */
  maxAttempts?: number;
  /** Base backoff in ms; doubles each retry, with jitter (default 500). */
  baseDelayMs?: number;
  /** Per-request timeout in ms (default 8000). */
  timeoutMs?: number;
  /** Optional logger; emits one line per attempt (success / retry / terminal failure). */
  logger?: Logger;
  /** Cap on response body reads in bytes (default 64 KB). */
  maxResponseBytes?: number;
  /**
   * URL guard used at delivery time. Defaults to the real SSRF guard; tests
   * inject a permissive one so they can point at a loopback stub without
   * disabling the guard globally.
   */
  guard?: (url: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

/**
 * Delivers events to a seller's registered webhooks. The body is signed with
 * HMAC-SHA256 using the per-webhook secret, sent as `X-Checkout-Signature`.
 * Receivers verify by recomputing the HMAC over the exact raw body, and should
 * reject events whose in-body `sentAt` is too old (replay protection — `sentAt`
 * is inside the signed body, so it cannot be tampered with).
 *
 * If a secret was rotated less than 24h ago, the previous secret is also
 * accepted as a valid signer and both signatures are sent (see `deliver`) —
 * this is what makes rotation zero-downtime for the receiver.
 *
 * Delivery is retried with exponential backoff on transient failures (network
 * errors and 5xx / 429 responses). 4xx (other than 429) is treated as a
 * permanent failure and not retried. Only the final outcome is recorded.
 *
 * Security:
 *   - The URL is re-validated via guardWebhookUrl at delivery time to defeat
 *     DNS-rebinding attacks (the guard resolves the hostname and checks every
 *     returned address against private/reserved ranges).
 *   - redirect: "manual" — 3xx responses are treated as a failed attempt; the
 *     guard is NOT applied to redirect targets.
 *   - Response bodies are read up to maxResponseBytes and then discarded to
 *     prevent memory exhaustion.
 *
 * Production dispatch is durable: `enqueue` writes one `webhook_queue` row per
 * hook and returns, and WebhookWorker drains the queue with its own backoff, so
 * a crash mid-backoff no longer loses pending retries (issue #22). `deliverOnce`
 * is the single hardened attempt both paths share.
 *
 * `dispatch` is the older in-process path: one call delivers and retries inline.
 * Nothing in production calls it any more — the queue does — but it remains the
 * documented way to send an event synchronously, and every attempt-level rule
 * above is asserted against it.
 */
function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export class WebhookSender {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly maxResponseBytes: number;
  private readonly guard: NonNullable<WebhookSenderOptions["guard"]>;
  private inFlight = 0;

  constructor(
    private readonly repo: WebhookRepository,
    opts: WebhookSenderOptions = {},
  ) {
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.maxResponseBytes = opts.maxResponseBytes ?? 64 * 1024; // 64 KB
    this.guard = opts.guard ?? ((url: string) => guardWebhookUrl(url, { allowlist: HOST_ALLOWLIST }));
  }

  /** Deliveries currently in progress, including in-process retry backoff. */
  get inFlightCount(): number {
    return this.inFlight;
  }

  async dispatch(hooks: Webhook[], linkId: string, event: WebhookEvent, opts: { logger?: Logger } = {}): Promise<void> {
    const baseLog = opts.logger ?? this.logger;
    const body = JSON.stringify({ ...event, id: linkId, sentAt: new Date().toISOString() });

    await Promise.all(hooks.map((hook) => this.deliver(baseLog, hook, linkId, event.event, body)));
  }

  /**
   * Durable dispatch: freeze the body, write one queue row per hook, return.
   *
   * This never performs I/O against the receiver, so it cannot block the state
   * transition that produced the event. WebhookWorker picks the rows up and owns
   * every attempt from there.
   */
  async enqueue(hooks: Webhook[], linkId: string, event: WebhookEvent): Promise<void> {
    // The body is frozen here and re-sent verbatim on every attempt, so the
    // signed bytes — `sentAt` included — never change between retries.
    const body = JSON.stringify({ ...event, id: linkId, sentAt: new Date().toISOString() });
    const now = Date.now();

    await Promise.all(
      hooks.map((hook) =>
        this.repo.enqueue({
          id: newId("wqe"),
          webhookId: hook.id,
          linkId,
          event: event.event,
          payload: body,
          nextAttemptAt: now, // due immediately
          createdAt: now,
        }),
      ),
    );
  }

  /**
   * One delivery attempt, with every protection the in-process sender had:
   * delivery-time SSRF re-check, rotation-overlap dual signature, no redirect
   * following, and a capped response read.
   *
   * Records nothing — the caller owns the bookkeeping, because the queue worker
   * and `dispatch` record different things (every attempt vs. the final outcome).
   */
  async deliverOnce(hook: Webhook, event: string, body: string): Promise<DeliveryOutcome> {
    // Re-check the URL at delivery time: a hostname that resolved to a public
    // address at registration may resolve to an internal one now. This narrows
    // the DNS-rebinding window but does not close it — the fetch below still
    // resolves the hostname itself, so the connection is not pinned to the
    // address we checked. See the follow-up noted on PR #108.
    const guard = await this.guard(hook.url);
    if (!guard.ok) {
      return {
        ok: false,
        statusCode: null,
        error: `SSRF guard rejected URL at delivery: ${guard.reason}`,
        permanent: true,
      };
    }

    const signature = sign(decryptSecret(hook.secretEncrypted), body);

    // During the post-rotation overlap window, also sign with the previous
    // secret and send both — so a receiver that hasn't redeployed with the
    // new secret yet still verifies successfully, and drops no events.
    // Signatures are comma-separated in one header (`sha256=<new>,sha256=<old>`);
    // a receiver should accept the delivery if *any* listed signature matches.
    const stillInOverlap =
      hook.previousSecretEncrypted !== null &&
      hook.previousSecretExpiresAt !== null &&
      hook.previousSecretExpiresAt > Date.now();
    const signatureHeader = stillInOverlap
      ? `sha256=${signature},sha256=${sign(decryptSecret(hook.previousSecretEncrypted!), body)}`
      : `sha256=${signature}`;

    try {
      const res = await fetch(hook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-checkout-signature": signatureHeader,
          "x-checkout-event": event,
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
        // Never follow redirects: a 3xx is the classic way to walk an
        // allowed public host round to an internal one, and the guard is
        // not re-applied to redirect targets (issue #23 item 3).
        redirect: "manual",
      });

      // `redirect: "manual"` surfaces 3xx as an ordinary response rather
      // than following it. Treat it as a failed attempt, not a success.
      if (res.status >= 300 && res.status < 400) {
        metrics.webhookAttemptsTotal.inc({ result: "error" });
        await this.drainCapped(res);
        // A receiver redirecting us is a config error, not transient.
        return { ok: false, statusCode: res.status, error: `HTTP ${res.status} (redirect not followed)`, permanent: true };
      }

      await this.drainCapped(res);

      if (res.ok) {
        metrics.webhookAttemptsTotal.inc({ result: "ok" });
        return { ok: true, statusCode: res.status, error: null, permanent: false };
      }

      metrics.webhookAttemptsTotal.inc({ result: "error" });
      // 4xx (except 429) is a client error the receiver won't fix on retry.
      const permanent = res.status < 500 && res.status !== 429;
      return { ok: false, statusCode: res.status, error: `HTTP ${res.status}`, permanent };
    } catch (err) {
      metrics.webhookAttemptsTotal.inc({ result: "error" });
      return { ok: false, statusCode: null, error: err instanceof Error ? err.message : String(err), permanent: false };
    }
  }

  private async deliver(
    baseLog: Logger,
    hook: Webhook,
    linkId: string,
    event: string,
    body: string,
  ): Promise<void> {
    const child = baseLog.child({
      linkId,
      webhookId: hook.id,
      eventType: event,
      // We log the URL host only — the path might carry signed data the receiver
      // treats as sensitive, and we already record the link + event for grep.
      url: safeHost(hook.url),
    });

    let statusCode: number | null = null;
    let error: string | null = null;

    this.inFlight += 1;
    try {
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        const outcome = await this.deliverOnce(hook, event, body);
        statusCode = outcome.statusCode;
        error = outcome.error;

        if (outcome.ok) {
          child.info({ event: "webhook.attempt", attempt, statusCode, delivered: true }, "webhook delivered");
          await this.repo.recordDelivery({
            webhookId: hook.id,
            linkId,
            event,
            attempt,
            queueEntryId: null,
            statusCode,
            ok: true,
            error: null,
          });
          return;
        }

        if (outcome.permanent) {
          if (statusCode === null) {
            // Only the SSRF guard fails permanently without a status code.
            child.warn({ event: "webhook.failed", reason: error }, "SSRF guard rejected URL at delivery");
          }
          break;
        }

        const willRetry = attempt < this.maxAttempts;
        child.info(
          { event: "webhook.attempt", attempt, statusCode, error, delivered: false, willRetry },
          willRetry ? "webhook attempt failed, will retry" : "webhook attempt failed",
        );
        if (willRetry) await sleep(this.backoff(attempt));
      }

      child.warn({ event: "webhook.failed", statusCode, error }, "webhook delivery exhausted all attempts");
      await this.repo.recordDelivery({
        webhookId: hook.id,
        linkId,
        event,
        attempt: this.maxAttempts,
        queueEntryId: null,
        statusCode,
        ok: false,
        error,
      });
    } finally {
      this.inFlight -= 1;
    }
  }

  /**
   * Read at most `maxResponseBytes` of the body and discard it. Webhook
   * receivers are not supposed to return anything meaningful, and an
   * unbounded read is a memory-exhaustion vector (issue #23 item 4).
   */
  private async drainCapped(res: Response): Promise<void> {
    const body = res.body;
    if (!body) return;
    const reader = body.getReader();
    let read = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        read += value?.byteLength ?? 0;
        if (read > this.maxResponseBytes) {
          await reader.cancel();
          break;
        }
      }
    } catch {
      // A truncated/aborted body is not itself a delivery failure.
    }
  }

  /** Exponential backoff with full jitter. */
  private backoff(attempt: number): number {
    const ceiling = this.baseDelayMs * 2 ** (attempt - 1);
    return Math.floor(Math.random() * ceiling);
  }
}

/** Keep the host (and optional port); drop the path so a paranoid grep never lands on us. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<unparsable>";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

