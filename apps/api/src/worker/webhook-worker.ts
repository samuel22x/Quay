import type { Webhook, WebhookQueueEntry, WebhookRepository } from "@checkout/core";
import type { WebhookSender } from "../services/webhook-sender";

export interface WebhookWorkerOptions {
  /**
   * Maximum delivery attempts before a queue entry is dead-lettered (default 5).
   * Attempt counts include the initial attempt, so 5 means 1 try + 4 retries.
   */
  maxAttempts?: number;
  /**
   * Base backoff in ms for exponential reschedule: delay = baseDelayMs * 2^(attempt-1)
   * with full jitter applied (default 5_000 ms → intervals ≈ 5 s, 10 s, 20 s, 40 s).
   */
  baseDelayMs?: number;
  /** How often the worker polls the queue (default 3_000 ms). */
  pollIntervalMs?: number;
  /** Max rows claimed per tick (default 20). */
  batchSize?: number;
  /**
   * How long a row may sit in 'claimed' before another worker may take it over
   * (default 120_000 ms). Must comfortably exceed the sender's request timeout,
   * or a slow-but-live delivery gets double-sent.
   */
  claimTimeoutMs?: number;
  log?: (msg: string) => void;
}

/**
 * Durable webhook delivery worker.
 *
 * On each tick the worker:
 *   1. Releases claims left behind by a worker that died mid-delivery.
 *   2. Claims up to `batchSize` pending entries whose next_attempt_at <= now.
 *   3. Delivers each through WebhookSender.deliverOnce, which owns the signing,
 *      the delivery-time SSRF re-check, and the redirect / response-size rules.
 *   4. On success            → status 'delivered'.
 *      On permanent failure  → status 'dead' (4xx except 429, a 3xx, guard reject).
 *      On transient failure  → status 'pending' with next_attempt_at backed off,
 *                              or 'dead' once maxAttempts is spent.
 *   5. Records *every* attempt in webhook_deliveries, not just the last.
 *
 * Retry state lives in the table, not in memory, so killing the process
 * mid-backoff loses nothing: the row is still pending and comes due again.
 */
export class WebhookWorker {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly claimTimeoutMs: number;
  private readonly log: (msg: string) => void;

  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly repo: WebhookRepository,
    private readonly sender: WebhookSender,
    opts: WebhookWorkerOptions = {},
  ) {
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
    this.baseDelayMs = opts.baseDelayMs ?? 5_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 3_000;
    this.batchSize = opts.batchSize ?? 20;
    this.claimTimeoutMs = opts.claimTimeoutMs ?? 120_000;
    this.log = opts.log ?? (() => {});
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try {
        await this.runOnce();
      } catch (err) {
        this.log(`webhook worker tick error: ${errMsg(err)}`);
      } finally {
        if (this.running) this.timer = setTimeout(tick, this.pollIntervalMs);
      }
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for testing: run one full reclaim → claim → deliver → update cycle. */
  async runOnce(): Promise<void> {
    const released = await this.repo.reclaimStale(Date.now() - this.claimTimeoutMs);
    if (released > 0) this.log(`released ${released} stale claim(s)`);

    const entries = await this.repo.claimDue(Date.now(), this.batchSize);
    if (entries.length === 0) return;

    // Resolve webhooks for all unique webhook IDs in this batch.
    const webhookIds = [...new Set(entries.map((e) => e.webhookId))];
    const hookMap = await this.resolveWebhooks(webhookIds);

    await Promise.all(entries.map((entry) => this.processEntry(entry, hookMap)));
  }

  private async processEntry(entry: WebhookQueueEntry, hookMap: Map<string, Webhook>): Promise<void> {
    const attemptNumber = entry.attempts + 1;
    const hook = hookMap.get(entry.webhookId);

    if (!hook) {
      // Webhook was hard-deleted after enqueue — nothing left to deliver to.
      this.log(`queue ${short(entry.id)}: webhook ${short(entry.webhookId)} not found, dead-lettering`);
      await this.finalise(entry, attemptNumber, null, false, "webhook not found", "dead");
      return;
    }

    const outcome = await this.sender.deliverOnce(hook, entry.event, entry.payload);

    if (outcome.ok) {
      await this.finalise(entry, attemptNumber, outcome.statusCode, true, null, "delivered");
      return;
    }

    if (outcome.permanent || attemptNumber >= this.maxAttempts) {
      await this.finalise(entry, attemptNumber, outcome.statusCode, false, outcome.error, "dead");
      return;
    }

    // Transient failure with attempts left: reschedule with backoff + full jitter.
    const delay = this.backoff(attemptNumber);
    this.log(
      `queue ${short(entry.id)} attempt ${attemptNumber} failed (${outcome.error ?? "unknown"}), ` +
        `retry in ${Math.round(delay / 1000)}s`,
    );
    await this.repo.updateQueueEntry(entry.id, {
      status: "pending",
      attempts: attemptNumber,
      nextAttemptAt: Date.now() + delay,
      lastStatusCode: outcome.statusCode,
      lastError: outcome.error,
    });
    await this.recordAttempt(entry, attemptNumber, outcome.statusCode, false, outcome.error);
  }

  private async finalise(
    entry: WebhookQueueEntry,
    attemptNumber: number,
    statusCode: number | null,
    ok: boolean,
    error: string | null,
    status: "delivered" | "dead",
  ): Promise<void> {
    const label = status === "delivered" ? "delivered" : "dead-lettered";
    this.log(
      `queue ${short(entry.id)} attempt ${attemptNumber} ${label}` +
        (statusCode !== null ? ` (HTTP ${statusCode})` : "") +
        (error ? ` — ${error}` : ""),
    );
    await this.repo.updateQueueEntry(entry.id, {
      status,
      attempts: attemptNumber,
      nextAttemptAt: entry.nextAttemptAt,
      lastStatusCode: statusCode,
      lastError: error,
    });
    await this.recordAttempt(entry, attemptNumber, statusCode, ok, error);
  }

  private async recordAttempt(
    entry: WebhookQueueEntry,
    attemptNumber: number,
    statusCode: number | null,
    ok: boolean,
    error: string | null,
  ): Promise<void> {
    await this.repo.recordDelivery({
      webhookId: entry.webhookId,
      linkId: entry.linkId,
      event: entry.event,
      attempt: attemptNumber,
      queueEntryId: entry.id,
      statusCode,
      ok,
      error,
    });
  }

  /**
   * Resolve Webhook objects for a set of webhook IDs.
   *
   * This is the one place that looks a webhook up without a seller in scope:
   * the worker runs outside any request, and the queue row is the authority on
   * which endpoint the event belongs to.
   */
  private async resolveWebhooks(ids: string[]): Promise<Map<string, Webhook>> {
    const map = new Map<string, Webhook>();
    await Promise.all(
      ids.map(async (id) => {
        const hook = await this.repo.findWebhookById(id);
        if (hook) map.set(id, hook);
      }),
    );
    return map;
  }

  /** Exponential backoff with full jitter: random in [0, baseDelayMs * 2^(attempt-1)]. */
  private backoff(attempt: number): number {
    const ceiling = this.baseDelayMs * 2 ** (attempt - 1);
    return Math.floor(Math.random() * ceiling);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function short(s: string): string {
  return s.length > 16 ? `${s.slice(0, 8)}…` : s;
}
