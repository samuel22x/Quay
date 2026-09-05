import { describe, expect, it, vi } from "vitest";
import {
  CannotReceiveError,
  type LinkRepository,
  type OffRampPort,
  type PaymentLink,
  type RailPort,
  type Seller,
  type SellerRepository,
  type WebhookRepository,
} from "@checkout/core";
import type { StellarConfig } from "@checkout/stellar";
import { HttpError, LinkService } from "../src/services/link-service";
import { AlwaysAcceptedKyc, FakeOffRampStateRepository, FakeTelemetryRepository } from "./fakes";

const seller: Seller = { id: "sel_1", name: "Demo Seller", wallet: "GSELLERWALLETADDRESS", payoutFields: null, createdAt: Date.now() };

const stellar: StellarConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  usdcIssuer: "GUSDCISSUERADDRESS",
};

function fakeLinks(): LinkRepository {
  return {
    create: vi.fn(async (input) => ({ ...input, status: "active", txHash: null, payer: null, paidAmount: null, overpaidAmount: null, offrampJobId: null, offrampTargetCurrency: null, offrampStatus: null, createdAt: Date.now(), updatedAt: Date.now() }) as PaymentLink),
    findById: vi.fn(async () => null),
    findByReference: vi.fn(async () => null),
    listBySeller: vi.fn(async () => []),
    listByStatus: vi.fn(async () => []),
    activeDestinations: vi.fn(async () => []),
    openLinksForDestination: vi.fn(async () => []),
    save: vi.fn(async () => {}),
    recordPayment: vi.fn(async () => {}),
    sumPaymentsForLink: vi.fn(async () => "0"),
    paymentLedger: vi.fn(async () => null),
    listUnattested: vi.fn(async () => []),
  };
}

function fakeSellers(): SellerRepository {
  return {
    getDefault: vi.fn(async () => seller),
    findById: vi.fn(async () => seller),
    findByWallet: vi.fn(async () => seller),
    createIfAbsent: vi.fn(async () => seller),
    savePayoutFields: vi.fn(async () => {}),
  };
}

function fakeWebhooks(): WebhookRepository {
  return {
    create: vi.fn(async (input) => ({ id: "whk_1", ...input, createdAt: Date.now() })),
    listBySeller: vi.fn(async () => []),
    getById: vi.fn(async () => null),
    rotateSecret: vi.fn(async () => null),
    softDelete: vi.fn(async () => false),
    listDeliveries: vi.fn(async () => ({ deliveries: [], nextCursor: null })),
    reclaimStale: vi.fn(async () => 0),
    countPending: vi.fn(async () => 0),
    findWebhookById: async () => null,
    enqueue: async (e: { id: string; webhookId: string; linkId: string; event: string; payload: string; nextAttemptAt: number; createdAt: number }) => ({
    ...e, attempts: 0, status: "pending" as const, lastStatusCode: null, lastError: null, updatedAt: e.createdAt,
  }),
    claimDue: async () => [],
    updateQueueEntry: async () => {},
    findQueueEntry: async () => null,
    listDeliveriesByLinkId: vi.fn(async () => []),
    recordDelivery: vi.fn(async () => {}),
  };
}

function fakeRail(assertCanReceive: RailPort["assertCanReceive"]): RailPort {
  return {
    buildRequest: vi.fn(() => ({
      uri: "web+stellar:pay?destination=...",
      destination: seller.wallet,
      amount: "10",
      asset: { code: "USDC", issuer: stellar.usdcIssuer },
      memo: "ref",
    })),
    isValidDestination: vi.fn(() => true),
    assertCanReceive,
  };
}

function fakeOfframp(): OffRampPort {
  return {
    mode: "seller_initiated",
    quote: vi.fn(),
    initiate: vi.fn(),
    status: vi.fn(),
    offrampRequirements: vi.fn(async () => []),
  };
}

function makeService(links: LinkRepository, rail: RailPort): LinkService {
  return new LinkService({
    links,
    sellers: fakeSellers(),
    webhooks: fakeWebhooks(),
    rail,
    offramp: fakeOfframp(),
    offrampState: new FakeOffRampStateRepository(),
    kyc: new AlwaysAcceptedKyc(),
    stellar,
    telemetry: new FakeTelemetryRepository(),
    correlation: "memo",
    webhookGuard: async () => ({ ok: true }) as const,
  });
}

describe("LinkService.createLink — trustline preflight", () => {
  it("creates the link when the destination can receive the asset", async () => {
    const links = fakeLinks();
    const rail = fakeRail(vi.fn(async () => {}));
    const service = makeService(links, rail);

    const { link } = await service.createLink(seller.id, { title: "T-shirt", amount: "10", assetCode: "USDC" });

    expect(link.title).toBe("T-shirt");
    expect(links.create).toHaveBeenCalledTimes(1);
  });

  it("rejects with 422 destination_cannot_receive and never creates the link", async () => {
    const links = fakeLinks();
    const trustlineUri = "web+stellar:tx?xdr=AAAA...";
    const rail = fakeRail(
      vi.fn(async () => {
        throw new CannotReceiveError("no_trustline", "Account GSELLERWALLETADDRESS has no trustline for USDC.", trustlineUri);
      }),
    );
    const service = makeService(links, rail);

    let caught: unknown;
    try {
      await service.createLink(seller.id, { title: "T-shirt", amount: "10", assetCode: "USDC" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HttpError);
    const httpError = caught as HttpError;
    expect(httpError.status).toBe(422);
    expect(httpError.message).toBe("destination_cannot_receive");
    expect(httpError.extra?.reason).toBe("no_trustline");
    expect(httpError.extra?.trustlineUri).toBe(trustlineUri);
    expect(links.create).not.toHaveBeenCalled();
  });

  it("lets through non-CannotReceiveError failures unchanged", async () => {
    const links = fakeLinks();
    const rail = fakeRail(
      vi.fn(async () => {
        throw new Error("horizon is down");
      }),
    );
    const service = makeService(links, rail);

    await expect(service.createLink(seller.id, { title: "T-shirt", amount: "10", assetCode: "USDC" })).rejects.toThrow("horizon is down");
  });
});

describe("LinkService.checkSellerUsdcTrustline", () => {
  it("returns ok:true when the seller's wallet can receive USDC", async () => {
    const rail = fakeRail(vi.fn(async () => {}));
    const service = makeService(fakeLinks(), rail);

    await expect(service.checkSellerUsdcTrustline()).resolves.toEqual({ ok: true });
  });

  it("returns the structured failure when it can't", async () => {
    const rail = fakeRail(
      vi.fn(async () => {
        throw new CannotReceiveError("trustline_not_authorized", "frozen by issuer");
      }),
    );
    const service = makeService(fakeLinks(), rail);

    await expect(service.checkSellerUsdcTrustline()).resolves.toEqual({
      ok: false,
      reason: "trustline_not_authorized",
      message: "frozen by issuer",
      trustlineUri: undefined,
    });
  });
});
