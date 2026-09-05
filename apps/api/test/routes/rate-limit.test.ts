import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { authRoutes } from "../../src/routes/auth";
import { publicRoutes } from "../../src/routes/public";
import { rateLimit, MemoryStore } from "../../src/middleware/rate-limit";
import { createTestContainer, type TestContainer } from "../setup";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { ChallengeService } from "../../src/services/challenge";

// ---------------------------------------------------------------------------
//  Route-specific rate limits (issue #153)
//
//  /auth  — strict limiter (20/min per IP)
//  /r/*   — receipt limiter (60/min per IP, half the global 120 cap)
//
//  These tests verify that the limiters are applied and that the expected
//  status code is returned when the budget is exhausted.
// ---------------------------------------------------------------------------

const HOME_DOMAIN = "quay.test";
const WEB_AUTH_DOMAIN = "quay.test";
const NETWORK_PASSPHRASE = Networks.TESTNET;

let container: TestContainer;
let authApp: Hono;
let receiptApp: Hono;

beforeAll(async () => {
  container = await createTestContainer();

  const serverKeypair = Keypair.random();
  const challenge = new ChallengeService({
    serverKeypair,
    homeDomain: HOME_DOMAIN,
    webAuthDomain: WEB_AUTH_DOMAIN,
    networkPassphrase: NETWORK_PASSPHRASE,
    fetchAccountSigners: async () => null,
  });

  const store = new MemoryStore();

  // Auth app: strict rate limit (20/min)
  const strictRateLimit = rateLimit({
    windowMs: 60_000,
    max: 20,
    store,
  });

  authApp = new Hono();
  authApp.use("/auth", strictRateLimit);
  authApp.route(
    "/auth",
    authRoutes({
      challenge,
      session: container.auth.session,
      sellers: container.sellers,
      revocations: container.auth.revocations,
      secureCookie: false,
    }),
  );

  // Receipt app: receipt rate limit (60/min)
  const receiptRateLimit = rateLimit({
    windowMs: 60_000,
    max: 60,
    store,
  });

  receiptApp = new Hono();
  receiptApp.use("/r/*", receiptRateLimit);
  receiptApp.route("/r", publicRoutes(container));
});

afterAll(() => {
  container.client.close();
});

describe("POST /auth rate limit", () => {
  it("returns 429 after 20 requests within the window", async () => {
    // Send 20 requests — all should pass (the budget is 20).
    for (let i = 0; i < 20; i++) {
      const res = await authApp.request("/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transaction: "fake" }),
      });
      // These may return 400/401 (invalid body) — that's fine, we just need
      // the requests to hit the rate limiter so the counter advances.
      expect(res.status).not.toBe(429);
    }

    // The 21st request must be rejected.
    const res = await authApp.request("/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction: "fake" }),
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rate_limited");
  });
});

describe("GET /auth rate limit", () => {
  it("returns 429 after 20 GET requests within the window", async () => {
    // We need a separate test since the previous describe block already
    // exhausted the counter.  The rate limit key is the same (client IP),
    // so this test relies on the window having not expired.  We create a
    // fresh app with its own store to avoid cross-test interference.
    const store = new MemoryStore();
    const sl = rateLimit({ windowMs: 60_000, max: 20, store });

    const serverKeypair = Keypair.random();
    const challenge = new ChallengeService({
      serverKeypair,
      homeDomain: HOME_DOMAIN,
      webAuthDomain: WEB_AUTH_DOMAIN,
      networkPassphrase: NETWORK_PASSPHRASE,
      fetchAccountSigners: async () => null,
    });

    const app = new Hono();
    app.use("/auth", sl);
    app.route(
      "/auth",
      authRoutes({
        challenge,
        session: container.auth.session,
        sellers: container.sellers,
        revocations: container.auth.revocations,
        secureCookie: false,
      }),
    );

    // Missing account → 400, but it still counts against the budget.
    for (let i = 0; i < 20; i++) {
      const res = await app.request("/auth");
      expect(res.status).not.toBe(429);
    }

    // 21st GET must be 429.
    const res = await app.request("/auth");
    expect(res.status).toBe(429);
  });
});

describe("GET /r/:reference rate limit", () => {
  it("applies the receipt limiter (distinct from global)", async () => {
    // Create a fresh app with a low receipt limit to make the test fast.
    const store = new MemoryStore();
    const receiptLimiter = rateLimit({ windowMs: 60_000, max: 3, store });

    const app = new Hono();
    app.use("/r/*", receiptLimiter);
    app.route("/r", publicRoutes(container));

    // 3 requests should pass (budget = 3).
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/r/nonexistent_ref");
      expect(res.status).not.toBe(429);
    }

    // 4th must be 429.
    const res = await app.request("/r/nonexistent_ref");
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rate_limited");
  });
});

// ---------------------------------------------------------------------------
//  Wiring, not just behaviour.
//
//  The suites above build their own Hono apps, so they prove the `rateLimit`
//  middleware works — they do not prove `apps/api/src/index.ts` actually
//  applies it to these routes. Deleting either `app.use` line from index.ts
//  leaves every test above green.
//
//  index.ts is a boot file: `main()` is not exported and it calls `serve()`,
//  so there is no app to import and probe. Asserting against its source is
//  the available way to pin the wiring, and it is the wiring that is the
//  whole of issue #153.
//
//  Ordering matters as much as presence: Hono runs middleware in registration
//  order, so a `use()` mounted after the `route()` it targets never runs.
// ---------------------------------------------------------------------------

describe("index.ts route wiring", () => {
  const source = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");

  it("applies the strict limiter to /auth", () => {
    expect(source).toMatch(/app\.use\("\/auth",\s*strictRateLimit\)/);
  });

  it("applies a receipt limiter to /r/*", () => {
    expect(source).toMatch(/app\.use\("\/r\/\*",\s*receiptRateLimit\)/);
  });

  it("gives the receipt limiter a budget below the global cap", () => {
    expect(source).toMatch(/max:\s*Math\.floor\(env\.rateLimitMax \/ 2\)/);
  });

  it("mounts both /r/* middlewares before the /r route, or they never run", () => {
    const receiptLimiter = source.indexOf('app.use("/r/*", receiptRateLimit)');
    const receiptCors = source.indexOf('app.use("/r/*", cors(');
    const receiptRoute = source.indexOf('app.route("/r", publicRoutes(container))');

    expect(receiptLimiter).toBeGreaterThan(-1);
    expect(receiptCors).toBeGreaterThan(-1);
    expect(receiptRoute).toBeGreaterThan(-1);
    expect(receiptLimiter).toBeLessThan(receiptRoute);
    expect(receiptCors).toBeLessThan(receiptRoute);
  });

  it("mounts the /auth limiter before the /auth route", () => {
    const limiter = source.indexOf('app.use("/auth", strictRateLimit)');
    const route = source.indexOf('app.route(\n    "/auth"');
    expect(limiter).toBeGreaterThan(-1);
    expect(route).toBeGreaterThan(-1);
    expect(limiter).toBeLessThan(route);
  });
});
