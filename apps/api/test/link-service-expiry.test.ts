import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  fromStroops,
  toStroops,
  type LinkPaymentRecord,
  type LinkRepository,
  type NormalizedPayment,
  type OffRampInitiation,
  type OffRampJob,
  type OffRampPort,
  type OffRampQuote,
  type PaymentLink,
  type PayoutFieldDescriptor,
  type RailPort,
  type Seller,
  type Webhook,
  type WebhookDelivery,
  type WebhookRepository,
} from "@checkout/core";
import type { StellarConfig } from "@checkout/stellar";
import { LinkService } from "../src/services/link-service";
import { encryptSecret } from "../src/services/secret-crypto";
import { AlwaysAcceptedKyc, FakeOffRampStateRepository, FakeTelemetryRepository } from "./fakes";
import { Hono } from "hono";

const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

type AnyStatus = PaymentLink["status"];

function link(over: Partial<PaymentLink> = {}): PaymentLink {
  return {
    id: "lnk_1",
    reference: "ref_1",
    sellerId: "s_1",
    destination: DEST,
    muxedId: null,
    title: "Test",
    amount: "10",
    asset: { code: "USDC", issuer: ISSUER },
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
    expiresAt: null,
    isDemo: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

// ---------- in-memory fakes ---------------------------------------------------

class FakeLinkRepo implements LinkRepository {
  private byId = new Map<string, PaymentLink>();
  async create(input: Parameters<LinkRepository["create"]>[0]): Promise<PaymentLink> {
    const created: PaymentLink = {
      id: input.id,
      reference: input.reference,
      sellerId: input.sellerId,
      destination: input.destination,
      muxedId: input.muxedId ?? null,
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
      title: input.title,
      amount: input.amount,
      asset: input.asset,
      status: "active",
      txHash: null,
      payer: null,
      paidAmount: null,
      overpaidAmount: null,
      offrampJobId: null,
      offrampTargetCurrency: null,
      offrampStatus: null,
      expiresAt: input.expiresAt,
      isDemo: input.isDemo ?? false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.byId.set(created.id, created);
    return created;
  }
  async findById(id: string): Promise<PaymentLink | null> {
    return this.byId.get(id) ?? null;
  }
  async findByReference(reference: string): Promise<PaymentLink | null> {
    for (const l of this.byId.values()) if (l.reference === reference) return l;
    return null;
  }
  async listBySeller(sellerId: string): Promise<PaymentLink[]> {
    return [...this.byId.values()].filter((l) => l.sellerId === sellerId);
  }
  async listByStatus(_status: PaymentLink["status"]): Promise<PaymentLink[]> {
    return [...this.byId.values()];
  }
  async activeDestinations(): Promise<string[]> {
    const set = new Set<string>();
    for (const l of this.byId.values())
      if (l.status === "active" || l.status === "underpaid") set.add(l.destination);
    return [...set];
  }
  async openLinksForDestination(destination: string): Promise<PaymentLink[]> {
    return [...this.byId.values()].filter(
      (l) => l.destination === destination && (l.status === "active" || l.status === "underpaid"),
    );
  }
  async save(l: PaymentLink): Promise<void> {
    this.byId.set(l.id, { ...l, updatedAt: Date.now() });
  }
  private readonly payments: LinkPaymentRecord[] = [];
  private readonly seenTxHashes = new Set<string>();
  async recordPayment(payment: LinkPaymentRecord): Promise<void> {
    if (this.seenTxHashes.has(payment.txHash)) return;
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
      .filter((l) => l.txHash !== null && l.attestedAt === null && l.status !== "active")
      .slice(0, limit);
  }
}

class FakeSellerRepo {
  constructor(private readonly seller: Seller) {}
  async getDefault(): Promise<Seller> {
    return this.seller;
  }
  async findById(id: string): Promise<Seller | null> {
    return id === this.seller.id ? this.seller : null;
  }
  async findByWallet(wallet: string): Promise<Seller | null> {
    return wallet === this.seller.wallet ? this.seller : null;
  }
  async createIfAbsent(): Promise<Seller> {
    return this.seller;
  }
  async savePayoutFields(): Promise<void> {}
}

// Captures successful deliveries (2xx) so tests can introspect the body.
class FakeWebhookRepo implements WebhookRepository {
  stored: Webhook[] = [];
  deliveries: WebhookDelivery[] = [];
  /** Rows LinkService enqueued. Emission is now durable, so this — not a
   *  captured fetch — is where an event first becomes observable. */
  queued: { event: string; payload: string }[] = [];
  async create(input: { sellerId: string; url: string; secret: string }): Promise<Webhook> {
    const w: Webhook = {
      id: "whk_1",
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
    this.stored.push(w);
    return w;
  }
  async getById(): Promise<null> {
    return null;
  }
  async rotateSecret(): Promise<null> {
    return null;
  }
  async softDelete(): Promise<boolean> {
    return false;
  }
  async listDeliveries(): Promise<{ deliveries: never[]; nextCursor: null }> {
    return { deliveries: [], nextCursor: null };
  }
  async reclaimStale(): Promise<number> {
    return 0;
  }
  async countPending(): Promise<number> {
    return 0;
  }
  async findWebhookById(): Promise<null> {
    return null;
  }
  async enqueue(e: { id: string; webhookId: string; linkId: string; event: string; payload: string; nextAttemptAt: number; createdAt: number }) {
    const row = { ...e, attempts: 0, status: "pending" as const, lastStatusCode: null, lastError: null, updatedAt: e.createdAt };
    this.queued.push(row);
    return row;
  }
  async claimDue(): Promise<never[]> {
    return [];
  }
  async updateQueueEntry(): Promise<void> {}
  async findQueueEntry(): Promise<null> {
    return null;
  }
  async listDeliveriesByLinkId(linkId: string): Promise<WebhookDelivery[]> {
    return this.deliveries.filter((d) => d.linkId === linkId);
  }

  async listBySeller(sellerId: string): Promise<Webhook[]> {
    return this.stored.filter((h) => h.sellerId === sellerId);
  }
  async recordDelivery(d: WebhookDelivery): Promise<void> {
    this.deliveries.push(d);
  }
}

class FakeRail implements RailPort {
  assertCanReceive = async (): Promise<void> => {};
  buildRequest = (input: Parameters<RailPort["buildRequest"]>[0]) => ({
    uri: `web+stellar:pay?destination=${input.destination}&memo=${input.reference}`,
    destination: input.destination,
    amount: input.amount,
    asset: input.asset,
    memo: input.reference,
  });
  isValidDestination = (a: string): boolean => a.length > 0;
}

class FakeOffRamp implements OffRampPort {
  readonly mode = "seller_initiated" as const;
  async quote(): Promise<OffRampQuote> {
    throw new Error("not used in this suite");
  }
  async initiate(): Promise<OffRampInitiation> {
    throw new Error("not used in this suite");
  }
  async status(): Promise<OffRampJob> {
    throw new Error("not used in this suite");
  }
  async offrampRequirements(): Promise<PayoutFieldDescriptor[]> {
    return [];
  }
}

const STELLAR: StellarConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  usdcIssuer: ISSUER,
  networkPassphrase: "Test SDF Network ; September 2015",
};

// ---------- fetch intercept ---------------------------------------------------

interface CapturedFetch {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

let captured: CapturedFetch[] = [];

beforeEach(() => {
  captured = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      let parsed: Record<string, unknown> = {};
      if (typeof init?.body === "string") {
        try {
          parsed = JSON.parse(init.body) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
      }
      captured.push({ url, init: init ?? {}, body: parsed });
      return new Response("ok", { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Events the service emitted. Since the durable queue landed, `fireWebhook`
 * writes a queue row and returns — delivery is the worker's job — so the
 * assertion point moved from "what was POSTed" to "what was enqueued".
 */
function events(): { event: string; data: Record<string, unknown> }[] {
  return (enqueuedBy?.queued ?? []).map((row) => {
    const body = JSON.parse(row.payload) as Record<string, unknown>;
    return { event: String(body.event ?? ""), data: (body.data as Record<string, unknown>) ?? {} };
  });
}

/** Set by makeFixture so `events()` can reach the fixture's webhook repo. */
let enqueuedBy: FakeWebhookRepo | undefined;

// ---------- service fixture ---------------------------------------------------

interface Fixture {
  service: LinkService;
  repo: FakeLinkRepo;
  hooks: FakeWebhookRepo;
  // Returns a Hono sub-app exposing `POST /links/:id/cancel` for integration tests.
  cancelRoute: Hono;
}

async function makeFixture(): Promise<Fixture> {
  const repo = new FakeLinkRepo();
  const hooks = new FakeWebhookRepo();
  enqueuedBy = hooks;
  // Always register at least one hook so LinkService will actually dispatch.
  await hooks.create({ sellerId: "s_1", url: "https://example.com/h", secret: "test-secret" });
  const sellers = new FakeSellerRepo({
    id: "s_1",
    name: "Demo",
    wallet: DEST,
    payoutFields: null,
    createdAt: 1_700_000_000_000,
  });
  const service = new LinkService({
    links: repo,
    sellers,
    webhooks: hooks,
    rail: new FakeRail(),
    offramp: new FakeOffRamp(),
    offrampState: new FakeOffRampStateRepository(),
    kyc: new AlwaysAcceptedKyc(),
    stellar: STELLAR,
    telemetry: new FakeTelemetryRepository(),
    correlation: "memo",
    // Avoid live DNS in unit tests; ssrf-guard.test.ts covers the guard.
    webhookGuard: async () => ({ ok: true }) as const,
  });
  // Build a Hono sub-app that mirrors what `routes/links.ts` would mount but
  // depends only on `service`. The full Container has fields the route doesn't
  // touch — replaying the same handler in tests gives us an integration seam
  // without dragging the whole Container surface in.
  const cancelRoute = new Hono();
  cancelRoute.post("/:id/cancel", async (ctx) => {
    try {
      const link = await service.cancelLink(ctx.req.param("id"));
      return ctx.json({ link });
    } catch (err) {
      if (err instanceof Error && "status" in err) {
        return ctx.json({ error: (err as Error).message }, (err as { status: number }).status as 404 | 409);
      }
      throw err;
    }
  });
  return { service, repo, hooks, cancelRoute };
}

// ---------- cancelLink tests --------------------------------------------------

describe("LinkService.cancelLink", () => {
  let f: Fixture;

  beforeEach(async () => {
    f = await makeFixture();
  });

  it("cancels an active link and fires link.cancelled webhook", async () => {
    await f.repo.save(link());
    const out = await f.service.cancelLink("lnk_1");
    expect(out.status).toBe("cancelled");
    expect((await f.repo.findById("lnk_1"))!.status).toBe("cancelled");
    const evs = events();
    expect(evs.map((e) => e.event)).toContain("link.cancelled");
    const evt = evs.find((e) => e.event === "link.cancelled")!;
    expect(evt.data.linkId).toBe("lnk_1");
    expect(evt.data.status).toBe("cancelled");
  });

  it("cancels an underpaid link", async () => {
    await f.repo.save(link({ status: "underpaid" }));
    const out = await f.service.cancelLink("lnk_1");
    expect(out.status).toBe("cancelled");
  });

  it("IS idempotent: cancelling an already-cancelled link returns the link unchanged", async () => {
    await f.repo.save(link({ status: "cancelled" }));
    const before = events().length;
    const out = await f.service.cancelLink("lnk_1");
    expect(out.status).toBe("cancelled");
    expect(events().length).toBe(before);
  });

  it("REJECTS 409 when payment already settled (paid)", async () => {
    await f.repo.save(link({ status: "paid" }));
    await expect(f.service.cancelLink("lnk_1")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("paid"),
    });
  });

  it("REJECTS 409 when off-ramp is in flight (offramp_pending)", async () => {
    await f.repo.save(link({ status: "offramp_pending" }));
    await expect(f.service.cancelLink("lnk_1")).rejects.toMatchObject({ status: 409 });
  });

  it("REJECTS 409 when off-ramp already settled", async () => {
    await f.repo.save(link({ status: "offramp_settled" }));
    await expect(f.service.cancelLink("lnk_1")).rejects.toMatchObject({ status: 409 });
  });

  it("REJECTS 409 when already expired (cannot re-cancel)", async () => {
    await f.repo.save(link({ status: "expired" }));
    await expect(f.service.cancelLink("lnk_1")).rejects.toMatchObject({ status: 409 });
  });

  it("REJECTS 404 for an unknown id", async () => {
    await expect(f.service.cancelLink("nope")).rejects.toMatchObject({ status: 404 });
  });
});

// ---------- sweepExpired tests ------------------------------------------------

describe("LinkService.sweepExpired", () => {
  let f: Fixture;

  beforeEach(async () => {
    f = await makeFixture();
  });

  it("moves active links whose expiresAt is in the past to `expired`", async () => {
    const past = 1_700_000_000_000;
    const now = past + 60_000;
    await f.repo.save(link({ id: "lnk_a", expiresAt: past - 1 }));
    await f.repo.save(link({ id: "lnk_b", expiresAt: past + 60_000 }));
    await f.repo.save(link({ id: "lnk_c", status: "underpaid", expiresAt: past - 5 }));

    const moved = await f.service.sweepExpired(now);
    expect(moved).toBe(2);
    expect((await f.repo.findById("lnk_a"))!.status).toBe("expired");
    expect((await f.repo.findById("lnk_b"))!.status).toBe("active");
    expect((await f.repo.findById("lnk_c"))!.status).toBe("expired");
    expect(events().filter((e) => e.event === "link.expired")).toHaveLength(2);
  });

  it("skips links that have no TTL", async () => {
    await f.repo.save(link({ expiresAt: null }));
    const moved = await f.service.sweepExpired(Date.now() + 10_000);
    expect(moved).toBe(0);
    expect((await f.repo.findById("lnk_1"))!.status).toBe("active");
  });

  it("skips already-settled links (paid, offramp_*, expired, cancelled)", async () => {
    const past = 1_700_000_000_000;
    const now = past + 60_000;
    for (const status of ["paid", "offramp_pending", "offramp_settled", "offramp_failed", "cancelled", "expired"] as AnyStatus[]) {
      await f.repo.save(link({ id: `lnk_${status}`, status, expiresAt: past - 10 }));
    }
    const before = events().length;
    const moved = await f.service.sweepExpired(now);
    expect(moved).toBe(0);
    expect(events().length).toBe(before); // no new events
  });

  it("returns 0 and emits no webhook when there is nothing to do", async () => {
    await f.repo.save(link({ expiresAt: null }));
    const before = events().length;
    const moved = await f.service.sweepExpired(Date.now());
    expect(moved).toBe(0);
    expect(events().length).toBe(before);
  });

  it("webhook payload includes the prior expiresAt so the seller can audit", async () => {
    const past = 1_700_000_000_000;
    await f.repo.save(link({ expiresAt: past }));
    await f.service.sweepExpired(past + 1);
    const evt = events().find((e) => e.event === "link.expired")!;
    expect(evt.data.status).toBe("expired");
    expect(evt.data.expiresAt).toBe(past);
  });
});

// ---------- recordUnmatchedPayment tests -------------------------------------

describe("LinkService.recordUnmatchedPayment", () => {
  it("fires payment.unmatched carrying link context and the offensive payment", async () => {
    const f = await makeFixture();
    const l = link({ status: "cancelled", reference: "ref_killed" });
    await f.repo.save(l);

    const payment: NormalizedPayment = {
      txHash: "tx_xyz",
      pagingToken: "p1",
      from: "GBUYER1",
      to: DEST,
      amount: "10",
      asset: { code: "USDC", issuer: ISSUER },
      memo: "ref_killed",
      memoType: "text",
      toMuxedId: null,
      createdAt: "2026-06-19T12:00:00Z",
      ledger: 1,
    };

    await f.service.recordUnmatchedPayment(payment, l);

    const evt = events().find((e) => e.event === "payment.unmatched")!;
    expect(evt.data.linkId).toBe(l.id);
    expect(evt.data.reference).toBe("ref_killed");
    expect((evt.data.txHash as string | null) ?? null).toBeNull();
    expect(evt.data.paymentTxHash).toBe("tx_xyz");
    expect(evt.data.payer).toBe("GBUYER1");
    expect(evt.data.paymentAmount).toBe("10");
    expect((evt.data.paymentAsset as { code: string }).code).toBe("USDC");
    // The link was NOT mutated into `paid` (the matcher must never resurrect).
    expect((await f.repo.findById(l.id))!.status).toBe("cancelled");
  });
});

// ---------- cancel route integration -----------------------------------------

describe("POST /links/:id/cancel (HTTP)", () => {
  it("returns 200 with the link on a successful cancel", async () => {
    const f = await makeFixture();
    await f.repo.save(link());
    const res = await f.cancelRoute.request("http://x/lnk_1/cancel", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { link: PaymentLink };
    expect(body.link.status).toBe("cancelled");
  });

  it("returns 200 idempotently when the link is already cancelled", async () => {
    const f = await makeFixture();
    await f.repo.save(link({ status: "cancelled" }));
    const res = await f.cancelRoute.request("http://x/lnk_1/cancel", { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { link: PaymentLink }).link.status).toBe("cancelled");
  });

  it("returns 409 when the link is paid", async () => {
    const f = await makeFixture();
    await f.repo.save(link({ status: "paid" }));
    const res = await f.cancelRoute.request("http://x/lnk_1/cancel", { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("returns 404 when the link is unknown", async () => {
    const f = await makeFixture();
    const res = await f.cancelRoute.request("http://x/nope/cancel", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
