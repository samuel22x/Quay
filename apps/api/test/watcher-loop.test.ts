import { describe, it, expect } from "vitest";
import type {
  LinkPaymentRecord,
  LinkRepository,
  NormalizedPayment,
  PaymentLink,
  PayoutFieldDescriptor,
  SellerRepository,
  WatcherPort,
  WebhookRepository,
  RailPort,
  OffRampPort,
} from "@checkout/core";
import { XLM, fromStroops, toStroops } from "@checkout/core";
import { WatcherLoop } from "../src/worker/watcher-loop";
import { LinkService } from "../src/services/link-service";
import { AlwaysAcceptedKyc, FakeOffRampStateRepository, FakeTelemetryRepository } from "./fakes";

const DESTINATION = "GDEST000000000000000000000000000000000000000000000000000";

/** Zero-padded so lexical and numeric ordering agree - keeps the fake watcher's slicing simple. */
function token(n: number): string {
  return String(n).padStart(10, "0");
}

function makePayment(n: number, overrides: Partial<NormalizedPayment> = {}): NormalizedPayment {
  return {
    txHash: `tx_${token(n)}`,
    pagingToken: token(n),
    from: "GBUYER00000000000000000000000000000000000000000000000000",
    to: DESTINATION,
    amount: "10",
    asset: XLM,
    memo: null,
    memoType: "none",
    toMuxedId: null,
    createdAt: new Date(0).toISOString(),
    ledger: 1,
    ...overrides,
  };
}

/** Fake Horizon-like watcher: serves `all` paginated by cursor + limit, exactly like `HorizonWatcher.fetchSince`. */
function makeFakeWatcher(all: NormalizedPayment[]): WatcherPort & { fetchSinceCalls: number } {
  const state = {
    fetchSinceCalls: 0,
    async latestCursor(): Promise<string | null> {
      return all.length > 0 ? all[all.length - 1]!.pagingToken : null;
    },
    async fetchSince(_account: string, cursor: string, limit = 200): Promise<NormalizedPayment[]> {
      state.fetchSinceCalls++;
      const startIdx = cursor ? all.findIndex((p) => p.pagingToken === cursor) + 1 : 0;
      return all.slice(startIdx, startIdx + limit);
    },
  };
  return state;
}

function makeFakeStateRepo() {
  const cursors = new Map<string, string>();
  const processed = new Set<string>();
  const setCursorCalls: string[] = [];
  return {
    cursors,
    processed,
    setCursorCalls,
    async getCursor(account: string): Promise<string | null> {
      return cursors.has(account) ? cursors.get(account)! : null;
    },
    async setCursor(account: string, cursor: string): Promise<void> {
      cursors.set(account, cursor);
      setCursorCalls.push(cursor);
    },
    // Keyed by txHash alone here (not the real per-operation key) — this file
    // tests backlog draining/pagination, not issue 4.11's multi-operation
    // dedup, and every payment in it has a unique txHash, so this stays
    // behaviorally equivalent while satisfying the WatcherStateRepository shape.
    async isProcessed(txHash: string, _operationId: string): Promise<boolean> {
      return processed.has(txHash);
    },
    async markProcessed(txHash: string, _operationId: string): Promise<void> {
      processed.add(txHash);
    },
  };
}

function makeFakeLinkRepo(initial: PaymentLink[]): LinkRepository {
  const byId = new Map(initial.map((l) => [l.id, l]));
  const payments: LinkPaymentRecord[] = [];
  const seenTxHashes = new Set<string>();
  return {
    async create(): Promise<PaymentLink> {
      throw new Error("not used in this test");
    },
    async findById(id: string) {
      return byId.get(id) ?? null;
    },
    async findByReference(reference: string) {
      return [...byId.values()].find((l) => l.reference === reference) ?? null;
    },
    async listBySeller(): Promise<PaymentLink[]> {
      throw new Error("not used in this test");
    },
    async listByStatus(): Promise<PaymentLink[]> {
      throw new Error("not used in this test");
    },
    async activeDestinations(): Promise<string[]> {
      return [...new Set([...byId.values()].map((l) => l.destination))];
    },
    async openLinksForDestination(destination: string): Promise<PaymentLink[]> {
      return [...byId.values()].filter((l) => l.destination === destination);
    },
    async save(link: PaymentLink): Promise<void> {
      byId.set(link.id, link);
    },
    async recordPayment(payment: LinkPaymentRecord): Promise<void> {
      if (seenTxHashes.has(payment.txHash)) return; // duplicate tx_hash — no-op
      seenTxHashes.add(payment.txHash);
      payments.push(payment);
    },
    async sumPaymentsForLink(linkId: string): Promise<string> {
      const total = payments
        .filter((p) => p.linkId === linkId)
        .reduce((sum, p) => sum + toStroops(p.amount), 0n);
      return fromStroops(total);
    },
      async paymentLedger(txHash: string): Promise<number | null> {
      return payments.find((p) => p.txHash === txHash)?.ledger ?? null;
    },
    async listUnattested(limit: number): Promise<PaymentLink[]> {
      return [...byId.values()]
        .filter((l) => l.txHash !== null && l.attestedAt === null && l.status !== "active")
        .slice(0, limit);
    },
  };
}

function makeNoopWebhookRepo(): WebhookRepository {
  return {
    async create(): Promise<never> {
      throw new Error("not used in this test");
    },
    async listBySeller() {
      return [];
    },
    async findWebhookById(): Promise<null> {
      return null;
    },
    enqueue: async (e: { id: string; webhookId: string; linkId: string; event: string; payload: string; nextAttemptAt: number; createdAt: number }) => ({
      ...e, attempts: 0, status: "pending" as const, lastStatusCode: null, lastError: null, updatedAt: e.createdAt,
    }),
    async claimDue(): Promise<never[]> {
      return [];
    },
    async updateQueueEntry(): Promise<void> {},
    async findQueueEntry(): Promise<null> {
      return null;
    },
    async listDeliveriesByLinkId(): Promise<never[]> {
    return [];
  },
  async recordDelivery(): Promise<void> {},
  };
}

function makeUnusedSellerRepo(): SellerRepository {
  return {
    async getDefault(): Promise<never> {
      throw new Error("not used in this test");
    },
    async findByWallet(): Promise<null> {
    return null;
  },
  async createIfAbsent(): Promise<never> {
    throw new Error("not used");
  },
  async findById(): Promise<null> {
      return null;
    },
    async savePayoutFields(): Promise<void> {},
  };
}

function makeUnusedRailPort(): RailPort {
  return {
    isValidDestination(): boolean {
    return true;
  },
  async assertCanReceive(): Promise<void> {},
  buildRequest(): never {
      throw new Error("not used in this test");
    },
  };
}

function makeUnusedOffRampPort(): OffRampPort {
  return {
    mode: "seller_initiated",
    async quote(): Promise<never> {
      throw new Error("not used in this test");
    },
    async initiate(): Promise<never> {
      throw new Error("not used in this test");
    },
    async status(): Promise<never> {
      throw new Error("not used in this test");
    },
    async offrampRequirements(): Promise<PayoutFieldDescriptor[]> {
      return [];
    },
  };
}

function makeTestLink(overrides: Partial<PaymentLink> = {}): PaymentLink {
  return {
    id: "lnk_1",
    reference: "ref-001",
    sellerId: "seller_1",
    destination: DESTINATION,
    muxedId: null,
    title: "Test invoice",
    amount: "10",
    asset: XLM,
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
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("WatcherLoop - backlog drain (issue 2.2)", () => {
  it("drains a 500-payment backlog across multiple pages within a single tick", async () => {
    const payments = Array.from({ length: 500 }, (_, i) => makePayment(i + 1));
    const watcher = makeFakeWatcher(payments);
    const stateRepo = makeFakeStateRepo();
    // Needs at least one open link on DESTINATION, otherwise activeDestinations()
    // is empty and runOnce() processes no accounts at all.
    const linkRepo = makeFakeLinkRepo([makeTestLink()]);
    stateRepo.cursors.set(DESTINATION, ""); // already-watched account, not first-seen

    const loop = new WatcherLoop({
      watcher,
      links: linkRepo,
      state: stateRepo,
      service: {} as unknown as LinkService, // every payment here is memo:null -> applyMatch is never called
      pollMs: 6000,
      pageLimit: 200,
      maxPagesPerTick: 10,
    });

    await loop.runOnce();

    // 500 payments at pageLimit=200 -> ceil(500/200) = 3 pages.
    expect(watcher.fetchSinceCalls).toBe(3);
    expect(stateRepo.setCursorCalls).toHaveLength(3);
    expect(stateRepo.cursors.get(DESTINATION)).toBe(token(500));
    expect(stateRepo.processed.size).toBe(500);
    expect(stateRepo.processed.has(`tx_${token(1)}`)).toBe(true);
    expect(stateRepo.processed.has(`tx_${token(500)}`)).toBe(true);
  });

  it("persists the cursor after every page, not once at the end", async () => {
    const payments = Array.from({ length: 450 }, (_, i) => makePayment(i + 1));
    const watcher = makeFakeWatcher(payments);
    const stateRepo = makeFakeStateRepo();
    // Needs at least one open link on DESTINATION, otherwise activeDestinations()
    // is empty and runOnce() processes no accounts at all.
    const linkRepo = makeFakeLinkRepo([makeTestLink()]);
    stateRepo.cursors.set(DESTINATION, "");

    const loop = new WatcherLoop({
      watcher,
      links: linkRepo,
      state: stateRepo,
      service: {} as unknown as LinkService,
      pollMs: 6000,
      pageLimit: 200,
      maxPagesPerTick: 10,
    });

    await loop.runOnce();

    // 3 pages: 200, 200, 50 - cursor after each should be the last token of that page.
    expect(stateRepo.setCursorCalls).toEqual([token(200), token(400), token(450)]);
  });

  it("stops at maxPagesPerTick and logs a warning, leaving the rest for the next tick", async () => {
    const payments = Array.from({ length: 2500 }, (_, i) => makePayment(i + 1));
    const watcher = makeFakeWatcher(payments);
    const stateRepo = makeFakeStateRepo();
    // Needs at least one open link on DESTINATION, otherwise activeDestinations()
    // is empty and runOnce() processes no accounts at all.
    const linkRepo = makeFakeLinkRepo([makeTestLink()]);
    stateRepo.cursors.set(DESTINATION, "");

    const logs: string[] = [];
    const loop = new WatcherLoop({
      watcher,
      links: linkRepo,
      state: stateRepo,
      service: {} as unknown as LinkService,
      pollMs: 6000,
      pageLimit: 200,
      maxPagesPerTick: 10,
      log: (m) => logs.push(m),
    });

    await loop.runOnce();

    // 2500 payments at pageLimit=200 needs 13 pages to fully drain; capped at 10.
    expect(watcher.fetchSinceCalls).toBe(10);
    expect(stateRepo.cursors.get(DESTINATION)).toBe(token(2000)); // 10 pages * 200
    expect(logs.some((l) => l.includes("maxPagesPerTick"))).toBe(true);

    // Next tick resumes and finishes the rest.
    await loop.runOnce();
    expect(stateRepo.cursors.get(DESTINATION)).toBe(token(2500));
    expect(stateRepo.processed.size).toBe(2500);
  });

  it("resumes correctly after a mid-drain crash, without replaying the whole backlog", async () => {
    const payments = Array.from({ length: 450 }, (_, i) => makePayment(i + 1));
    const watcher = makeFakeWatcher(payments);
    const stateRepo = makeFakeStateRepo();
    // Needs at least one open link on DESTINATION, otherwise activeDestinations()
    // is empty and runOnce() processes no accounts at all.
    const linkRepo = makeFakeLinkRepo([makeTestLink()]);
    stateRepo.cursors.set(DESTINATION, "");

    const realSetCursor = stateRepo.setCursor.bind(stateRepo);
    let setCursorCallCount = 0;
    stateRepo.setCursor = async (account: string, cursor: string) => {
      setCursorCallCount++;
      if (setCursorCallCount === 2) {
        // Page 1's cursor already committed (call #1); simulate a crash right
        // as page 2 finishes, before its cursor commit lands.
        throw new Error("simulated crash mid-drain");
      }
      return realSetCursor(account, cursor);
    };

    const loopBeforeCrash = new WatcherLoop({
      watcher,
      links: linkRepo,
      state: stateRepo,
      service: {} as unknown as LinkService,
      pollMs: 6000,
      pageLimit: 200,
      maxPagesPerTick: 10,
    });

    // processAccount is private - runOnce() catches the thrown error per account,
    // so this resolves without throwing, but the crash happened before page 2's
    // cursor commit.
    await loopBeforeCrash.runOnce();

    expect(stateRepo.cursors.get(DESTINATION)).toBe(token(200)); // only page 1 committed
    // Page 2's payments were marked processed before the simulated crash (real
    // ordering: markProcessed happens before that page's setCursor) - restart
    // must not re-run their side effects, only re-confirm they're already done.
    expect(stateRepo.processed.has(`tx_${token(250)}`)).toBe(true);
    expect(stateRepo.processed.has(`tx_${token(450)}`)).toBe(false); // page 3 never ran

    // "Restart": a fresh WatcherLoop reading the same persisted state.
    stateRepo.setCursor = realSetCursor;
    const loopAfterRestart = new WatcherLoop({
      watcher,
      links: linkRepo,
      state: stateRepo,
      service: {} as unknown as LinkService,
      pollMs: 6000,
      pageLimit: 200,
      maxPagesPerTick: 10,
    });

    await loopAfterRestart.runOnce();

    expect(stateRepo.cursors.get(DESTINATION)).toBe(token(450));
    expect(stateRepo.processed.size).toBe(450); // every payment ends up processed exactly once, no gaps
  });
});

describe("WatcherLoop - matching integration", () => {
  it("matches a paginated backlog against an open link and applies it via the real LinkService", async () => {
    const link = makeTestLink();
    const payments = [
      makePayment(1), // unrelated noise, no memo
      makePayment(2, { memo: link.reference, memoType: "text", amount: link.amount }),
    ];
    const watcher = makeFakeWatcher(payments);
    const stateRepo = makeFakeStateRepo();
    const linkRepo = makeFakeLinkRepo([link]);
    stateRepo.cursors.set(DESTINATION, "");

    const service = new LinkService({
      links: linkRepo,
      sellers: makeUnusedSellerRepo(),
      webhooks: makeNoopWebhookRepo(),
      rail: makeUnusedRailPort(),
      offramp: makeUnusedOffRampPort(),
      offrampState: new FakeOffRampStateRepository(),
      kyc: new AlwaysAcceptedKyc(),
      telemetry: new FakeTelemetryRepository(),
      correlation: "memo" as const,
      stellar: { network: "testnet", horizonUrl: "https://horizon-testnet.stellar.org", usdcIssuer: "GISSUER" } as never,
    });

    const logs: string[] = [];
    const loop = new WatcherLoop({
      watcher,
      links: linkRepo,
      state: stateRepo,
      service,
      pollMs: 6000,
      pageLimit: 200,
      maxPagesPerTick: 10,
      log: (m) => logs.push(m),
    });

    await loop.runOnce();

    const updated = await linkRepo.findById(link.id);
    expect(updated?.status).toBe("paid");
    expect(updated?.txHash).toBe("tx_0000000002");
    expect(logs.some((l) => l.includes("PAID"))).toBe(true);
  });
});
