import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { apiKeyRoutes } from "../../src/routes/api-keys";
import { rateLimit } from "../../src/middleware/rate-limit";
import { buildAuthMiddleware } from "../../src/middleware/auth";
import { createTestContainer, type TestContainer } from "../setup";

let container: TestContainer;
let app: Hono;
let sellerId = "";
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
  // Mirror index.ts: the routes rely on auth mounted at the app level, then
  // enforce `api-keys:manage` themselves.
  app.use(
    "*",
    rateLimit({ windowMs: 60_000, max: 0 }),
    buildAuthMiddleware({
      session: container.auth.session,
      sellers: container.sellers,
      revocations: container.auth.revocations,
      apiKeyRepo: container.apiKeys,
    }),
  );
  app.route("/api-keys", apiKeyRoutes(container));
  const seller = await container.sellers.getDefault();
  sellerId = seller.id;
  authToken = await container.tokenFor(seller.id, seller.wallet);
});

afterAll(() => {
  container.client.close();
});

describe("POST /api-keys", () => {
  it("creates a key and returns the plaintext exactly once (ak_live_…)", async () => {
    const res = await req("/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "prod server" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toMatch(/^ak_/);
    expect(body.key).toMatch(/^ak_live_[0-9A-Za-z]{32}$/);
    expect(body.scopes).toEqual(["links:read", "links:write", "webhooks:manage"]);
  });

  it("creates a test-env key with explicit opt-in scopes", async () => {
    const res = await req("/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "sandbox",
        env: "test",
        scopes: "links:read,offramp:initiate,api-keys:manage",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.key).toMatch(/^ak_test_[0-9A-Za-z]{32}$/);
    expect(body.scopes).toEqual(["links:read", "offramp:initiate", "api-keys:manage"]);
  });

  it("rejects an unknown scope — 400", async () => {
    const res = await req("/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bad", scopes: "links:read,wallet:drain" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty body — 400", async () => {
    const res = await req("/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unauthenticated request — 401", async () => {
    const res = await app.request("/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "nobody" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api-keys", () => {
  it("lists only the seller's keys — no hashes, no plaintext — plus scope catalogs", async () => {
    await req("/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "for-list" }),
    });

    const res = await req("/api-keys");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      keys: Array<Record<string, unknown>>;
      availableScopes: string[];
      defaultScopes: string[];
    };
    expect(body.keys.length).toBeGreaterThan(0);
    for (const k of body.keys) {
      expect(k.hash).toBeUndefined();
      expect(k.key).toBeUndefined();
      expect(k.sellerId).toBeUndefined();
      expect(k.prefix).toMatch(/^ak_/);
      expect(k.revokedAt).toBeNull();
    }
    expect(body.availableScopes).toContain("offramp:initiate");
    expect(body.availableScopes).toContain("api-keys:manage");
    expect(body.defaultScopes).not.toContain("offramp:initiate");
    expect(body.defaultScopes).not.toContain("api-keys:manage");
  });
});

describe("DELETE /api-keys/:id", () => {
  it("revokes a key", async () => {
    const created = await (await req("/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "to-revoke" }),
    })).json() as { id: string };

    const res = await req(`/api-keys/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).revokedAt).toBeTruthy();

    const list = await (await req("/api-keys")).json() as { keys: Array<{ id: string; revokedAt: number | null }> };
    const gone = list.keys.find((k) => k.id === created.id);
    expect(gone?.revokedAt).not.toBeNull();
  });

  it("404 for a key that does not exist", async () => {
    const res = await req("/api-keys/ak_nope", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("not_found");
  });

  it("409 for a key already revoked", async () => {
    const created = await (await req("/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "revoke-twice" }),
    })).json() as { id: string };

    await req(`/api-keys/${created.id}`, { method: "DELETE" });
    const res = await req(`/api-keys/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("already_revoked");
  });
});

describe("api-keys:manage gating", () => {
  it("a key without api-keys:manage cannot manage keys — 403", async () => {
    // Mint a key that only has links:read via the repo directly (mirrors a key
    // minted with default scopes + explicit opt-out of api-keys:manage).
    const { generateApiKey, hashApiKey } = await import("../../src/services/api-keys");
    const { plaintext, prefix } = generateApiKey("live");
    const hash = await hashApiKey(plaintext);
    await container.apiKeys.create({ sellerId, name: "limited", prefix, hash, scopes: ["links:read"] });

    const res = await app.request("/api-keys", { headers: { authorization: `Bearer ${plaintext}` } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "missing_scope", required: "api-keys:manage" });
  });

  it("a key WITH api-keys:manage can list keys — end-to-end, then revocation kills it", async () => {
    const { generateApiKey, hashApiKey } = await import("../../src/services/api-keys");
    const { plaintext, prefix } = generateApiKey("live");
    const hash = await hashApiKey(plaintext);
    const key = await container.apiKeys.create({
      sellerId,
      name: "admin",
      prefix,
      hash,
      scopes: ["api-keys:manage"],
    });

    const ok = await app.request("/api-keys", { headers: { authorization: `Bearer ${plaintext}` } });
    expect(ok.status).toBe(200);

    await container.apiKeys.revoke(key.id);
    const revoked = await app.request("/api-keys", { headers: { authorization: `Bearer ${plaintext}` } });
    expect(revoked.status).toBe(401);
    expect(((await revoked.json()) as Record<string, unknown>).error).toBe("invalid_api_key");
  });
});

describe("scope-subset rule on create (6.6 — a key cannot mint a more powerful key)", () => {
  async function mintKey(name: string, scopes: string[]): Promise<string> {
    const { generateApiKey, hashApiKey } = await import("../../src/services/api-keys");
    const { plaintext, prefix } = generateApiKey("live");
    const hash = await hashApiKey(plaintext);
    await container.apiKeys.create({
      sellerId,
      name,
      prefix,
      hash,
      scopes: scopes as never,
    });
    return plaintext;
  }

  async function createAs(plaintext: string, body: Record<string, unknown>): Promise<Response> {
    return app.request("/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${plaintext}` },
      body: JSON.stringify(body),
    });
  }

  it("a key without offramp:initiate cannot mint a key that has it — 403, offending scope named", async () => {
    const narrow = await mintKey("narrow-rotator", ["api-keys:manage"]);
    const res = await createAs(narrow, { name: "escalated", scopes: "api-keys:manage,offramp:initiate" });

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string; issues: Array<{ message: string }> };
    expect(body.error).toBe("forbidden");
    const message = body.issues[0]?.message ?? "";
    expect(message).toContain("offramp:initiate");
    expect(message).not.toContain("api-keys:manage");
  });

  it("a key may mint an equal-or-narrower key — 201", async () => {
    const caller = await mintKey("rotator", ["api-keys:manage", "links:read"]);
    const res = await createAs(caller, { name: "narrower", scopes: "links:read" });

    expect(res.status).toBe(201);
    expect(((await res.json()) as { scopes: string[] }).scopes).toEqual(["links:read"]);
  });

  it("the default scopes are still subject to the rule — 403 when the caller lacks them", async () => {
    // DEFAULT_SCOPES (links:read,links:write,webhooks:manage) apply when the
    // request omits `scopes`; a caller holding only api-keys:manage holds none
    // of them, so the implicit request must be rejected too.
    const narrow = await mintKey("narrow-default", ["api-keys:manage"]);
    const res = await createAs(narrow, { name: "implicit-defaults" });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("forbidden");
  });

  it("a wallet-session caller can still issue any scope — 201", async () => {
    const res = await req("/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "session-issued", scopes: "offramp:initiate,api-keys:manage" }),
    });

    expect(res.status).toBe(201);
    expect(((await res.json()) as { scopes: string[] }).scopes).toEqual([
      "offramp:initiate",
      "api-keys:manage",
    ]);
  });
});
