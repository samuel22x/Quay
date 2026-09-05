import {
  fromStroops,
  toStroops,
  type AssetRef,
  type CreateLinkInput,
  type KycPort,
  type KycRecord,
  type LinkPaymentRecord,
  type LinkRepository,
  type OffRampInitiation,
  type OffRampJob,
  type OffRampMode,
  type OffRampPort,
  type OffRampQuote,
  type OffRampStateRepository,
  type OffRampTelemetryRepository,
  type OffRampTelemetryRow,
  type OffRampTelemetrySummary,
  type PaymentLink,
  type PayoutFieldDescriptor,
  type SellerPayoutRef,
  type StoredOffRampJob,
  type StoredOffRampQuote,
  type Webhook,
  type WebhookDelivery,
  type WebhookQueueEntry,
  type WebhookRepository,
} from "@checkout/core";
import { encryptSecret } from "../src/services/secret-crypto";

const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export function makeLink(over: Partial<PaymentLink> = {}): PaymentLink {
  return {
    id: "lnk_1",
    reference: "pl_ref1",
    sellerId: "sel_1",
    destination: DEST,
    muxedId: null,
    title: "Test",
    amount: "10",
    asset: { code: "USDC", issuer: ISSUER },
    status: "paid",
    txHash: "tx1",
    payer: "GBUYER",
    paidAmount: "10",
    overpaidAmount: null,
    offrampJobId: null,
    offrampTargetCurrency: null,
    offrampStatus: null,
    offrampIndicativeRate: null,
    offrampRate: null,
    offrampRateDelta: null,
    offrampFeeAmount: null,
    offrampFeeCurrency: null,
    offrampFeeSource: null,
    offrampNetTargetAmount: null,
    attestationContractId: null,
    attestationTxHash: null,
    attestationLedger: null,
    attestedAt: null,
    expiresAt: null,
    isDemo: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** In-memory LinkRepository, seeded from a fixed list of links. */
export class FakeLinkRepository implements LinkRepository {
  private readonly byId = new Map<string, PaymentLink>();
  private readonly payments: LinkPaymentRecord[] = [];
  private readonly seenTxHashes = new Set<string>();

  constructor(seed: PaymentLink[] = []) {
    for (const l of seed) this.byId.set(l.id, l);
  }

  async create(input: CreateLinkInput): Promise<PaymentLink> {
    const link: PaymentLink = {
      ...input,
      offrampIndicativeRate: null,
      offrampRate: null,
      offrampRateDelta: null,
      offrampFeeAmount: null,
      offrampFeeCurrency: null,
      offrampFeeSource: null,
      offrampNetTargetAmount: null,
      attestationContractId: null,
      attestationTxHash: null,
      attestationLedger: null,
      attestedAt: null,
      status: "active",
      txHash: null,
      payer: null,
      paidAmount: null,
      overpaidAmount: null,
      offrampJobId: null,
      offrampTargetCurrency: null,
      offrampStatus: null,
      isDemo: input.isDemo ?? false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.byId.set(link.id, link);
    return link;
  }

  async findById(id: string): Promise<PaymentLink | null> {
    return this.byId.get(id) ?? null;
  }

  async findByReference(reference: string): Promise<PaymentLink | null> {
    return [...this.byId.values()].find((l) => l.reference === reference) ?? null;
  }

  async listBySeller(sellerId: string): Promise<PaymentLink[]> {
    return [...this.byId.values()].filter((l) => l.sellerId === sellerId);
  }

  async listByStatus(status: PaymentLink["status"]): Promise<PaymentLink[]> {
    return [...this.byId.values()].filter((l) => l.status === status);
  }

  async activeDestinations(): Promise<string[]> {
    return [...new Set([...this.byId.values()].map((l) => l.destination))];
  }

  async openLinksForDestination(destination: string): Promise<PaymentLink[]> {
    return [...this.byId.values()].filter(
      (l) => l.destination === destination && (l.status === "active" || l.status === "underpaid"),
    );
  }

  async save(link: PaymentLink): Promise<void> {
    this.byId.set(link.id, { ...link });
  }

  async recordPayment(payment: LinkPaymentRecord): Promise<void> {
    if (this.seenTxHashes.has(payment.txHash)) return; // duplicate tx_hash — no-op
    this.seenTxHashes.add(payment.txHash);
    this.payments.push(payment);
  }

  async sumPaymentsForLink(linkId: string): Promise<string> {
    const total = this.payments
      .filter((p) => p.linkId === linkId)
      .reduce((sum, p) => sum + toStroops(p.amount), 0n);
    return fromStroops(total);
  }

  async paymentLedger(txHash: string): Promise<number | null> {
    return this.payments.find((p) => p.txHash === txHash)?.ledger ?? null;
  }

  async listUnattested(limit: number): Promise<PaymentLink[]> {
    return [...this.byId.values()]
      .filter(
        (l) =>
          l.txHash !== null &&
          l.attestedAt === null &&
          ["paid", "offramp_pending", "offramp_settled", "offramp_failed"].includes(l.status),
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
  }

  get(id: string): PaymentLink | undefined {
    return this.byId.get(id);
  }
}

export class FakeWebhookRepository implements WebhookRepository {
  readonly deliveries: WebhookDelivery[] = [];
  /** Exposed so queue tests can assert on row state directly. */
  readonly queue: WebhookQueueEntry[] = [];
  private readonly hooks: Webhook[] = [];

  async create(input: { sellerId: string; url: string; secret: string }): Promise<Webhook> {
    const hook: Webhook = {
      id: `whk_${this.hooks.length}`,
      sellerId: input.sellerId,
      url: input.url,
      secretEncrypted: encryptSecret(input.secret),
      secretLast4: input.secret.slice(-4),
      previousSecretEncrypted: null,
      previousSecretLast4: null,
      previousSecretExpiresAt: null,
      deletedAt: null,
      createdAt: Date.now(),
    };
    this.hooks.push(hook);
    return hook;
  }

  async findWebhookById(id: string): Promise<Webhook | null> {
    return this.hooks.find((h) => h.id === id) ?? null;
  }

  async enqueue(
    e: Omit<WebhookQueueEntry, "attempts" | "status" | "lastStatusCode" | "lastError" | "updatedAt">,
  ): Promise<WebhookQueueEntry> {
    const row: WebhookQueueEntry = {
      ...e,
      attempts: 0,
      status: "pending",
      lastStatusCode: null,
      lastError: null,
      updatedAt: e.createdAt,
    };
    this.queue.push(row);
    return row;
  }

  /** Mirrors the Drizzle claim: only rows this call transitions are returned. */
  async claimDue(now: number, limit: number): Promise<WebhookQueueEntry[]> {
    const claimed: WebhookQueueEntry[] = [];
    for (const row of this.queue) {
      if (claimed.length >= limit) break;
      if (row.status !== "pending" || row.nextAttemptAt > now) continue;
      row.status = "claimed";
      row.updatedAt = Date.now();
      claimed.push({ ...row });
    }
    return claimed;
  }

  async updateQueueEntry(
    id: string,
    patch: Pick<WebhookQueueEntry, "status" | "attempts" | "nextAttemptAt" | "lastStatusCode" | "lastError">,
  ): Promise<void> {
    const row = this.queue.find((r) => r.id === id);
    if (!row) return;
    Object.assign(row, patch, { updatedAt: Date.now() });
  }

  async findQueueEntry(id: string): Promise<WebhookQueueEntry | null> {
    const row = this.queue.find((r) => r.id === id);
    return row ? { ...row } : null;
  }

  async reclaimStale(claimedBefore: number): Promise<number> {
    let released = 0;
    for (const row of this.queue) {
      if (row.status !== "claimed" || row.updatedAt >= claimedBefore) continue;
      row.status = "pending";
      row.updatedAt = Date.now();
      released += 1;
    }
    return released;
  }

  async countPending(): Promise<number> {
    return this.queue.filter((r) => r.status === "pending" || r.status === "claimed").length;
  }

  async listDeliveriesByLinkId(linkId: string): Promise<WebhookDelivery[]> {
    return this.deliveries.filter((d) => d.linkId === linkId);
  }

  async listBySeller(sellerId: string): Promise<Webhook[]> {
    return this.hooks.filter((h) => h.sellerId === sellerId && h.deletedAt === null);
  }

  async getById(id: string, sellerId: string, opts?: { includeDeleted?: boolean }): Promise<Webhook | null> {
    const hook = this.hooks.find((h) => h.id === id && h.sellerId === sellerId);
    if (!hook) return null;
    if (hook.deletedAt !== null && !opts?.includeDeleted) return null;
    return hook;
  }

  async rotateSecret(id: string, sellerId: string, newSecret: string, overlapMs: number): Promise<Webhook | null> {
    const hook = await this.getById(id, sellerId);
    if (!hook) return null;
    hook.previousSecretEncrypted = hook.secretEncrypted;
    hook.previousSecretLast4 = hook.secretLast4;
    hook.previousSecretExpiresAt = Date.now() + overlapMs;
    hook.secretEncrypted = encryptSecret(newSecret);
    hook.secretLast4 = newSecret.slice(-4);
    return hook;
  }

  async softDelete(id: string, sellerId: string): Promise<boolean> {
    const hook = await this.getById(id, sellerId);
    if (!hook) return false;
    hook.deletedAt = Date.now();
    return true;
  }

  async recordDelivery(d: Omit<WebhookDelivery, "id" | "createdAt">): Promise<void> {
    this.deliveries.push({ ...d, id: `whd_${this.deliveries.length}`, createdAt: Date.now() });
  }

  async listDeliveries(
    webhookId: string,
    sellerId: string,
    opts: { limit: number; cursor?: string | null },
  ): Promise<{ deliveries: WebhookDelivery[]; nextCursor: string | null }> {
    const owned = await this.getById(webhookId, sellerId, { includeDeleted: true });
    if (!owned) return { deliveries: [], nextCursor: null };
    const matching = this.deliveries
      .filter((d) => d.webhookId === webhookId)
      .sort((a, b) => b.createdAt - a.createdAt);
    return { deliveries: matching.slice(0, opts.limit), nextCursor: null };
  }
}

/** In-memory OffRampStateRepository — same shape as the Drizzle one, no DB. */
export class FakeOffRampStateRepository implements OffRampStateRepository {
  private readonly quotes = new Map<string, StoredOffRampQuote>();
  private readonly jobs = new Map<string, StoredOffRampJob>();

  async saveQuote(quote: StoredOffRampQuote): Promise<void> {
    this.quotes.set(quote.quoteId, quote);
  }

  async getQuote(quoteId: string): Promise<StoredOffRampQuote | null> {
    return this.quotes.get(quoteId) ?? null;
  }

  async saveJob(job: StoredOffRampJob): Promise<void> {
    this.jobs.set(job.jobId, job);
  }

  async getJob(jobId: string): Promise<StoredOffRampJob | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async updateJob(
    jobId: string,
    patch: Partial<Pick<StoredOffRampJob, "targetAmount" | "status" | "externalStatus" | "lastError">>,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.jobs.set(jobId, { ...job, ...patch, updatedAt: Date.now() });
  }
}

/** Fully scripted OffRampPort: each method call is driven by a queued/fixed handler. */
export class ScriptedOffRamp implements OffRampPort {
  readonly mode: OffRampMode = "seller_initiated";
  statusImpl: (jobId: string) => Promise<OffRampJob> = () => {
    throw new Error("statusImpl not configured");
  };
  quoteImpl?: (input: { linkId: string; sourceAsset: AssetRef; sourceAmount: string; targetCurrency: string }) => Promise<OffRampQuote>;
  initiateImpl?: (input: { linkId: string; quoteId: string; payout: SellerPayoutRef }) => Promise<OffRampInitiation>;

  async quote(input: { linkId: string; sourceAsset: AssetRef; sourceAmount: string; targetCurrency: string }): Promise<OffRampQuote> {
    if (this.quoteImpl) return this.quoteImpl(input);
    throw new Error("quoteImpl not configured");
  }
  async initiate(input: { linkId: string; quoteId: string; payout: SellerPayoutRef }): Promise<OffRampInitiation> {
    if (this.initiateImpl) return this.initiateImpl(input);
    throw new Error("initiateImpl not configured");
  }
  async status(jobId: string): Promise<OffRampJob> {
    return this.statusImpl(jobId);
  }
  async offrampRequirements(): Promise<PayoutFieldDescriptor[]> {
    return [];
  }
}

/** KYC gate that's always ACCEPTED — mirrors `NoKycRequired`, used by tests
 *  that aren't exercising the KYC gate itself. */
export class AlwaysAcceptedKyc implements KycPort {
  async status(sellerId: string): Promise<KycRecord> {
    return this.accepted(sellerId);
  }
  async submit(sellerId: string): Promise<KycRecord> {
    return this.accepted(sellerId);
  }
  private accepted(sellerId: string): KycRecord {
    return {
      sellerId,
      customerId: null,
      status: "ACCEPTED",
      requiredFields: [],
      providedFields: {},
      message: null,
      lastSyncedAt: null,
      updatedAt: Date.now(),
    };
  }
}

/** Fully scripted KycPort for testing the cash-out gate itself. */
export class ScriptedKyc implements KycPort {
  statusImpl: (sellerId: string) => Promise<KycRecord> = () => {
    throw new Error("statusImpl not configured");
  };
  async status(sellerId: string): Promise<KycRecord> {
    return this.statusImpl(sellerId);
  }
  async submit(sellerId: string): Promise<KycRecord> {
    return this.statusImpl(sellerId);
  }
}

/** In-memory OffRampTelemetryRepository. Captures the rows the service writes
 *  so tests can assert on the passive telemetry trail without a database. */
export class FakeTelemetryRepository implements OffRampTelemetryRepository {
  readonly rows: OffRampTelemetryRow[] = [];

  async upsert(row: OffRampTelemetryRow): Promise<void> {
    const existing = this.rows.findIndex((r) => r.id === row.id);
    if (existing === -1) this.rows.push({ ...row });
    else this.rows[existing] = { ...row };
  }

  async summary(): Promise<OffRampTelemetrySummary[]> {
    return [];
  }

  async all(): Promise<OffRampTelemetryRow[]> {
    return [...this.rows];
  }
}
