import type { AssetRef, PaymentLink } from "../domain/payment-link";
import type { NormalizedPayment } from "../matching/match-payment";
import type { Logger } from "./logger";

export type { Logger } from "./logger";
export { NOOP_LOGGER } from "./logger";

// ---------------------------------------------------------------------------
// Settlement rail port
// ---------------------------------------------------------------------------
// Builds the payer-facing payment request. The Stellar adapter implements this
// with SEP-7; a different chain would implement it differently — the domain
// never sees chain-specific types.

export interface PaymentRequest {
  uri: string; // e.g. a SEP-7 web+stellar:pay URI
  destination: string;
  amount: string;
  asset: AssetRef;
  memo: string | null; // correlation reference echoed back on-chain; null in muxed mode
}

export interface RailPort {
  /** Build a payment request a wallet can fulfill. */
  buildRequest(input: {
    destination: string;
    amount: string;
    asset: AssetRef;
    reference: string;
    /** SEP-23 muxed id. When present, the rail encodes it into an M-address
     *  destination and omits the memo instead of using MEMO_TEXT correlation. */
    muxedId?: string | null;
    message?: string;
  }): PaymentRequest;

  /** Validate that a string is a usable destination address for this rail. */
  isValidDestination(address: string): boolean;

  /**
   * Throws `CannotReceiveError` if `account` cannot currently receive `asset` —
   * the account doesn't exist yet, or (for issued assets) has no trustline, an
   * unauthorized one, or one already at its limit. Resolves silently if it can.
   * Implementations should cache a short TTL per (account, asset) so calling
   * this on every link creation stays cheap.
   */
  assertCanReceive(account: string, asset: AssetRef): Promise<void>;
}

export type CannotReceiveReason =
  | "account_not_found" // not yet created/funded on-chain
  | "no_trustline" // issued asset, no trustline established
  | "trustline_not_authorized" // trustline exists but the issuer froze/deauthorized it
  | "trustline_limit_exceeded"; // trustline exists but is already full

/** Raised by `RailPort.assertCanReceive`. `trustlineUri` (when present) is a
 *  rail-specific "fix it" deep link — e.g. a SEP-7 `tx` URI wrapping an unsigned
 *  changeTrust operation the seller's wallet can sign directly. */
export class CannotReceiveError extends Error {
  constructor(
    readonly reason: CannotReceiveReason,
    message: string,
    readonly trustlineUri?: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Settlement watcher port
// ---------------------------------------------------------------------------
// Pulls new incoming payments for an account since a cursor. Polling keeps the
// MVP restart-safe and simple; a streaming impl can satisfy the same port.

export interface WatcherPort {
  /** Most-recent paging token for an account, used to seed a fresh watch. */
  latestCursor(account: string): Promise<string | null>;

  /** Incoming payments to `account` strictly after `cursor`, oldest-first. */
  fetchSince(account: string, cursor: string, limit?: number): Promise<NormalizedPayment[]>;
}

// ---------------------------------------------------------------------------
// Off-ramp port  ← the seam this whole product is built around
// ---------------------------------------------------------------------------
// `seller_initiated`: the seller receives the stablecoin to their own wallet and
//   later triggers a cash-out. Custody stays at the edges. This is the MVP mode.
// `inline`: value is routed through the anchor mid-flight so the seller receives
//   local currency directly. This is what merchants want — and it is the mode that
//   puts you in the money-transmission / custody bucket. Do not enable it until a
//   licensed anchor relationship and a compliance story are real.
//
// Interface shape mirrors the Stellar SEP standards you'd wire underneath:
//   quote()    ~ SEP-38 (firm FX quote with an expiry; transfers in-flight rate risk)
//   initiate() ~ SEP-24 / SEP-31 (start a withdrawal/payout to local rails)
//   status()   ~ poll the transfer to settlement

/** Describes a single field the anchor needs before initiating a payout. */
export interface PayoutFieldDescriptor {
  /** Machine-readable field name, e.g. "dest", "dest_extra". */
  name: string;
  /** Human-readable label from the anchor, e.g. "Bank Account Number". */
  label: string;
  /** Optional longer explanation shown beneath the input. */
  description?: string;
  /** When true, the field may be omitted. */
  optional: boolean;
  /** If present, the field is a select/radio rather than a free-text input. */
  choices?: string[];
}

export type OffRampMode = "seller_initiated" | "inline";

export interface OffRampQuote {
  quoteId: string;
  sourceAsset: AssetRef;
  sourceAmount: string;
  targetCurrency: string; // ISO code, e.g. "NGN"
  targetAmount: string; // gross amount before fees
  rate: string; // sourceAsset -> targetCurrency
  expiresAt: number; // epoch ms — after this the quote is void
  fee: { amount: string; currency: string; source: "anchor" | "estimated" };
  netTargetAmount: string; // what the seller actually receives
}

/** Thrown when a quote's expiresAt has passed or is unparsable (NaN). */
export class QuoteExpiredError extends Error {
  constructor(readonly quoteId: string) {
    super(`Quote ${quoteId} has expired`);
    this.name = "QuoteExpiredError";
  }
}

/**
 * Returns true when a quote is expired or has an unparsable expiresAt (NaN).
 * NaN comparisons always return false in JS, so we must guard explicitly.
 */
export function isQuoteExpired(quote: OffRampQuote, now: number = Date.now()): boolean {
  if (Number.isNaN(quote.expiresAt)) return true;
  return now >= quote.expiresAt;
}

/** Where the seller wants their local-currency payout to land. */
export interface SellerPayoutRef {
  currency: string; // "NGN"
  // Opaque to the domain; an anchor adapter interprets these (bank/account,
  // routing, etc.). NOT identity/KYC data — that's `KycPort`, submitted once
  // per seller ahead of time, never derived from a cash-out request.
  fields: Record<string, string>;
}

export type OffRampJobStatus = "pending" | "settled" | "failed";

export interface OffRampJob {
  jobId: string;
  linkId: string;
  status: OffRampJobStatus;
  targetCurrency: string;
  targetAmount: string;
  rate: string;
  reason?: string; // set when failed
}

export type OffRampInitiation =
  | { kind: "fields"; jobId: string }
  | { kind: "interactive"; jobId: string; url: string };

export interface OffRampPort {
  readonly mode: OffRampMode;
  quote(
    input: { linkId: string; sourceAsset: AssetRef; sourceAmount: string; targetCurrency: string },
    opts?: { logger?: Logger },
  ): Promise<OffRampQuote>;
  initiate(
    input: { linkId: string; quoteId: string; payout: SellerPayoutRef },
    opts?: { logger?: Logger },
  ): Promise<OffRampInitiation>;
  /** Throws {@link OffRampJobNotFoundError} when `jobId` has no known state — a
   *  crash/redeploy wiped an in-memory-only implementation, or the id is bogus. */
  status(jobId: string, opts?: { logger?: Logger }): Promise<OffRampJob>;
  /**
   * Indicative prices for all available buy currencies — SEP-38 GET /prices.
   * Unauthenticated, no quote consumed. Used by the dashboard to show rates
   * before the seller commits to a firm quote (issue 3.5).
   * Optional: adapters that cannot provide indicative pricing may omit this.
   */
  indicativePrices?(input: {
    sourceAsset: AssetRef;
    sourceAmount: string;
  }): Promise<IndicativePrice[]>;
  /**
   * Field descriptors the anchor requires before it will initiate a payout —
   * SEP-6 GET /info for a real anchor, a fixed set for the mock. Drives the
   * dynamic cash-out form (issue #32) so the dashboard never hardcodes bank
   * fields.
   */
  offrampRequirements(assetCode: string): Promise<PayoutFieldDescriptor[]>;
}

/** One indicative price entry from SEP-38 GET /prices (issue 3.5). */
export interface IndicativePrice {
  /** ISO-4217 buy currency, e.g. "NGN". */
  targetCurrency: string;
  /** Indicative exchange rate: 1 sourceAsset unit = `price` targetCurrency units. */
  price: string;
  /** Delivery methods advertised by the anchor, e.g. ["WIRE"]. */
  deliveryMethods: string[];
}

/** Typed miss for {@link OffRampPort.status}, so callers (the cash-out poller)
 *  can tell "this job's state is genuinely gone" apart from a transient
 *  network/anchor error and act on it — see `OffRampStateRepository`. */
export class OffRampJobNotFoundError extends Error {
  constructor(readonly jobId: string) {
    super(`Unknown off-ramp job: ${jobId}`);
    this.name = "OffRampJobNotFoundError";
  }
}

/**
 * Thrown by every method of a deliberately disabled off-ramp adapter
 * (`OFFRAMP=none`), so routes can answer 501 rather than 500.
 *
 * Distinct from "the anchor is down", which is a 502 and is retried. This says
 * the deployment has no cash-out leg at all: sellers are paid directly on-chain
 * and move their own funds. Nothing about it is transient, so nothing should
 * retry it.
 */
export class OffRampDisabledError extends Error {
  constructor(operation: string) {
    super(
      `Off-ramp is disabled on this deployment (OFFRAMP=none); "${operation}" is unavailable. ` +
        "Payments settle directly to the seller's wallet.",
    );
    this.name = "OffRampDisabledError";
  }
}

// ---------------------------------------------------------------------------
// Off-ramp state persistence
// ---------------------------------------------------------------------------
// Quotes and jobs are money-adjacent state: a cash-out sits in `offramp_pending`
// for real seconds-to-days while an anchor settles it, so this cannot live only
// in an adapter's in-process Map — a restart must not strand the seller's money.

export interface StoredOffRampQuote {
  quoteId: string;
  linkId: string;
  /** SEP-6 withdraw type resolved at quote time. `initiate()` must reuse it —
   *  quoting for one rail and withdrawing on another is how a seller ends up
   *  paid at a rate that was never quoted for their actual payout method. */
  withdrawType?: string;
  sellAsset: AssetRef;
  sellAmount: string;
  buyCurrency: string;
  price: string;
  expiresAt: number;
  createdAt: number;
}

export interface StoredOffRampJob {
  jobId: string;
  linkId: string;
  anchor: string; // which OffRampPort adapter owns this job, e.g. "mock" | "testanchor"
  targetCurrency: string;
  targetAmount: string;
  rate: string;
  status: OffRampJobStatus;
  externalStatus: string | null; // raw upstream status string, for debugging
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface OffRampStateRepository {
  saveQuote(quote: StoredOffRampQuote): Promise<void>;
  getQuote(quoteId: string): Promise<StoredOffRampQuote | null>;
  saveJob(job: StoredOffRampJob): Promise<void>;
  getJob(jobId: string): Promise<StoredOffRampJob | null>;
  updateJob(
    jobId: string,
    patch: Partial<Pick<StoredOffRampJob, "targetAmount" | "status" | "externalStatus" | "lastError">>,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Off-ramp telemetry port
// ---------------------------------------------------------------------------
// Passive, append-only dataset of cash-out progress. No product surface
// consumes it yet; it exists to accumulate the dataset — cheap to record now,
// impossible to backfill later. Writes must never block the cash-out path.

export type OffRampTelemetryStatus = "quoted" | "initiated" | "settled" | "failed";

export interface OffRampTelemetryRow {
  id: string;
  anchorDomain: string;
  corridor: string; // e.g. "USDC/NGN"
  sellAsset: string;
  sellAmount: string;
  /** In-memory mock/testanchor rate at quote time, if available. */
  indicativeRate: string | null;
  /** The firm rate returned by quote(). */
  quotedRate: string;
  quotedAt: number;
  initiatedAt: number | null;
  settledAt: number | null;
  /** Derived from the anchor-reported amount_out at settlement (NOT the quote). */
  effectiveRate: string | null;
  /** sell_amount minus the anchor-implied back-calculated sell equivalent. */
  feeAmount: string | null;
  status: OffRampTelemetryStatus;
  failureReason: string | null;
}

export interface OffRampTelemetrySummary {
  anchorDomain: string;
  corridor: string;
  count: number;
  settledCount: number;
  failedCount: number;
  /** p50 settlement latency in ms (null when no settled rows). */
  latencyP50Ms: number | null;
  /** p95 settlement latency in ms (null when no settled rows). */
  latencyP95Ms: number | null;
  /** mean of (quotedRate - effectiveRate) / quotedRate, as a fraction (null when no data). */
  meanSpread: number | null;
}

export interface OffRampTelemetryRepository {
  upsert(row: OffRampTelemetryRow): Promise<void>;
  summary(): Promise<OffRampTelemetrySummary[]>;
  /** Anonymised dump — seller/link identities excluded — for CSV export. */
  all(): Promise<OffRampTelemetryRow[]>;
}

// ---------------------------------------------------------------------------
// KYC port (SEP-12)
// ---------------------------------------------------------------------------
// No real anchor will pay out against fabricated identity data, so this is
// modeled as its own lifecycle — separate from a cash-out request — keyed by
// seller, never by link: one seller can hold many links, but their identity
// is submitted once and reused. `seller_initiated` mode still needs it for
// the anchor's own compliance requirements, even though custody never moves
// through us.

export type KycStatus = "unsubmitted" | "NEEDS_INFO" | "PROCESSING" | "ACCEPTED" | "REJECTED";

export interface KycFieldSpec {
  name: string; // e.g. "first_name"
  type: string; // anchor-defined: "string" | "date" | "binary" | "number" | ...
  description?: string;
  optional: boolean;
  choices?: string[];
}

export interface KycRecord {
  sellerId: string;
  /** Anchor-assigned customer id, once one exists — reused on later GET/PUT
   *  calls instead of re-resolving by account, per SEP-12. */
  customerId: string | null;
  status: KycStatus;
  /** Latest field requirements discovered from the anchor. Empty once ACCEPTED. */
  requiredFields: KycFieldSpec[];
  /** Values we have on file for this seller. PII — never log, never put on a
   *  webhook payload or a `/links` response; encrypted at rest by the repo. */
  providedFields: Record<string, string>;
  /** Anchor's status/rejection message, verbatim. */
  message: string | null;
  lastSyncedAt: number | null;
  updatedAt: number;
}

/** Thrown by {@link KycPort.submit} when required fields are missing, naming
 *  exactly which ones — the API layer maps this to `422 kyc_required`. */
export class KycRequiredError extends Error {
  constructor(readonly missingFields: string[]) {
    super(`Missing required KYC fields: ${missingFields.join(", ")}`);
    this.name = "KycRequiredError";
  }
}

export interface KycPort {
  /** Refreshes from the anchor (if applicable) and persists the result. */
  status(sellerId: string): Promise<KycRecord>;
  /** Submits/updates fields. Throws {@link KycRequiredError} if a required
   *  field is still missing after merging with what's already on file. */
  submit(sellerId: string, fields: Record<string, string>): Promise<KycRecord>;
}

/** Persistence for `KycRecord`, keyed by seller. `providedFields` is PII and
 *  must be encrypted at rest by the implementation. */
export interface KycRepository {
  get(sellerId: string): Promise<KycRecord | null>;
  save(record: KycRecord): Promise<void>;
}

// ---------------------------------------------------------------------------
// Attestation port
// ---------------------------------------------------------------------------
// Quay tells a seller their invoice was paid. Without this port that claim
// lives only in Quay's own database, so a receipt is exactly as trustworthy as
// whoever runs the API — an odd thing to ask of a checkout whose whole point is
// that it never touches the money. An attester publishes the settlement fact
// somewhere the operator cannot quietly rewrite, and a receipt becomes
// verifiable without asking Quay anything.
//
// The port deals only in strings and numbers. The Soroban implementation lives
// in `packages/soroban`; the domain never learns that a contract is involved,
// let alone which chain hosts it.
//
// Attestation is never on the settlement path. A link becomes `paid` because a
// payment landed on the classic ledger, and nothing here may change that — an
// attester that is down, unfunded, or unconfigured degrades a receipt to "not
// yet attested" and nothing more.

/** What the attester recorded, and where a third party can go to see it. */
export interface AttestationRef {
  /** Registry the attestation was written to (a Soroban contract id today). */
  contractId: string;
  /**
   * Hash of the transaction that WROTE the attestation — not the payment's own
   * transaction. The payment hash is already on `PaymentLink.txHash`; these are
   * two different facts on two different ledgers and conflating them makes a
   * receipt unverifiable.
   *
   * Null when the attestation was found already present rather than written by
   * this call: the registry stores the fact, not the transaction that carried
   * it, so that hash is genuinely unavailable. `attestedAt` still comes from
   * the registry, so the receipt remains verifiable.
   */
  txHash: string | null;
  /**
   * Ledger sequence the attestation was written in — null alongside a null
   * `txHash`, for the same reason. Note this is NOT the ledger the payment
   * settled in; that one is on the receipt the registry hands back.
   */
  ledger: number | null;
  /** Epoch ms the attestation was recorded. */
  attestedAt: number;
}

/** A settlement fact, as read back out of the registry by anyone. */
export interface AttestationReceipt {
  /** Classic-ledger transaction that delivered the payment. */
  paymentTxHash: string;
  amount: string;
  assetCode: string;
  /** Issuer address, or null for native. */
  assetIssuer: string | null;
  /** Classic ledger sequence the payment settled in. */
  ledger: number;
  /** Epoch ms, as recorded by the registry itself. */
  attestedAt: number;
  /** Who vouched for it. A verifier decides whether it trusts this identity,
   *  exactly as it decides whether to trust an asset issuer. */
  attester: string;
}

export interface AttestationPort {
  /** The registry being written to — surfaced on receipts so a verifier knows
   *  where to look, and so a later redeploy can't invalidate old receipts. */
  readonly contractId: string;

  /**
   * Record that a payment settled against `reference`.
   *
   * Implementations must treat "already attested" as success, not failure: the
   * sweep re-attempts links whose first attestation attempt failed, and a
   * duplicate must not thrash. Any other failure throws — the caller is
   * expected to swallow it and leave the link unattested for the next sweep.
   */
  attest(input: {
    reference: string;
    txHash: string;
    amount: string;
    assetCode: string;
    assetIssuer: string | null;
    ledger: number;
  }): Promise<AttestationRef>;

  /** Read an attestation back. Null when the reference was never attested. */
  verify(reference: string): Promise<AttestationReceipt | null>;
}

// ---------------------------------------------------------------------------
// Repository ports
// ---------------------------------------------------------------------------

export interface CreateLinkInput {
  id: string;
  reference: string;
  sellerId: string;
  destination: string;
  muxedId: string | null;
  title: string;
  amount: string;
  asset: AssetRef;
  expiresAt: number | null;
  /** When true this row was created by the demo seed script. */
  isDemo?: boolean;
}

/** One incoming payment recorded against a link — the authoritative ledger
 *  row cumulative accounting sums over (issue 1.4). Unique on
 *  `(txHash, operationId)`, not `txHash` alone (issue 4.11): a transaction
 *  can carry more than one payment operation to the same link (a split
 *  payment), and each must be recorded, not dropped as a false duplicate of
 *  the other. A reprocessed *operation* still never double-counts. */
export interface LinkPaymentRecord {
  linkId: string;
  txHash: string;
  /** The chain's per-operation identifier (Horizon's `pagingToken`). */
  operationId: string;
  payer: string;
  amount: string;
  asset: AssetRef;
  /** Ledger sequence the payment settled in — the attestation names it, and the
   *  retry sweep has no other way to recover it after the watcher tick is gone. */
  ledger: number;
  createdAt: number;
}

export interface LinkRepository {
  create(input: CreateLinkInput): Promise<PaymentLink>;
  findById(id: string): Promise<PaymentLink | null>;
  findByReference(reference: string): Promise<PaymentLink | null>;
  listBySeller(sellerId: string): Promise<PaymentLink[]>;
  /** All links currently in a given status (used by the cash-out poller). */
  listByStatus(status: PaymentLink["status"]): Promise<PaymentLink[]>;
  /**
   * Settled links that carry a payment but no attestation yet (issue 9.2),
   * oldest first, capped at `limit`. Drives the retry sweep: the first
   * attestation attempt happens inline on settlement and is allowed to fail,
   * so this is the path by which a link written while the registry was
   * unreachable eventually gets attested anyway.
   */
  listUnattested(limit: number): Promise<PaymentLink[]>;
  /** Distinct destination addresses that currently have at least one active link. */
  activeDestinations(): Promise<string[]>;
  /** Active (or underpaid) links whose value lands in `destination`. */
  openLinksForDestination(destination: string): Promise<PaymentLink[]>;
  save(link: PaymentLink): Promise<void>;
  /** Append a payment to the link's ledger. A duplicate `(txHash, operationId)`
   *  is a no-op — cumulative accounting must never double-count a reprocessed
   *  operation. Two *different* operations that happen to share a `txHash`
   *  (a split payment) are two rows, not one (issue 4.11). */
  recordPayment(payment: LinkPaymentRecord): Promise<void>;
  /** Sum of every payment ever recorded for this link, as a decimal string
   *  ("0" if none). The authoritative source `paidAmount` is cached from. */
  sumPaymentsForLink(linkId: string): Promise<string>;
  /** Ledger a recorded payment settled in; null if the tx isn't on the ledger
   *  table, or predates the column. */
  paymentLedger(txHash: string): Promise<number | null>;
}

export interface Seller {
  id: string;
  name: string;
  wallet: string;
  /**
   * The seller's last-used payout destination fields (e.g. bank account).
   * Null until the seller completes their first cash-out. Treated as
   * sensitive — never logged or included in webhook payloads.
   */
  payoutFields: Record<string, string> | null;
  createdAt: number;
}

export interface SellerRepository {
  getDefault(): Promise<Seller>;
  findById(id: string): Promise<Seller | null>;
  findByWallet(wallet: string): Promise<Seller | null>;
  /** Wallet-native signup: SEP-10 proved control of `wallet`, so it IS the identity.
   *  Idempotent — returns the existing seller if one is already registered for it. */
  createIfAbsent(wallet: string): Promise<Seller>;
  /** Persist the seller's last-used payout destination fields for reuse on the
   *  next cash-out (issue #32). Sensitive — never logged or webhook'd. */
  savePayoutFields(sellerId: string, fields: Record<string, string>): Promise<void>;
}

/**
 * A registered webhook endpoint.
 *
 * The signing secret is never stored in plaintext — only `secretEncrypted`
 * (reversible, AES-256-GCM; the platform must be able to decrypt it to sign
 * outgoing deliveries) plus `secretLast4` for display. API routes must never
 * serialize `secretEncrypted` / `previousSecretEncrypted` in a response; the
 * raw secret is only ever returned once, directly from `create`/`rotateSecret`,
 * before it's encrypted for storage.
 */
export interface Webhook {
  id: string;
  sellerId: string;
  url: string;
  secretEncrypted: string;
  secretLast4: string;
  /** Set during the 24h post-rotation overlap window; null otherwise. */
  previousSecretEncrypted: string | null;
  previousSecretLast4: string | null;
  previousSecretExpiresAt: number | null;
  deletedAt: number | null;
  createdAt: number;
}

/** Fields safe to return from any API route — never includes secret material. */
export type PublicWebhook = Omit<Webhook, "secretEncrypted" | "previousSecretEncrypted">;

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  linkId: string;
  event: string;
  /** Which attempt number (1-based). */
  attempt: number;
  /** ID of the queue entry this delivery belongs to. Null for rows written
   *  before the durable queue existed. */
  queueEntryId: string | null;
  statusCode: number | null;
  ok: boolean;
  error: string | null;
  createdAt: number;
}

/** Lifecycle status of a queue entry. */
export type WebhookQueueStatus = "pending" | "claimed" | "delivered" | "dead";

/**
 * One row in webhook_queue — the durable representation of a pending delivery.
 * Immutable fields are set at enqueue time; mutable fields are updated by the
 * worker after each attempt.
 */
export interface WebhookQueueEntry {
  id: string;
  webhookId: string;
  linkId: string;
  event: string;
  /** The signed JSON body, serialised once at enqueue time. */
  payload: string;
  attempts: number;
  nextAttemptAt: number; // epoch ms
  status: WebhookQueueStatus;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WebhookRepository {
  create(input: { sellerId: string; url: string; secret: string }): Promise<Webhook>;
  /** Active (non-deleted) webhooks for a seller. Used for both dispatch and listing. */
  listBySeller(sellerId: string): Promise<Webhook[]>;
  /** Scoped to the owning seller to prevent cross-tenant access (IDOR). */
  getById(id: string, sellerId: string, opts?: { includeDeleted?: boolean }): Promise<Webhook | null>;
  /**
   * Unscoped lookup by id. Only for the delivery worker, which runs outside any
   * request and therefore has no seller context; never reachable from a route.
   */
  findWebhookById(id: string): Promise<Webhook | null>;
  /**
   * Rotates the signing secret. The previous secret remains valid for
   * `overlapMs` so in-flight receivers can be redeployed without dropping
   * events (see WebhookSender, which signs with both during the overlap).
   */
  rotateSecret(id: string, sellerId: string, newSecret: string, overlapMs: number): Promise<Webhook | null>;
  /** Soft delete — keeps delivery history browsable after removal. */
  softDelete(id: string, sellerId: string): Promise<boolean>;
  recordDelivery(d: Omit<WebhookDelivery, "id" | "createdAt">): Promise<void>;
  listDeliveries(
    webhookId: string,
    sellerId: string,
    opts: { limit: number; cursor?: string | null },
  ): Promise<{ deliveries: WebhookDelivery[]; nextCursor: string | null }>;

  // --- Queue operations ---
  /** Insert a new pending queue entry. */
  enqueue(entry: Omit<WebhookQueueEntry, "attempts" | "status" | "lastStatusCode" | "lastError" | "updatedAt">): Promise<WebhookQueueEntry>;
  /**
   * Atomically claim up to `limit` rows that are due for delivery.
   * "Due" means status = 'pending' AND next_attempt_at <= now.
   * Returns only the rows successfully claimed by this process (status → 'claimed').
   */
  claimDue(now: number, limit: number): Promise<WebhookQueueEntry[]>;
  /** Persist the result of one delivery attempt onto the queue entry. */
  updateQueueEntry(
    id: string,
    patch: Pick<WebhookQueueEntry, "status" | "attempts" | "nextAttemptAt" | "lastStatusCode" | "lastError">,
  ): Promise<void>;
  /** Look up a single queue entry by id (for replay). */
  findQueueEntry(id: string): Promise<WebhookQueueEntry | null>;
  /**
   * Return rows stuck in 'claimed' since before `claimedBefore` to 'pending'.
   * A worker that dies mid-delivery leaves its claim behind; without this the
   * row is never due again and the event is silently lost — the exact failure
   * the durable queue exists to prevent. Returns how many rows were released.
   */
  reclaimStale(claimedBefore: number): Promise<number>;
  /** Rows still awaiting delivery (pending or claimed). Feeds the queue-depth gauge. */
  countPending(): Promise<number>;
  listDeliveriesByLinkId(linkId: string): Promise<WebhookDelivery[]>;
}

/**
 * Watcher bookkeeping: per-account cursor + processed-payment ledger for
 * idempotency.
 *
 * Keyed by operation, not transaction (issue 4.11): a Stellar transaction can
 * carry up to 100 operations, and a payment is one operation, not the whole
 * transaction. `operationId` is the chain's per-operation identifier (Horizon's
 * `pagingToken` for Stellar) — two payment operations sharing one `txHash`
 * (a split payment, or a batch that happens to pay two different watched
 * destinations) must dedupe independently, not collide on the shared hash.
 */
export interface WatcherStateRepository {
  getCursor(account: string): Promise<string | null>;
  setCursor(account: string, cursor: string): Promise<void>;
  isProcessed(txHash: string, operationId: string): Promise<boolean>;
  markProcessed(txHash: string, operationId: string, linkId: string | null): Promise<void>;
}

/** Session-JWT revocation, keyed by the token's own `jti` — logout and
 *  compromise both work by revoking a specific token id, not by invalidating
 *  every session for a seller. */
export interface TokenRevocationRepository {
  /** `expiresAt` (epoch seconds) mirrors the token's own `exp`, so expired
   *  revocation rows can be swept without ever affecting still-valid tokens. */
  revoke(jti: string, expiresAt: number): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
  /** Deletes revocation rows whose token would already fail verification on
   *  expiry alone — safe to call opportunistically, no correctness impact. */
  sweepExpired(now: number): Promise<void>;
}

/**
 * Single-use tracking for SEP-10 challenge transactions, keyed by the
 * challenge's own tx hash. With more than one API instance, an in-memory
 * implementation only enforces "used once per process" — the same signed
 * challenge can be redeemed once on every instance inside its validity
 * window, minting one session per instance from a single signature. A
 * Redis-backed implementation (`SET NX` or equivalent) closes that gap by
 * sharing the claim across instances.
 */
export interface UsedChallengeStore {
  /**
   * Atomically claims `hash` as used, valid until `expiresAt` (epoch
   * seconds — the challenge's own timebound, so a claim never outlives the
   * challenge it guards). Returns `true` when this call is the first to
   * claim it (redemption proceeds), `false` when it was already claimed
   * (the caller must reject the redemption). Must not have a check-then-set
   * race between two concurrent callers claiming the same hash.
   */
  claim(hash: string, expiresAt: number): Promise<boolean>;
}
