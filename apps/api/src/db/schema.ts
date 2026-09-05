import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const sellers = sqliteTable("sellers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  wallet: text("wallet").notNull().unique(),
  /**
   * JSON-serialised Record<string,string> of the seller's last-used payout
   * fields (e.g. bank account number). Never emitted in logs or webhooks;
   * exposed to the dashboard only in masked form. Null until the seller
   * completes their first cash-out.
   */
  payoutFieldsJson: text("payout_fields_json"),
  createdAt: integer("created_at").notNull(),
});

export const links = sqliteTable("links", {
  id: text("id").primaryKey(),
  reference: text("reference").notNull().unique(),
  sellerId: text("seller_id").notNull(),
  destination: text("destination").notNull(),
  muxedId: text("muxed_id"), // SEP-23 correlation id; null in memo mode (the default)
  title: text("title").notNull(),
  amount: text("amount").notNull(),
  assetCode: text("asset_code").notNull(),
  assetIssuer: text("asset_issuer"), // null = native XLM
  status: text("status").notNull(),
  txHash: text("tx_hash"),
  payer: text("payer"),
  paidAmount: text("paid_amount"),
  /** Surplus once cumulative payments exceed the requested amount (issue 1.4). */
  overpaidAmount: text("overpaid_amount"),
  offrampJobId: text("offramp_job_id"),
  offrampTargetCurrency: text("offramp_target_currency"),
  offrampStatus: text("offramp_status"),
  /** Indicative rate captured at preview time (issue 3.5 telemetry). */
  offrampIndicativeRate: text("offramp_indicative_rate"),
  /** Firm rate from the SEP-38 POST /quote (issue 3.5 telemetry). */
  offrampRate: text("offramp_rate"),
  /** Absolute delta: firm − indicative (issue 3.5 telemetry). */
  offrampRateDelta: text("offramp_rate_delta"),
  /** Anchor fee quoted at cash-out time (issue 1.5), so the receipt can reproduce it. */
  offrampFeeAmount: text("offramp_fee_amount"),
  offrampFeeCurrency: text("offramp_fee_currency"),
  offrampFeeSource: text("offramp_fee_source"), // "anchor" | "estimated"
  offrampNetTargetAmount: text("offramp_net_target_amount"),
  /**
   * On-chain settlement attestation (issue 9.2). All four stay null until the
   * attester writes the receipt to the registry — settlement never waits on
   * this. The contract id is stored per row, not read from config at render
   * time, so redeploying the registry can't repoint historical receipts at a
   * contract that never held them.
   */
  attestationContractId: text("attestation_contract_id"),
  attestationTxHash: text("attestation_tx_hash"),
  attestationLedger: integer("attestation_ledger"),
  attestedAt: integer("attested_at"),
  expiresAt: integer("expires_at"),
  /** Set to 1 for rows created by the demo seed script. Shown as a badge in the
   *  dashboard and cleaned up by `pnpm demo:reset` / POST /demo/reset. */
  isDemo: integer("is_demo", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Authoritative ledger of every payment recorded against a link — cumulative
// accounting (issue 1.4) sums these rather than trusting a single payment.
// Unique on (tx_hash, operation_id) — see `migrateLegacyLinkPaymentsTable` in
// db/client.ts — not tx_hash alone: a transaction can carry more than one
// payment operation to the same link (issue 4.11), and each is its own row.
export const linkPayments = sqliteTable("link_payments", {
  id: text("id").primaryKey(),
  linkId: text("link_id").notNull(),
  txHash: text("tx_hash").notNull(),
  /** Horizon's per-operation pagingToken. NULL only on rows written before
   *  this column existed — see `migrateLegacyLinkPaymentsTable`. */
  operationId: text("operation_id"),
  payer: text("payer").notNull(),
  amount: text("amount").notNull(),
  assetCode: text("asset_code").notNull(),
  assetIssuer: text("asset_issuer"), // null = native XLM
  /** Ledger the payment settled in. Nullable: rows written before issue 9.2
   *  have no value, and an attestation for those is simply skipped. */
  ledger: integer("ledger"),
  createdAt: integer("created_at").notNull(),
});

export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  sellerId: text("seller_id").notNull(),
  url: text("url").notNull(),
  secretEncrypted: text("secret_encrypted").notNull(),
  secretLast4: text("secret_last4").notNull(),
  previousSecretEncrypted: text("previous_secret_encrypted"),
  previousSecretLast4: text("previous_secret_last4"),
  previousSecretExpiresAt: integer("previous_secret_expires_at"),
  deletedAt: integer("deleted_at"),
  createdAt: integer("created_at").notNull(),
});

export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  webhookId: text("webhook_id").notNull(),
  linkId: text("link_id").notNull(),
  event: text("event").notNull(),
  /** Which attempt number this row records (1-based). */
  attempt: integer("attempt").notNull().default(1),
  /** ID of the queue entry this delivery belongs to. Null for legacy rows. */
  queueEntryId: text("queue_entry_id"),
  statusCode: integer("status_code"),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
});

/**
 * Durable delivery queue.  Each row = one pending (or dead-lettered) delivery.
 * The worker claims rows by atomically flipping status from "pending" → "claimed",
 * then delivers, then either resolves → "delivered" or reschedules / dead-letters.
 *
 * status lifecycle:
 *   pending → claimed → delivered
 *                    ↘ pending  (transient failure, next_attempt_at bumped)
 *                    ↘ dead     (exhausted max attempts)
 *   dead   → pending  (manual replay via POST /webhooks/deliveries/:id/replay)
 */
export const webhookQueue = sqliteTable("webhook_queue", {
  id: text("id").primaryKey(),
  webhookId: text("webhook_id").notNull(),
  linkId: text("link_id").notNull(),
  event: text("event").notNull(),
  /** JSON-serialised event payload — the exact body that will be signed & sent. */
  payload: text("payload").notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: integer("next_attempt_at").notNull(),
  /** pending | claimed | delivered | dead */
  status: text("status").notNull().default("pending"),
  lastStatusCode: integer("last_status_code"),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const offrampQuotes = sqliteTable("offramp_quotes", {
  quoteId: text("quote_id").primaryKey(),
  linkId: text("link_id").notNull(),
  sellAssetCode: text("sell_asset_code").notNull(),
  sellAssetIssuer: text("sell_asset_issuer"), // null = native XLM
  sellAmount: text("sell_amount").notNull(),
  buyCurrency: text("buy_currency").notNull(),
  price: text("price").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const offrampJobs = sqliteTable("offramp_jobs", {
  jobId: text("job_id").primaryKey(),
  linkId: text("link_id").notNull(),
  anchor: text("anchor").notNull(),
  targetCurrency: text("target_currency").notNull(),
  targetAmount: text("target_amount").notNull(),
  rate: text("rate").notNull(),
  status: text("status").notNull(),
  externalStatus: text("external_status"),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Keyed by seller (never by link) — identity is submitted once and reused
// across every link. `fieldsEncrypted` is the only PII column: an AES-256-GCM
// blob of the seller's submitted field values, opaque without KYC_ENCRYPTION_KEY.
export const sellerKyc = sqliteTable("seller_kyc", {
  sellerId: text("seller_id").primaryKey(),
  customerId: text("customer_id"),
  status: text("status").notNull(),
  requiredFields: text("required_fields").notNull(), // JSON KycFieldSpec[] — not PII, just schema metadata
  fieldsEncrypted: text("fields_encrypted").notNull(), // AES-256-GCM blob of Record<string,string>
  message: text("message"),
  lastSyncedAt: integer("last_synced_at"),
  updatedAt: integer("updated_at").notNull(),
});

export const watcherCursors = sqliteTable("watcher_cursors", {
  account: text("account").primaryKey(),
  cursor: text("cursor").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Dedup ledger for the watcher (issue 4.11). Keyed on (tx_hash, operation_id)
// — see `migrateLegacyProcessedTxTable` in db/client.ts — not tx_hash alone: a
// Stellar transaction can carry up to 100 operations, and a payment is one
// operation, not the whole transaction. `operation_id` is Horizon's
// pagingToken; it's NULL only on rows migrated from before this column
// existed, and `isProcessed` treats a NULL row as "the whole transaction was
// processed" to preserve the dedup behavior anything already settled had.
export const processedTx = sqliteTable("processed_tx", {
  txHash: text("tx_hash").notNull(),
  operationId: text("operation_id"),
  linkId: text("link_id"),
  createdAt: integer("created_at").notNull(),
});

export const idempotencyKeys = sqliteTable("idempotency_keys", {
  key: text("key").notNull(),
  sellerId: text("seller_id").notNull(),
  endpoint: text("endpoint").notNull(),
  requestHash: text("request_hash").notNull(),
  responseStatus: integer("response_status").notNull(),
  responseBody: text("response_body").notNull(),
  createdAt: integer("created_at").notNull(),
});

// Logout / compromise revocation for session JWTs, keyed by the token's own
// `jti`. `expiresAt` mirrors the token's own `exp` — once a token would fail
// verification on expiry alone, its revocation row is dead weight and gets
// swept.
export const revokedTokens = sqliteTable("revoked_tokens", {
  jti: text("jti").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
  revokedAt: integer("revoked_at").notNull(),
});

/**
 * Passive off-ramp telemetry (issue #20, 3.8). One row per cash-out, upserted
 * by id as it progresses through quoted -> initiated -> settled / failed.
 * No product surface consumes this yet — it exists purely to accumulate the
 * dataset (anchor settlement latency, effective spread) cheaply now, since it
 * can't be backfilled later.
 */
export const offrampTelemetry = sqliteTable("offramp_telemetry", {
  id: text("id").primaryKey(),
  anchorDomain: text("anchor_domain").notNull(),
  corridor: text("corridor").notNull(),
  sellAsset: text("sell_asset").notNull(),
  sellAmount: text("sell_amount").notNull(),
  /** In-memory mock/testanchor rate at quote time, if available. */
  indicativeRate: text("indicative_rate"),
  /** The firm rate returned by quote(). */
  quotedRate: text("quoted_rate").notNull(),
  quotedAt: integer("quoted_at").notNull(),
  initiatedAt: integer("initiated_at"),
  settledAt: integer("settled_at"),
  /** Derived from the anchor-reported amount_out at settlement, not the quote. */
  effectiveRate: text("effective_rate"),
  feeAmount: text("fee_amount"),
  status: text("status").notNull(),
  failureReason: text("failure_reason"),
});

/**
 * Scoped API keys for programmatic access (issue #40, 6.3).
 *
 * Security invariants:
 *   - `hash` is an scrypt digest of the full key — the plaintext is NEVER stored.
 *   - `prefix` is a lookup prefix of the key (safe to index and display).
 *   - `scopes` is a comma-separated list drawn from ApiKeyScope.
 *   - `revokedAt` non-null means the key is invalid regardless of hash match.
 *   - `lastUsedAt` is updated asynchronously (fire-and-forget) to avoid adding
 *     latency to the hot path.
 */
export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  sellerId: text("seller_id").notNull(),
  name: text("name").notNull(),
  /** Lookup prefix of the plaintext key — used for display / lookup. */
  prefix: text("prefix").notNull(),
  /** scrypt hash of the full plaintext key (hex-encoded). */
  hash: text("hash").notNull(),
  /** Comma-separated scope list, e.g. "links:read,links:write". */
  scopes: text("scopes").notNull(),
  lastUsedAt: integer("last_used_at"),
  createdAt: integer("created_at").notNull(),
  /** Non-null when the key has been revoked. */
  revokedAt: integer("revoked_at"),
});
