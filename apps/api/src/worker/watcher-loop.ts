import {
  matchPayment,
  type LinkRepository,
  type Logger,
  type PaymentLink,
  type WatcherPort,
  type WatcherStateRepository,
  NOOP_LOGGER,
} from "@checkout/core";
import { AnchorHealth, type LinkService } from "../services/link-service";
import { env } from "../env";
import { metrics } from "../metrics";

/** Horizon's own page size default (see `HorizonWatcher.fetchSince`) - kept in sync explicitly rather than duplicated as a bare number in two files. */
const DEFAULT_PAGE_LIMIT = 200;

/** Hard cap on pages drained per account per tick (issue 2.2) - bounds one tick's worst-case latency instead of looping until the backlog is empty, which could starve other accounts' ticks. Hitting this repeatedly is the signal to move to a streaming watcher (issue 2.1), not to raise this number further. */
const DEFAULT_MAX_PAGES_PER_TICK = 10;

/**
 * Per-account state for adaptive polling and circuit breaking.
 */
interface AccountState {
  consecutiveErrors: number;
  lastErrorTime: number;
  consecutiveIdleTicks: number;
  /** Ticks skipped since this account was last actually polled. */
  skippedTicks: number;
  lastActivityTime: number;
  isNewAccount: boolean;
  lastProcessedAt: number;
}

/**
 * How many ticks to skip between polls of an idle account.
 *
 * Bounded on purpose. The watcher only ever looks at destinations returned by
 * `activeDestinations()` — accounts that have an OPEN link — so an idle account
 * here is one where a buyer is being shown "waiting for payment" right now.
 * Stretching that interval indefinitely is indistinguishable from the product
 * being broken, which is exactly how it presented: a payment landed on-chain
 * with the correct memo and the checkout page sat spinning.
 */
function idleStride(consecutiveIdleTicks: number, backoffTicks: number): number {
  if (consecutiveIdleTicks < backoffTicks) return 1;
  const steps = Math.floor(consecutiveIdleTicks / Math.max(1, backoffTicks));
  return Math.min(MAX_IDLE_STRIDE, 1 + steps);
}

/** At the default 6s poll this caps the quiet-account interval at ~30s. */
const MAX_IDLE_STRIDE = 5;

/**
 * Circuit breaker status for a single account.
 */
export interface AccountCircuitBreakerStatus {
  account: string;
  isOpen: boolean;
  consecutiveErrors: number;
  lastErrorTime: number;
  cooldownUntil: number;
}

/**
 * Watcher metrics for observability.
 */
export interface WatcherMetrics {
  accountsWatched: number;
  tickDurationMs: number;
  perAccountLag: Map<string, number>;
  circuitBreakersOpen: number;
}

/**
 * Polling settlement watcher with bounded-concurrency fan-out and fairness.
 *
 * Each tick, we process accounts with:
 *   - Bounded concurrency (default 10) instead of sequential processing
 *   - Per-account adaptive intervals (back off idle, poll aggressive new links)
 *   - Per-account circuit breakers to isolate failing accounts
 *   - Fair round-robin cursor to prevent account starvation
 *   - Metrics for observability
 *
 * Idempotency is layered:
 *   1. the persisted cursor means we don't refetch already-seen operations;
 *   2. the processed-tx ledger guards the crash window before a cursor is saved;
 *   3. the domain transition guard means a duplicate can never double-apply.
 *
 * A single Horizon page is bounded by `pageLimit` (default 200, matching
 * `HorizonWatcher.fetchSince`'s own default). If more than `pageLimit`
 * payments landed since the last tick, `processAccount` keeps paging - up to
 * `maxPagesPerTick` pages - within the *same* tick, persisting the cursor
 * after every page (not once at the end), so a crash mid-drain resumes from
 * the last completed page rather than replaying the whole backlog.
 */
export class WatcherLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly pageLimit: number;
  private readonly maxPagesPerTick: number;
  private currentTick: Promise<void> | null = null;
  private accountStates = new Map<string, AccountState>();
  private roundRobinCursor = 0;
  private metrics: WatcherMetrics = {
    accountsWatched: 0,
    tickDurationMs: 0,
    perAccountLag: new Map(),
    circuitBreakersOpen: 0,
  };
  private lastTickCompletedAt = Date.now();

  constructor(
    private readonly deps: {
      watcher: WatcherPort;
      links: LinkRepository;
      state: WatcherStateRepository;
      service: LinkService;
      pollMs: number;
      logger?: Logger;
      pageLimit?: number;
      maxPagesPerTick?: number;
      log?: (msg: string) => void;
    },
  ) {
    this.deps.logger = this.deps.logger ?? NOOP_LOGGER;
    this.pageLimit = deps.pageLimit ?? DEFAULT_PAGE_LIMIT;
    this.maxPagesPerTick = deps.maxPagesPerTick ?? DEFAULT_MAX_PAGES_PER_TICK;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const scheduleNext = () => {
      if (!this.running) return;
      this.timer = setTimeout(tick, this.deps.pollMs);
    };
    const tick = () => {
      if (!this.running) return;
      this.currentTick = this.runOnce()
        .catch((err) => {
          this.deps.log?.(`watcher tick error: ${stringifyErr(err)}`);
        })
        .finally(() => {
          this.currentTick = null;
          scheduleNext();
        });
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Seconds since the last fully-completed poll tick, computed at call time. */
  getLagSeconds(): number {
    return (Date.now() - this.lastTickCompletedAt) / 1000;
  }

  /**
   * Get current circuit breaker status for all accounts.
   */
  getCircuitBreakerStatus(): AccountCircuitBreakerStatus[] {
    const now = Date.now();
    const statuses: AccountCircuitBreakerStatus[] = [];
    
    for (const [account, state] of this.accountStates.entries()) {
      const isOpen = this.isCircuitBreakerOpen(account, state, now);
      statuses.push({
        account: short(account),
        isOpen,
        consecutiveErrors: state.consecutiveErrors,
        lastErrorTime: state.lastErrorTime,
        cooldownUntil: state.lastErrorTime + env.watcherCircuitBreakerCooldownMs,
      });
    }
    
    return statuses;
  }

  /**
   * Get current watcher metrics.
   */
  getMetrics(): WatcherMetrics {
    return { ...this.metrics, perAccountLag: new Map(this.metrics.perAccountLag) };
  }

  async runOnce(): Promise<void> {
    const tickStart = Date.now();
    const allAccounts = await this.deps.links.activeDestinations();
    this.metrics.accountsWatched = allAccounts.length;
    metrics.accountsWatched.set(allAccounts.length);

    // Select accounts to process this tick using fair round-robin
    const accountsToProcess = this.selectAccountsForTick(allAccounts);
    
    // Process with bounded concurrency
    const concurrency = env.watcherConcurrency;
    const chunks = this.chunkArray(accountsToProcess, concurrency);
    
    for (const chunk of chunks) {
      await Promise.allSettled(
        chunk.map((account) => this.processAccountWithCircuitBreaker(account))
      );
    }

    // Update metrics
    const tickDuration = Date.now() - tickStart;
    this.metrics.tickDurationMs = tickDuration;
    this.metrics.circuitBreakersOpen = this.countOpenCircuitBreakers();
    metrics.watcherTickDurationSeconds.observe(tickDuration / 1000);

    // Update per-account lag
    const now = Date.now();
    for (const [account, state] of this.accountStates.entries()) {
      const lag = now - state.lastProcessedAt;
      this.metrics.perAccountLag.set(account, lag);
    }
    this.lastTickCompletedAt = now;

    // Expiry sweep runs AFTER payment matching, so a buyer who submitted within
    // TTL but whose on-chain confirmation lands after the deadline still settles
    // as `paid` rather than being rejected against an already-expired link.
    try {
      const moved = await this.deps.service.sweepExpired(Date.now());
      if (moved > 0) this.deps.log?.(`expiry sweep moved ${moved} link(s) to expired`);
    } catch (err) {
      this.deps.log?.(`expiry sweep error: ${stringifyErr(err)}`);
    }
  }

  /**
   * Select accounts for this tick using fair round-robin to prevent starvation.
   */
  private selectAccountsForTick(allAccounts: string[]): string[] {
    if (allAccounts.length === 0) return [];
    
    const maxPerTick = env.watcherMaxAccountsPerTick;
    if (allAccounts.length <= maxPerTick) {
      return allAccounts;
    }

    // Round-robin selection starting from cursor
    const selected: string[] = [];
    for (let i = 0; i < maxPerTick && i < allAccounts.length; i++) {
      const index = (this.roundRobinCursor + i) % allAccounts.length;
      const account = allAccounts[index];
      if (account !== undefined) {
        selected.push(account);
      }
    }

    // Advance cursor for next tick
    this.roundRobinCursor = (this.roundRobinCursor + maxPerTick) % allAccounts.length;
    
    return selected;
  }

  /**
   * Process account with circuit breaker protection.
   */
  private async processAccountWithCircuitBreaker(account: string): Promise<void> {
    const state = this.getOrCreateAccountState(account);
    const now = Date.now();

    // Check circuit breaker
    if (this.isCircuitBreakerOpen(account, state, now)) {
      this.deps.log?.(`watcher account ${short(account)} circuit breaker open, skipping`);
      return;
    }

    // Adaptive polling: poll an idle account less often, NEVER stop polling it.
    //
    // This used to `return` outright once the idle count passed the threshold,
    // and `consecutiveIdleTicks` is only ever reset inside `processAccount` —
    // which that return prevented from running. So an account went permanently
    // unwatched after ~10 idle ticks, and the counter just climbed (seen in
    // production at 183). Every payment arriving after the first minute of a
    // link's life was invisible until the process restarted.
    const stride = idleStride(state.consecutiveIdleTicks, env.watcherIdleBackoffTicks);
    if (stride > 1 && !state.isNewAccount) {
      state.skippedTicks++;
      if (state.skippedTicks < stride) {
        this.deps.log?.(
          `watcher account ${short(account)} quiet (${state.consecutiveIdleTicks} idle ticks), ` +
            `polling every ${stride} ticks`,
        );
        return;
      }
    }
    state.skippedTicks = 0;

    try {
      await this.processAccount(account, this.deps.logger!.child({ account }));
      
      // Reset error state on success
      state.consecutiveErrors = 0;
      state.lastActivityTime = now;
      state.isNewAccount = false;
      state.lastProcessedAt = now;
      
    } catch (err) {
      state.consecutiveErrors++;
      state.lastErrorTime = now;
      
      // Check if we should open circuit breaker
      if (state.consecutiveErrors >= env.watcherCircuitBreakerThreshold) {
        this.deps.log?.(
          `watcher account ${short(account)} circuit breaker opened after ${state.consecutiveErrors} errors`
        );
      }
      
      this.deps.log?.(`watcher account ${short(account)} error: ${stringifyErr(err)}`);
    }
  }

  /**
   * Check if circuit breaker is open for an account.
   */
  private isCircuitBreakerOpen(account: string, state: AccountState, now: number): boolean {
    if (state.consecutiveErrors < env.watcherCircuitBreakerThreshold) {
      return false;
    }
    
    const cooldownEnd = state.lastErrorTime + env.watcherCircuitBreakerCooldownMs;
    return now < cooldownEnd;
  }

  /**
   * Count currently open circuit breakers.
   */
  private countOpenCircuitBreakers(): number {
    const now = Date.now();
    let count = 0;
    
    for (const [account, state] of this.accountStates.entries()) {
      if (this.isCircuitBreakerOpen(account, state, now)) {
        count++;
      }
    }
    
    return count;
  }

  /**
   * Get or create account state.
   */
  private getOrCreateAccountState(account: string): AccountState {
    if (!this.accountStates.has(account)) {
      this.accountStates.set(account, {
        consecutiveErrors: 0,
        lastErrorTime: 0,
        consecutiveIdleTicks: 0,
        skippedTicks: 0,
        lastActivityTime: Date.now(),
        isNewAccount: true,
        lastProcessedAt: Date.now(),
      });
    }
    return this.accountStates.get(account)!;
  }

  /**
   * Split array into chunks of given size.
   */
  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  private async processAccount(account: string, log: Logger): Promise<void> {
    const cursor = await this.deps.state.getCursor(account);
    const state = this.getOrCreateAccountState(account);

    // First time we watch this account: seed the cursor to "now" so we only
    // react to payments that arrive after watching begins (no history replay).
    if (cursor === null) {
      const latest = await this.deps.watcher.latestCursor(account);
      await this.deps.state.setCursor(account, latest ?? "");
      log.info(
        { event: "watcher.account.seeded", fromCursor: null, toCursor: latest },
        "watcher account seeded",
      );
      return;
    }

    // Fetched once per account per tick, not once per page - the set of open
    // links doesn't change mid-drain (a payment landing this tick can't also
    // close a link before we've matched it), so re-fetching per page would
    // just be wasted I/O.
    const open = await this.deps.links.openLinksForDestination(account);
    const byRef = new Map<string, PaymentLink>(open.map((l) => [l.reference, l]));
    const byMuxedId = new Map<string, PaymentLink>(
      open.filter((l) => l.muxedId).map((l) => [l.muxedId as string, l]),
    );

    let pageCursor = cursor;

    for (let page = 1; page <= this.maxPagesPerTick; page++) {
      const payments = await this.deps.watcher.fetchSince(account, pageCursor, this.pageLimit);
      if (payments.length === 0) {
        // Nothing at all this tick counts as idle for the adaptive-polling
        // backoff; a partially-drained backlog does not.
        if (page === 1) state.consecutiveIdleTicks++;
        break;
      }
      state.consecutiveIdleTicks = 0;

      let lastToken = pageCursor;
      for (const payment of payments) {
        lastToken = payment.pagingToken;
        const child = log.child({ txHash: payment.txHash, pagingToken: payment.pagingToken });
        if (await this.deps.state.isProcessed(payment.txHash, payment.pagingToken)) {
          child.info({ event: "payment.duplicate" }, "skipping already-processed payment");
          continue;
        }

        const outcome = matchPayment(payment, (ref) => byRef.get(ref), (id) => byMuxedId.get(id));
        metrics.paymentsMatchedTotal.inc({ outcome: outcome.kind });
        const linkId =
          outcome.kind === "paid" || outcome.kind === "underpaid" || outcome.kind === "asset_mismatch"
            ? outcome.link.id
            : null;
        child.info(
          { event: "payment.matched", outcome: outcome.kind, linkId, amount: payment.amount, memo: payment.memo },
          `payment ${outcome.kind}`,
        );

        if (outcome.kind === "paid" || outcome.kind === "underpaid") {
          const becamePaid = await this.deps.service.applyMatch(payment, outcome, { logger: child });
          this.deps.log?.(
            `payment ${short(payment.txHash)} -> ${outcome.kind}` +
              (becamePaid ? ` (link ${linkId} PAID)` : ""),
          );
        } else if (
          outcome.kind === "unknown_reference" &&
          payment.memo &&
          payment.memoType !== "none"
        ) {
          // Memo matched nothing in the OPEN set. Before we give up, check
          // whether the memo belongs to a link that *used to* be open but has
          // since been expired or cancelled by the seller. If so, the buyer
          // paid a dead link: do NOT resurrect it, fire payment.unmatched so
          // the seller can refund the buyer out-of-band.
          const terminal = await this.deps.links.findByReference(payment.memo);
          if (
            terminal &&
            terminal.destination === account &&
            (terminal.status === "expired" || terminal.status === "cancelled")
          ) {
            await this.deps.service.recordUnmatchedPayment(payment, terminal);
            child.info(
              { event: "payment.unmatched", linkId: terminal.id, status: terminal.status },
              `payment unmatched against ${terminal.status} link ${terminal.id}`,
            );
          }
        }

        await this.deps.state.markProcessed(payment.txHash, payment.pagingToken, linkId);
      }

      pageCursor = lastToken;
      // Persisted after *every* page, not once at the end of the whole
      // drain - a crash between pages resumes from the last completed page
      // instead of replaying the entire backlog from the tick's start.
      await this.deps.state.setCursor(account, pageCursor);

      if (payments.length < this.pageLimit) {
        // Short page: caught up for this tick.
        return;
      }

      if (page === this.maxPagesPerTick) {
        const message =
          `watcher account ${short(account)} hit maxPagesPerTick (${this.maxPagesPerTick}) - ` +
          `backlog not fully drained this tick, more remains for the next poll. ` +
          `If this recurs, move this account to a streaming watcher (issue 2.1).`;
        this.deps.log?.(message);
        log.info({ event: "watcher.account.batch", account, maxPagesPerTick: this.maxPagesPerTick }, message);
      }
    }
  }
}

/** Periodically advance any pending seller cash-outs. */
export function startCashOutPoller(service: LinkService, intervalMs: number, logger?: Logger): () => void {
  const log = logger ?? NOOP_LOGGER;
  const pollerLogger = log.child({ component: "cashout-poller" });
  const timer = setInterval(() => {
    void service.pollCashOuts().catch((err) => {
      pollerLogger.error({ event: "cashout.tick.error", error: stringifyErr(err) }, "cash-out tick error");
    });
  }, intervalMs);
  return () => clearInterval(timer);
}

/**
 * Periodically retry attestation for settled links that don't have one.
 *
 * Deliberately its own timer rather than a rider on the cash-out poller: that
 * one runs every few seconds because a seller is waiting on it, whereas an
 * unattested receipt is a slow-moving backlog and hammering a Soroban RPC at
 * watcher cadence would be pure waste. `sweepUnattested` never rejects, so the
 * catch here is defensive only.
 */
export function startAttestationSweeper(
  service: LinkService,
  intervalMs: number,
  logger?: Logger,
): () => void {
  const log = (logger ?? NOOP_LOGGER).child({ component: "attestation-sweeper" });
  const timer = setInterval(() => {
    void service.sweepUnattested(20, { logger: log }).catch((err) => {
      log.error({ event: "attestation.sweep.error", error: stringifyErr(err) }, "attestation sweep error");
    });
  }, intervalMs);
  return () => clearInterval(timer);
}

/**
 * Periodically run the anchor health probe. First probe runs immediately so
 * the breaker state is correct on first request rather than after one interval
 * has elapsed. Probe failures never throw; AnchorHealth records every outcome.
 */
export function startAnchorProbeTimer(health: AnchorHealth, intervalMs: number): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      await health.probe();
    } catch {
      // AnchorHealth.probe() is contractually non-throwing; defensive only.
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

function short(s: string): string {
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}
function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}