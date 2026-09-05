import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { webhookRoutes } from "../../src/routes/webhooks";
import { rateLimit } from "../../src/middleware/rate-limit";
import { createTestContainer, type TestContainer } from "../setup";

// ---------------------------------------------------------------------------
//  Webhook route tests
// ---------------------------------------------------------------------------

let container: TestContainer;
let app: Hono;

/** Every /links and /webhooks route is seller-gated since #79, so route tests
 *  authenticate as the default seller. `GET /links/:id` is public but sending
 *  the header there is harmless. */
let authToken = "";
async function req(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${authToken}` },
  });
}

beforeAll(async () => {
  container = await createTestContainer();
  app = new Hono();
  app.use("*", rateLimit({ windowMs: 60_000, max: 0 }));
  app.route("/webhooks", webhookRoutes(container));
  const seller = await container.sellers.getDefault();
  authToken = await container.tokenFor(seller.id, seller.wallet);
});

afterAll(() => {
  container.client.close();
});

describe("POST /webhooks", () => {
  it("registers a webhook and returns id, url, and secret", async () => {
    const res = await req("/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hooks/checkout" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toMatch(/^whk_/);
    expect(body.url).toBe("https://example.com/hooks/checkout");
    expect(body.secret).toBeTruthy();

    // Secret should be a hex string of length 48 (24 random bytes)
    expect(typeof body.secret).toBe("string");
    expect((body.secret as string).length).toBe(48);
  });

  it("returns 400 for missing url", async () => {
    const res = await req("/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_body");
  });

  it("returns 400 for invalid url", async () => {
    const res = await req("/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "not-a-url" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await req("/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /webhooks", () => {
  it("returns an empty list when no webhooks registered", async () => {
    // Create a fresh container with no webhooks
    const fresh = await createTestContainer();
    const freshApp = new Hono();
    freshApp.use("*", rateLimit({ windowMs: 60_000, max: 0 }));
    freshApp.route("/webhooks", webhookRoutes(fresh));

    // `fresh` has its own in-memory DB, so the outer token's sellerId doesn't
    // resolve against it — mint one from this container's own seller.
    const freshSeller = await fresh.sellers.getDefault();
    const freshToken = await fresh.tokenFor(freshSeller.id, freshSeller.wallet);

    const res = await freshApp.request("/webhooks", { headers: { authorization: `Bearer ${freshToken}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.webhooks).toEqual([]);

    fresh.client.close();
  });

  it("lists registered webhooks without secrets", async () => {
    // Register one webhook
    await req("/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hook1" }),
    });

    const res = await req("/webhooks");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const hooks = body.webhooks as Array<Record<string, unknown>>;
    expect(hooks.length).toBeGreaterThanOrEqual(1);
    for (const h of hooks) {
      expect(h.id).toMatch(/^whk_/);
      expect(h.url).toBeTruthy();
      expect(h.createdAt).toBeTypeOf("number");
      // Secrets should never be returned in the list
      expect((h as Record<string, unknown>).secret).toBeUndefined();
    }
  });
});

describe("POST /webhooks/deliveries/:id/replay", () => {
  it("re-queues a dead-lettered entry for the seller that owns it", async () => {
    const seller = await container.sellers.getDefault();
    const hook = await container.webhooks.create({
      sellerId: seller.id,
      url: "https://example.com/replay-me",
      secret: "replay-secret-000",
    });
    const entry = await container.webhooks.enqueue({
      id: "wqe_replay_1",
      webhookId: hook.id,
      linkId: "lnk_1",
      event: "link.paid",
      payload: JSON.stringify({ event: "link.paid" }),
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
    });
    await container.webhooks.updateQueueEntry(entry.id, {
      status: "dead",
      attempts: 5,
      nextAttemptAt: entry.nextAttemptAt,
      lastStatusCode: 500,
      lastError: "HTTP 500",
    });

    const res = await req(`/webhooks/deliveries/${entry.id}/replay`, { method: "POST" });
    expect(res.status).toBe(202);

    const after = await container.webhooks.findQueueEntry(entry.id);
    expect(after?.status).toBe("pending");
    // The attempt history is preserved — replay resumes the count, not resets it.
    expect(after?.attempts).toBe(5);
  });

  it("does not let one seller replay another seller's delivery", async () => {
    const other = await container.sellers.createIfAbsent(
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    );
    const theirHook = await container.webhooks.create({
      sellerId: other.id,
      url: "https://example.com/not-yours",
      secret: "their-secret-0000",
    });
    const theirEntry = await container.webhooks.enqueue({
      id: "wqe_replay_2",
      webhookId: theirHook.id,
      linkId: "lnk_2",
      event: "link.paid",
      payload: JSON.stringify({ event: "link.paid" }),
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
    });
    await container.webhooks.updateQueueEntry(theirEntry.id, {
      status: "dead",
      attempts: 5,
      nextAttemptAt: theirEntry.nextAttemptAt,
      lastStatusCode: 500,
      lastError: "HTTP 500",
    });

    // Authenticated as the default seller, replaying someone else's entry.
    const res = await req(`/webhooks/deliveries/${theirEntry.id}/replay`, { method: "POST" });
    expect(res.status).toBe(404);

    const after = await container.webhooks.findQueueEntry(theirEntry.id);
    expect(after?.status).toBe("dead"); // untouched
  });

  it("returns 404 for an unknown entry", async () => {
    const res = await req("/webhooks/deliveries/wqe_nope/replay", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
