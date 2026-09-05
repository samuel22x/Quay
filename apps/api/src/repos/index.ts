import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import type { ApiKeyScope } from "../services/api-keys";
import { decodeScopesFromDb, encodeScopesForDb } from "../services/api-keys";
import type {
  CreateLinkInput,
  KycFieldSpec,
  KycRecord,
  KycRepository,
  KycStatus,
  LinkPaymentRecord,
  LinkRepository,
  OffRampStateRepository,
  PaymentLink,
  Seller,
  SellerRepository,
  TokenRevocationRepository,
  StoredOffRampJob,
  StoredOffRampQuote,
  Webhook,
  WebhookDelivery,
  WebhookQueueEntry,
  WebhookRepository,
  WatcherStateRepository,
  OffRampTelemetryRepository,
  OffRampTelemetryRow,
  OffRampTelemetryStatus,
  OffRampTelemetrySummary,
  AssetRef,
} from "@checkout/core";
import type { DB } from "../db/client";
import {
  links,
  linkPayments,
  sellers,
  webhooks,
  webhookDeliveries,
  webhookQueue,
  watcherCursors,
  processedTx,
  offrampQuotes,
  offrampJobs,
  sellerKyc,
  revokedTokens,
  offrampTelemetry,
  apiKeys,
} from "../db/schema";
import { fromStroops, toStroops } from "@checkout/core";
import { newId } from "../services/ids";
import { decryptPii, encryptPii } from "../crypto/pii";
import { encryptSecret, last4 } from "../services/secret-crypto";

type LinkRow = typeof links.$inferSelect;

const OPEN_STATUSES = ["active", "underpaid"];

// A payment that settled is worth attesting regardless of what the seller did
// with the proceeds afterwards, so the off-ramp states stay in scope — the
// attestation is about the buyer's payment, not the cash-out.
const ATTESTABLE_STATUSES = ["paid", "offramp_pending", "offramp_settled", "offramp_failed"];

function assetFromRow(row: LinkRow): AssetRef {
  return { code: row.assetCode, issuer: row.assetIssuer ?? null };
}

function rowToLink(row: LinkRow): PaymentLink {
  return {
    id: row.id,
    reference: row.reference,
    sellerId: row.sellerId,
    destination: row.destination,
    muxedId: row.muxedId ?? null,
    title: row.title,
    amount: row.amount,
    asset: assetFromRow(row),
    status: row.status as PaymentLink["status"],
    txHash: row.txHash ?? null,
    payer: row.payer ?? null,
    paidAmount: row.paidAmount ?? null,
    overpaidAmount: row.overpaidAmount ?? null,
    offrampJobId: row.offrampJobId ?? null,
    offrampTargetCurrency: row.offrampTargetCurrency ?? null,
    offrampStatus: row.offrampStatus ?? null,
    offrampIndicativeRate: row.offrampIndicativeRate ?? null,
    offrampRate: row.offrampRate ?? null,
    offrampRateDelta: row.offrampRateDelta ?? null,
    offrampFeeAmount: row.offrampFeeAmount ?? null,
    offrampFeeCurrency: row.offrampFeeCurrency ?? null,
    offrampFeeSource: row.offrampFeeSource ?? null,
    offrampNetTargetAmount: row.offrampNetTargetAmount ?? null,
    attestationContractId: row.attestationContractId ?? null,
    attestationTxHash: row.attestationTxHash ?? null,
    attestationLedger: row.attestationLedger ?? null,
    attestedAt: row.attestedAt ?? null,
    expiresAt: row.expiresAt ?? null,
    isDemo: row.isDemo ?? false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleLinkRepository implements LinkRepository {
  constructor(private readonly db: DB) {}

  async create(input: CreateLinkInput): Promise<PaymentLink> {
    const now = Date.now();
    const row: LinkRow = {
      id: input.id,
      reference: input.reference,
      sellerId: input.sellerId,
      destination: input.destination,
      muxedId: input.muxedId,
      title: input.title,
      amount: input.amount,
      assetCode: input.asset.code,
      assetIssuer: input.asset.issuer,
      status: "active",
      txHash: null,
      payer: null,
      paidAmount: null,
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
      expiresAt: input.expiresAt,
      isDemo: input.isDemo ?? false,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(links).values(row);
    return rowToLink(row);
  }

  async findById(id: string): Promise<PaymentLink | null> {
    const rows = await this.db.select().from(links).where(eq(links.id, id)).limit(1);
    return rows[0] ? rowToLink(rows[0]) : null;
  }

  async findByReference(reference: string): Promise<PaymentLink | null> {
    const rows = await this.db.select().from(links).where(eq(links.reference, reference)).limit(1);
    return rows[0] ? rowToLink(rows[0]) : null;
  }

  async listBySeller(sellerId: string): Promise<PaymentLink[]> {
    const rows = await this.db.select().from(links).where(eq(links.sellerId, sellerId));
    return rows.map(rowToLink).sort((a, b) => b.createdAt - a.createdAt);
  }

  async listByStatus(status: PaymentLink["status"]): Promise<PaymentLink[]> {
    const rows = await this.db.select().from(links).where(eq(links.status, status));
    return rows.map(rowToLink);
  }

  async listUnattested(limit: number): Promise<PaymentLink[]> {
    const rows = await this.db
      .select()
      .from(links)
      .where(
        and(
          inArray(links.status, ATTESTABLE_STATUSES),
          isNotNull(links.txHash),
          // `attested_at` is the "is it in the registry" flag, not
          // `attestation_tx_hash` — an attestation we found already present
          // has no transaction hash of ours, and must not re-sweep forever.
          isNull(links.attestedAt),
        ),
      )
      .orderBy(links.createdAt)
      .limit(limit);
    return rows.map(rowToLink);
  }

  async activeDestinations(): Promise<string[]> {
    const rows = await this.db
      .select({ destination: links.destination })
      .from(links)
      .where(inArray(links.status, OPEN_STATUSES));
    return [...new Set(rows.map((r) => r.destination))];
  }

  async openLinksForDestination(destination: string): Promise<PaymentLink[]> {
    const rows = await this.db
      .select()
      .from(links)
      .where(and(eq(links.destination, destination), inArray(links.status, OPEN_STATUSES)));
    return rows.map(rowToLink);
  }

  async save(link: PaymentLink): Promise<void> {
    await this.db
      .update(links)
      .set({
        status: link.status,
        txHash: link.txHash,
        payer: link.payer,
        paidAmount: link.paidAmount,
        overpaidAmount: link.overpaidAmount,
        offrampJobId: link.offrampJobId,
        offrampTargetCurrency: link.offrampTargetCurrency,
        offrampStatus: link.offrampStatus,
        offrampIndicativeRate: link.offrampIndicativeRate,
        offrampRate: link.offrampRate,
        offrampRateDelta: link.offrampRateDelta,
        offrampFeeAmount: link.offrampFeeAmount,
        offrampFeeCurrency: link.offrampFeeCurrency,
        offrampFeeSource: link.offrampFeeSource,
        offrampNetTargetAmount: link.offrampNetTargetAmount,
        attestationContractId: link.attestationContractId,
        attestationTxHash: link.attestationTxHash,
        attestationLedger: link.attestationLedger,
        attestedAt: link.attestedAt,
        updatedAt: Date.now(),
      })
      .where(eq(links.id, link.id));
  }

  /**
   * Delete rows flagged as demo data. Called by `pnpm demo:reset` and by
   * `POST /demo/reset`.
   *
   * `sellerId` scopes the delete to one seller's demo rows. It is required on
   * the HTTP path: SEP-10 registration is open, so any keypair holder can
   * authenticate, and an unscoped delete let any one of them wipe every
   * seller's demo data on a shared testnet deployment. Omitting it (the CLI
   * path, which is already an operator-level action) keeps the original
   * delete-everything behaviour.
   */
  async deleteDemo(sellerId?: string): Promise<number> {
    const where = sellerId
      ? and(eq(links.isDemo, true), eq(links.sellerId, sellerId))
      : eq(links.isDemo, true);
    const rows = await this.db.select({ id: links.id }).from(links).where(where);
    if (rows.length > 0) {
      await this.db.delete(links).where(where);
    }
    return rows.length;
  }

  /**
   * The oldest demo-flagged link, or null when the demo has not been seeded.
   *
   * Oldest rather than newest so the /demo page keeps pointing at the same
   * link across re-seeds that only append — the seed script creates its
   * headline "Handcrafted Ceramic Mug" row first.
   */
  async findDemo(): Promise<PaymentLink | null> {
    const rows = await this.db
      .select()
      .from(links)
      .where(eq(links.isDemo, true))
      .orderBy(links.createdAt)
      .limit(1);
    return rows[0] ? rowToLink(rows[0]) : null;
  }

  async recordPayment(payment: LinkPaymentRecord): Promise<void> {
    await this.db
      .insert(linkPayments)
      .values({
        id: newId("pmt"),
        linkId: payment.linkId,
        txHash: payment.txHash,
        operationId: payment.operationId,
        payer: payment.payer,
        amount: payment.amount,
        assetCode: payment.asset.code,
        assetIssuer: payment.asset.issuer,
        ledger: payment.ledger,
        createdAt: payment.createdAt,
      })
      .onConflictDoNothing({ target: [linkPayments.txHash, linkPayments.operationId] });
  }

  async paymentLedger(txHash: string): Promise<number | null> {
    const rows = await this.db
      .select({ ledger: linkPayments.ledger })
      .from(linkPayments)
      .where(eq(linkPayments.txHash, txHash))
      .limit(1);
    return rows[0]?.ledger ?? null;
  }

  async sumPaymentsForLink(linkId: string): Promise<string> {
    const rows = await this.db
      .select({ amount: linkPayments.amount })
      .from(linkPayments)
      .where(eq(linkPayments.linkId, linkId));
    const total = rows.reduce((sum, r) => sum + toStroops(r.amount), 0n);
    return fromStroops(total);
  }
}

function rowToSeller(row: typeof sellers.$inferSelect): Seller {
  let payoutFields: Record<string, string> | null = null;
  if (row.payoutFieldsJson) {
    try {
      payoutFields = JSON.parse(row.payoutFieldsJson) as Record<string, string>;
    } catch {
      payoutFields = null;
    }
  }
  return { id: row.id, name: row.name, wallet: row.wallet, payoutFields, createdAt: row.createdAt };
}

export class DrizzleSellerRepository implements SellerRepository {
  constructor(private readonly db: DB) {}

  /** Seed (once) and return the single demo seller. */
  async ensureDefault(wallet: string, name: string): Promise<Seller> {
    const existing = await this.db.select().from(sellers).limit(1);
    if (existing[0]) {
      // keep the wallet in sync if it changed in env
      if (existing[0].wallet !== wallet) {
        await this.db.update(sellers).set({ wallet }).where(eq(sellers.id, existing[0].id));
      }
      return rowToSeller({ ...existing[0], wallet });
    }
    const now = Date.now();
    const seller: typeof sellers.$inferSelect = {
      id: newId("sel"),
      name,
      wallet,
      payoutFieldsJson: null,
      createdAt: now,
    };
    await this.db.insert(sellers).values(seller);
    return rowToSeller(seller);
  }

  async getDefault(): Promise<Seller> {
    const rows = await this.db.select().from(sellers).limit(1);
    if (!rows[0]) throw new Error("No default seller seeded");
    return rowToSeller(rows[0]);
  }

  async findById(id: string): Promise<Seller | null> {
    const rows = await this.db.select().from(sellers).where(eq(sellers.id, id)).limit(1);
    return rows[0] ? rowToSeller(rows[0]) : null;
  }

  async savePayoutFields(sellerId: string, fields: Record<string, string>): Promise<void> {
    await this.db
      .update(sellers)
      .set({ payoutFieldsJson: JSON.stringify(fields) })
      .where(eq(sellers.id, sellerId));
  }

  async findByWallet(wallet: string): Promise<Seller | null> {
    const rows = await this.db.select().from(sellers).where(eq(sellers.wallet, wallet)).limit(1);
    // Must go through rowToSeller — the raw row carries payoutFieldsJson but
    // not the parsed payoutFields; every other read path already does this,
    // and this is the SEP-10 login path, so skipping it would make the payout
    // reuse feature silently do nothing for wallet-logged-in sellers.
    return rows[0] ? rowToSeller(rows[0]) : null;
  }

  async createIfAbsent(wallet: string): Promise<Seller> {
    await this.db
      .insert(sellers)
      .values({ id: newId("sel"), name: shortWallet(wallet), wallet, createdAt: Date.now() })
      .onConflictDoNothing({ target: sellers.wallet });
    const seller = await this.findByWallet(wallet);
    if (!seller) throw new Error(`failed to create or find seller for wallet ${wallet}`);
    return seller;
  }
}

function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
}

function rowToWebhook(row: typeof webhooks.$inferSelect): Webhook {
  return {
    id: row.id,
    sellerId: row.sellerId,
    url: row.url,
    secretEncrypted: row.secretEncrypted,
    secretLast4: row.secretLast4,
    previousSecretEncrypted: row.previousSecretEncrypted,
    previousSecretLast4: row.previousSecretLast4,
    previousSecretExpiresAt: row.previousSecretExpiresAt,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
  };
}

export class DrizzleWebhookRepository implements WebhookRepository {
  constructor(private readonly db: DB) {}

  async create(input: { sellerId: string; url: string; secret: string }): Promise<Webhook> {
    const row = {
      id: newId("whk"),
      sellerId: input.sellerId,
      url: input.url,
      secretEncrypted: encryptSecret(input.secret),
      secretLast4: last4(input.secret),
      previousSecretEncrypted: null,
      previousSecretLast4: null,
      previousSecretExpiresAt: null,
      deletedAt: null,
      createdAt: Date.now(),
    };
    await this.db.insert(webhooks).values(row);
    return rowToWebhook(row);
  }

  async listBySeller(sellerId: string): Promise<Webhook[]> {
    const rows = await this.db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.sellerId, sellerId), isNull(webhooks.deletedAt)));
    return rows.map(rowToWebhook);
  }

  async getById(id: string, sellerId: string, opts?: { includeDeleted?: boolean }): Promise<Webhook | null> {
    const conditions = [eq(webhooks.id, id), eq(webhooks.sellerId, sellerId)];
    if (!opts?.includeDeleted) conditions.push(isNull(webhooks.deletedAt));
    const rows = await this.db
      .select()
      .from(webhooks)
      .where(and(...conditions))
      .limit(1);
    return rows[0] ? rowToWebhook(rows[0]) : null;
  }

  /**
   * Unscoped lookup. Only the delivery worker uses this: it drains the queue
   * outside any request, so there is no seller in scope to check against.
   * Routes must keep using `getById`, which enforces ownership.
   */
  async findWebhookById(id: string): Promise<Webhook | null> {
    const rows = await this.db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1);
    return rows[0] ? rowToWebhook(rows[0]) : null;
  }

  async rotateSecret(id: string, sellerId: string, newSecret: string, overlapMs: number): Promise<Webhook | null> {
    const existing = await this.getById(id, sellerId);
    if (!existing) return null;

    const updated = {
      secretEncrypted: encryptSecret(newSecret),
      secretLast4: last4(newSecret),
      previousSecretEncrypted: existing.secretEncrypted,
      previousSecretLast4: existing.secretLast4,
      previousSecretExpiresAt: Date.now() + overlapMs,
    };
    await this.db
      .update(webhooks)
      .set(updated)
      .where(and(eq(webhooks.id, id), eq(webhooks.sellerId, sellerId)));

    return { ...existing, ...updated };
  }

  async softDelete(id: string, sellerId: string): Promise<boolean> {
    const result = await this.db
      .update(webhooks)
      .set({ deletedAt: Date.now() })
      .where(and(eq(webhooks.id, id), eq(webhooks.sellerId, sellerId), isNull(webhooks.deletedAt)));
    return (result.rowsAffected ?? 0) > 0;
  }

  async recordDelivery(d: Omit<WebhookDelivery, "id" | "createdAt">): Promise<void> {
    await this.db.insert(webhookDeliveries).values({
      id: newId("whd"),
      webhookId: d.webhookId,
      linkId: d.linkId,
      event: d.event,
      attempt: d.attempt,
      queueEntryId: d.queueEntryId,
      statusCode: d.statusCode,
      ok: d.ok,
      error: d.error,
      createdAt: Date.now(),
    });
  }

  // ---------------------------------------------------------------------------
  // Queue operations
  // ---------------------------------------------------------------------------

  async enqueue(
    entry: Omit<WebhookQueueEntry, "attempts" | "status" | "lastStatusCode" | "lastError" | "updatedAt">,
  ): Promise<WebhookQueueEntry> {
    const now = Date.now();
    const row = {
      id: entry.id,
      webhookId: entry.webhookId,
      linkId: entry.linkId,
      event: entry.event,
      payload: entry.payload,
      attempts: 0,
      nextAttemptAt: entry.nextAttemptAt,
      status: "pending" as const,
      lastStatusCode: null,
      lastError: null,
      createdAt: entry.createdAt,
      updatedAt: now,
    };
    await this.db.insert(webhookQueue).values(row);
    return row;
  }

  /**
   * Claim up to `limit` pending rows whose next_attempt_at <= now.
   *
   * SQLite is single-writer, so the read-then-update within a single synchronous
   * call is safe against concurrent processes sharing the same file. For a
   * multi-process / Turso setup the `status = 'claimed'` write acts as an
   * optimistic lock: if two workers race, only one's UPDATE will match the row
   * (the other will find status ≠ 'pending' on the next SELECT and skip it).
   */
  async claimDue(now: number, limit: number): Promise<WebhookQueueEntry[]> {
    // 1. Find candidates.
    const candidates = await this.db
      .select()
      .from(webhookQueue)
      .where(
        and(
          eq(webhookQueue.status, "pending"),
          lte(webhookQueue.nextAttemptAt, now),
        ),
      )
      .limit(limit);

    if (candidates.length === 0) return [];

    const ids = candidates.map((r) => r.id);

    // 2. Atomically transition pending → claimed and take the affected rows
    //    straight off the UPDATE via RETURNING.
    //
    //    RETURNING is what makes this safe across instances: it yields exactly
    //    the rows *this* statement transitioned. Re-SELECTing status='claimed'
    //    afterwards would also match rows a concurrent worker had just claimed
    //    between our UPDATE and our SELECT, and both workers would deliver the
    //    same webhook.
    const claimed = await this.db
      .update(webhookQueue)
      .set({ status: "claimed", updatedAt: Date.now() })
      .where(
        and(
          inArray(webhookQueue.id, ids),
          eq(webhookQueue.status, "pending"),
        ),
      )
      .returning();

    return claimed.map(rowToQueueEntry);
  }

  async updateQueueEntry(
    id: string,
    patch: Pick<WebhookQueueEntry, "status" | "attempts" | "nextAttemptAt" | "lastStatusCode" | "lastError">,
  ): Promise<void> {
    await this.db
      .update(webhookQueue)
      .set({
        status: patch.status,
        attempts: patch.attempts,
        nextAttemptAt: patch.nextAttemptAt,
        lastStatusCode: patch.lastStatusCode,
        lastError: patch.lastError,
        updatedAt: Date.now(),
      })
      .where(eq(webhookQueue.id, id));
  }

  async reclaimStale(claimedBefore: number): Promise<number> {
    const released = await this.db
      .update(webhookQueue)
      .set({ status: "pending", updatedAt: Date.now() })
      .where(and(eq(webhookQueue.status, "claimed"), lt(webhookQueue.updatedAt, claimedBefore)))
      .returning();
    return released.length;
  }

  async countPending(): Promise<number> {
    const rows = await this.db
      .select({ id: webhookQueue.id })
      .from(webhookQueue)
      .where(inArray(webhookQueue.status, ["pending", "claimed"]));
    return rows.length;
  }

  async findQueueEntry(id: string): Promise<WebhookQueueEntry | null> {
    const rows = await this.db
      .select()
      .from(webhookQueue)
      .where(eq(webhookQueue.id, id))
      .limit(1);
    return rows[0] ? rowToQueueEntry(rows[0]) : null;
  }

  async listDeliveries(
    webhookId: string,
    sellerId: string,
    opts: { limit: number; cursor?: string | null },
  ): Promise<{ deliveries: WebhookDelivery[]; nextCursor: string | null }> {
    // Ownership check — a merchant may only read deliveries for their own
    // webhook. Deleted webhooks are included on purpose: history must stay
    // visible after an endpoint is removed.
    const owned = await this.getById(webhookId, sellerId, { includeDeleted: true });
    if (!owned) return { deliveries: [], nextCursor: null };

    const cursorCreatedAt = opts.cursor ? decodeDeliveryCursor(opts.cursor) : null;
    const conditions = [eq(webhookDeliveries.webhookId, webhookId)];
    if (cursorCreatedAt !== null) conditions.push(lt(webhookDeliveries.createdAt, cursorCreatedAt));

    // Fetch one extra row to know whether there's a next page.
    const rows = await this.db
      .select()
      .from(webhookDeliveries)
      .where(and(...conditions))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(opts.limit + 1);

    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > opts.limit && last ? encodeDeliveryCursor(last.createdAt) : null;

    return { deliveries: page, nextCursor };
  }

  async listDeliveriesByLinkId(linkId: string): Promise<WebhookDelivery[]> {
    const rows = await this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.linkId, linkId))
      .orderBy(webhookDeliveries.createdAt);
    return rows.map((r) => ({
      id: r.id,
      webhookId: r.webhookId,
      linkId: r.linkId,
      event: r.event,
      attempt: r.attempt,
      queueEntryId: r.queueEntryId,
      statusCode: r.statusCode,
      ok: r.ok,
      error: r.error,
      createdAt: r.createdAt,
    }));
  }
}

type QueueRow = typeof webhookQueue.$inferSelect;

function rowToQueueEntry(row: QueueRow): WebhookQueueEntry {
  return {
    id: row.id,
    webhookId: row.webhookId,
    linkId: row.linkId,
    event: row.event,
    payload: row.payload,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    status: row.status as WebhookQueueEntry["status"],
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function encodeDeliveryCursor(createdAt: number): string {
  return Buffer.from(String(createdAt), "utf8").toString("base64url");
}

function decodeDeliveryCursor(cursor: string): number {
  const decoded = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isFinite(decoded)) throw new Error("Invalid cursor");
  return decoded;
}

export class DrizzleWatcherStateRepository implements WatcherStateRepository {
  constructor(private readonly db: DB) {}

  async getCursor(account: string): Promise<string | null> {
    const rows = await this.db
      .select()
      .from(watcherCursors)
      .where(eq(watcherCursors.account, account))
      .limit(1);
    return rows[0]?.cursor ?? null;
  }

  async setCursor(account: string, cursor: string): Promise<void> {
    await this.db
      .insert(watcherCursors)
      .values({ account, cursor, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: watcherCursors.account,
        set: { cursor, updatedAt: Date.now() },
      });
  }

  async isProcessed(txHash: string, operationId: string): Promise<boolean> {
    const rows = await this.db
      .select({ txHash: processedTx.txHash })
      .from(processedTx)
      .where(
        and(
          eq(processedTx.txHash, txHash),
          // Exact operation already recorded, OR a pre-migration row marked
          // the whole transaction (operation_id NULL) — see schema.ts.
          or(eq(processedTx.operationId, operationId), isNull(processedTx.operationId)),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async markProcessed(txHash: string, operationId: string, linkId: string | null): Promise<void> {
    await this.db
      .insert(processedTx)
      .values({ txHash, operationId, linkId, createdAt: Date.now() })
      .onConflictDoNothing({ target: [processedTx.txHash, processedTx.operationId] });
  }
}

export class DrizzleTokenRevocationRepository implements TokenRevocationRepository {
  constructor(private readonly db: DB) {}

  async revoke(jti: string, expiresAt: number): Promise<void> {
    await this.db
      .insert(revokedTokens)
      .values({ jti, expiresAt, revokedAt: Date.now() })
      .onConflictDoNothing();
  }

  async isRevoked(jti: string): Promise<boolean> {
    const rows = await this.db.select({ jti: revokedTokens.jti }).from(revokedTokens).where(eq(revokedTokens.jti, jti)).limit(1);
    return rows.length > 0;
  }

  async sweepExpired(now: number): Promise<void> {
    await this.db.delete(revokedTokens).where(lt(revokedTokens.expiresAt, now));
  }
}

type OffRampQuoteRow = typeof offrampQuotes.$inferSelect;
type OffRampJobRow = typeof offrampJobs.$inferSelect;

function rowToQuote(row: OffRampQuoteRow): StoredOffRampQuote {
  return {
    quoteId: row.quoteId,
    linkId: row.linkId,
    sellAsset: { code: row.sellAssetCode, issuer: row.sellAssetIssuer ?? null },
    sellAmount: row.sellAmount,
    buyCurrency: row.buyCurrency,
    price: row.price,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

function rowToJob(row: OffRampJobRow): StoredOffRampJob {
  return {
    jobId: row.jobId,
    linkId: row.linkId,
    anchor: row.anchor,
    targetCurrency: row.targetCurrency,
    targetAmount: row.targetAmount,
    rate: row.rate,
    status: row.status as StoredOffRampJob["status"],
    externalStatus: row.externalStatus ?? null,
    lastError: row.lastError ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Off-ramp quotes and jobs — money-adjacent state that must survive a restart. */
export class DrizzleOffRampStateRepository implements OffRampStateRepository {
  constructor(private readonly db: DB) {}

  async saveQuote(quote: StoredOffRampQuote): Promise<void> {
    await this.db.insert(offrampQuotes).values({
      quoteId: quote.quoteId,
      linkId: quote.linkId,
      sellAssetCode: quote.sellAsset.code,
      sellAssetIssuer: quote.sellAsset.issuer,
      sellAmount: quote.sellAmount,
      buyCurrency: quote.buyCurrency,
      price: quote.price,
      expiresAt: quote.expiresAt,
      createdAt: quote.createdAt,
    });
  }

  async getQuote(quoteId: string): Promise<StoredOffRampQuote | null> {
    const rows = await this.db.select().from(offrampQuotes).where(eq(offrampQuotes.quoteId, quoteId)).limit(1);
    return rows[0] ? rowToQuote(rows[0]) : null;
  }

  async saveJob(job: StoredOffRampJob): Promise<void> {
    await this.db.insert(offrampJobs).values({
      jobId: job.jobId,
      linkId: job.linkId,
      anchor: job.anchor,
      targetCurrency: job.targetCurrency,
      targetAmount: job.targetAmount,
      rate: job.rate,
      status: job.status,
      externalStatus: job.externalStatus,
      lastError: job.lastError,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  }

  async getJob(jobId: string): Promise<StoredOffRampJob | null> {
    const rows = await this.db.select().from(offrampJobs).where(eq(offrampJobs.jobId, jobId)).limit(1);
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  async updateJob(
    jobId: string,
    patch: Partial<Pick<StoredOffRampJob, "targetAmount" | "status" | "externalStatus" | "lastError">>,
  ): Promise<void> {
    await this.db
      .update(offrampJobs)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(offrampJobs.jobId, jobId));
  }
}

type SellerKycRow = typeof sellerKyc.$inferSelect;

/**
 * Seller-level SEP-12 KYC state. `fieldsEncrypted` is the seller's submitted
 * PII (name, email, address, ...) — encrypted with `piiKey` before it ever
 * touches the database, decrypted only in-process when read back.
 */
export class DrizzleKycRepository implements KycRepository {
  constructor(
    private readonly db: DB,
    private readonly piiKey: Buffer,
  ) {}

  private rowToRecord(row: SellerKycRow): KycRecord {
    return {
      sellerId: row.sellerId,
      customerId: row.customerId ?? null,
      status: row.status as KycStatus,
      requiredFields: JSON.parse(row.requiredFields) as KycFieldSpec[],
      providedFields: JSON.parse(decryptPii(row.fieldsEncrypted, this.piiKey)) as Record<string, string>,
      message: row.message ?? null,
      lastSyncedAt: row.lastSyncedAt ?? null,
      updatedAt: row.updatedAt,
    };
  }

  async get(sellerId: string): Promise<KycRecord | null> {
    const rows = await this.db.select().from(sellerKyc).where(eq(sellerKyc.sellerId, sellerId)).limit(1);
    return rows[0] ? this.rowToRecord(rows[0]) : null;
  }

  async save(record: KycRecord): Promise<void> {
    const row = {
      sellerId: record.sellerId,
      customerId: record.customerId,
      status: record.status,
      requiredFields: JSON.stringify(record.requiredFields),
      fieldsEncrypted: encryptPii(JSON.stringify(record.providedFields), this.piiKey),
      message: record.message,
      lastSyncedAt: record.lastSyncedAt,
      updatedAt: record.updatedAt,
    };
    await this.db
      .insert(sellerKyc)
      .values(row)
      .onConflictDoUpdate({ target: sellerKyc.sellerId, set: row });
  }
}

function rowToTelemetry(row: typeof offrampTelemetry.$inferSelect): OffRampTelemetryRow {
  return {
    id: row.id,
    anchorDomain: row.anchorDomain,
    corridor: row.corridor,
    sellAsset: row.sellAsset,
    sellAmount: row.sellAmount,
    indicativeRate: row.indicativeRate,
    quotedRate: row.quotedRate,
    quotedAt: row.quotedAt,
    initiatedAt: row.initiatedAt,
    settledAt: row.settledAt,
    effectiveRate: row.effectiveRate,
    feeAmount: row.feeAmount,
    status: row.status as OffRampTelemetryStatus,
    failureReason: row.failureReason,
  };
}

/** nearest-rank percentile over an ascending-sorted array; null on empty input. */
function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.max(0, Math.ceil(p * sortedAsc.length) - 1);
  return sortedAsc[idx] ?? null;
}

/**
 * Persistence for passive off-ramp telemetry (issue #20, 3.8). `upsert` is
 * keyed by `id` — one row per cash-out, replaced in place as it progresses
 * through quoted -> initiated -> settled / failed. No product surface reads
 * this except the operator-only /telemetry routes.
 */
export class DrizzleOfframpTelemetryRepository implements OffRampTelemetryRepository {
  constructor(private readonly db: DB) {}

  async upsert(row: OffRampTelemetryRow): Promise<void> {
    const dbRow: typeof offrampTelemetry.$inferInsert = {
      id: row.id,
      anchorDomain: row.anchorDomain,
      corridor: row.corridor,
      sellAsset: row.sellAsset,
      sellAmount: row.sellAmount,
      indicativeRate: row.indicativeRate,
      quotedRate: row.quotedRate,
      quotedAt: row.quotedAt,
      initiatedAt: row.initiatedAt,
      settledAt: row.settledAt,
      effectiveRate: row.effectiveRate,
      feeAmount: row.feeAmount,
      status: row.status,
      failureReason: row.failureReason,
    };
    await this.db
      .insert(offrampTelemetry)
      .values(dbRow)
      .onConflictDoUpdate({ target: offrampTelemetry.id, set: dbRow });
  }

  async all(): Promise<OffRampTelemetryRow[]> {
    const rows = await this.db.select().from(offrampTelemetry);
    return rows.map(rowToTelemetry);
  }

  async summary(): Promise<OffRampTelemetrySummary[]> {
    const rows = await this.all();
    const groups = new Map<string, OffRampTelemetryRow[]>();
    for (const r of rows) {
      const key = `${r.anchorDomain} ${r.corridor}`;
      const list = groups.get(key);
      if (list) list.push(r);
      else groups.set(key, [r]);
    }

    const out: OffRampTelemetrySummary[] = [];
    for (const [key, list] of groups) {
      const [anchorDomain, corridor] = key.split(" ") as [string, string];
      const settled = list.filter((r) => r.status === "settled");
      const failed = list.filter((r) => r.status === "failed");
      const latencies = settled
        .filter((r): r is OffRampTelemetryRow & { initiatedAt: number; settledAt: number } =>
          r.initiatedAt !== null && r.settledAt !== null,
        )
        .map((r) => r.settledAt - r.initiatedAt)
        .sort((a, b) => a - b);
      const spreads = settled
        .filter((r) => r.effectiveRate !== null)
        .map((r) => (Number(r.quotedRate) - Number(r.effectiveRate)) / Number(r.quotedRate));

      out.push({
        anchorDomain,
        corridor,
        count: list.length,
        settledCount: settled.length,
        failedCount: failed.length,
        latencyP50Ms: percentile(latencies, 0.5),
        latencyP95Ms: percentile(latencies, 0.95),
        meanSpread: spreads.length > 0 ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null,
      });
    }
    return out;
  }
}

export interface ApiKey {
  id: string;
  sellerId: string;
  name: string;
  /** Lookup prefix of the plaintext key — safe to display / index. */
  prefix: string;
  /** scrypt hash of the full plaintext key. The plaintext is never stored. */
  hash: string;
  scopes: ApiKeyScope[];
  lastUsedAt: number | null;
  createdAt: number;
  revokedAt: number | null;
}

type ApiKeyRow = typeof apiKeys.$inferSelect;

function rowToApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    sellerId: row.sellerId,
    name: row.name,
    prefix: row.prefix,
    hash: row.hash,
    scopes: decodeScopesFromDb(row.scopes),
    lastUsedAt: row.lastUsedAt ?? null,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt ?? null,
  };
}

/**
 * Persistence for scoped API keys (issue #40, 6.3).
 *
 * Prefix lookup: the auth middleware pre-filters on the lookup prefix (cheap,
 * indexed) before spending a full scrypt verify, and only ever sees hashes.
 */
export class DrizzleApiKeyRepository {
  constructor(private readonly db: DB) {}

  async create(input: {
    sellerId: string;
    name: string;
    prefix: string;
    hash: string;
    scopes: ApiKeyScope[];
  }): Promise<ApiKey> {
    const now = Date.now();
    const row: ApiKeyRow = {
      id: newId("ak"),
      sellerId: input.sellerId,
      name: input.name,
      prefix: input.prefix,
      hash: input.hash,
      scopes: encodeScopesForDb(input.scopes),
      lastUsedAt: null,
      createdAt: now,
      revokedAt: null,
    };
    await this.db.insert(apiKeys).values(row);
    return rowToApiKey(row);
  }

  /** Find all keys (active or not) for a seller. */
  async listBySeller(sellerId: string): Promise<ApiKey[]> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.sellerId, sellerId));
    return rows.map(rowToApiKey).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Find a non-revoked key by its lookup prefix for fast pre-filtering before
   * the expensive scrypt verify. Returns null when no active key with that
   * prefix exists (saves the scrypt round-trip for unknown prefixes).
   */
  async findActiveByPrefix(prefix: string): Promise<ApiKey | null> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.prefix, prefix))
      .limit(10); // prefix is not guaranteed unique; verify hash for all matches
    const active = rows.filter((r) => r.revokedAt === null).map(rowToApiKey);
    return active[0] ?? null;
  }

  /**
   * Same as findActiveByPrefix but returns all non-revoked rows sharing the
   * prefix (extremely unlikely >1, but correct to check all before failing).
   */
  async findAllActiveByPrefix(prefix: string): Promise<ApiKey[]> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.prefix, prefix))
      .limit(10);
    return rows.filter((r) => r.revokedAt === null).map(rowToApiKey);
  }

  async findById(id: string): Promise<ApiKey | null> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, id))
      .limit(1);
    return rows[0] ? rowToApiKey(rows[0]) : null;
  }

  /** Soft-delete: set revokedAt to now. */
  async revoke(id: string): Promise<void> {
    await this.db
      .update(apiKeys)
      .set({ revokedAt: Date.now() })
      .where(eq(apiKeys.id, id));
  }

  /**
   * Fire-and-forget last_used_at update. Call after a successful verification;
   * the promise is intentionally not awaited on the hot path so auth latency
   * is not affected by a DB round-trip. Returns the promise so the caller can
   * attach a `.catch()` (an unhandled rejection would take the process down).
   */
  touchLastUsed(id: string): Promise<unknown> {
    return this.db
      .update(apiKeys)
      .set({ lastUsedAt: Date.now() })
      .where(eq(apiKeys.id, id));
  }
}
