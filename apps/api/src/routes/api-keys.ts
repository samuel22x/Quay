/**
 * API-key management routes (issue #40, 6.3).
 *
 *   POST   /api-keys           Create a new key (returns plaintext ONCE).
 *   GET    /api-keys           List keys for the authenticated seller (no hashes).
 *   DELETE /api-keys/:id       Revoke a key.
 *
 * All three are gated behind `api-keys:manage` so a key can't mint further
 * keys unless explicitly granted that scope. The plaintext key is returned
 * exactly once in the `POST` response and is never stored — the database holds
 * only the scrypt hash and the 8-char prefix.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../services/container";
import {
  generateApiKey,
  hashApiKey,
  parseScopes,
  DEFAULT_SCOPES,
  ALL_SCOPES,
  type KeyEnvironment,
} from "../services/api-keys";
import { requireScope, type AuthVariables } from "../middleware/auth";

const createKeySchema = z.object({
  name: z.string().min(1).max(120),
  /**
   * "live" or "test" — purely cosmetic in the key prefix (ak_live_… vs
   * ak_test_…). Both types work against the same backend.
   */
  env: z.enum(["live", "test"]).default("live"),
  /**
   * Comma-separated scope list. Defaults to links:read,links:write,webhooks:manage.
   * offramp:initiate and api-keys:manage must be explicitly requested.
   */
  scopes: z.string().default(""),
});

export function apiKeyRoutes(c: Container): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireScope("api-keys:manage"));

  // Create a new key. Plaintext returned ONCE — store it immediately.
  app.post("/", async (ctx) => {
    let body: unknown;
    try {
      body = await ctx.req.json();
    } catch {
      body = {};
    }

    const parsed = createKeySchema.safeParse(body);
    if (!parsed.success) {
      return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }

    let scopes;
    try {
      scopes = parseScopes(parsed.data.scopes);
    } catch (err) {
      return ctx.json(
        {
          error: "invalid_body",
          issues: [{ message: err instanceof Error ? err.message : String(err) }],
        },
        400,
      );
    }

    // Prevent privilege escalation: a key may only mint keys whose scopes are a
    // subset of its own. Session-authenticated sellers are the authority the
    // keys derive from, so they may still request any scope.
    if (ctx.get("authKind") === "api_key") {
      const callerScopes = ctx.get("scopes") ?? [];
      const denied = scopes.filter((s) => !callerScopes.includes(s));
      if (denied.length > 0) {
        return ctx.json(
          {
            error: "forbidden",
            issues: [{ message: `Requested scope(s) not held by calling key: ${denied.join(", ")}` }],
          },
          403,
        );
      }
    }

    const { plaintext, prefix } = generateApiKey(parsed.data.env as KeyEnvironment);
    const hash = await hashApiKey(plaintext);

    const key = await c.apiKeys.create({
      sellerId: ctx.get("seller").id,
      name: parsed.data.name,
      prefix,
      hash,
      scopes,
    });

    // Return the plaintext key only on creation.
    return ctx.json(
      {
        id: key.id,
        name: key.name,
        prefix: key.prefix,
        scopes: key.scopes,
        createdAt: key.createdAt,
        // ⚠  Store this — it will not be shown again.
        key: plaintext,
      },
      201,
    );
  });

  // List all keys for the seller (no hashes, no plaintext).
  app.get("/", async (ctx) => {
    const keys = await c.apiKeys.listBySeller(ctx.get("seller").id);
    return ctx.json({
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        scopes: k.scopes,
        lastUsedAt: k.lastUsedAt,
        createdAt: k.createdAt,
        revokedAt: k.revokedAt,
      })),
      availableScopes: [...ALL_SCOPES],
      defaultScopes: [...DEFAULT_SCOPES],
    });
  });

  // Revoke a key.
  app.delete("/:id", async (ctx) => {
    const keyId = ctx.req.param("id");
    const key = await c.apiKeys.findById(keyId);

    if (!key) return ctx.json({ error: "not_found" }, 404);
    if (key.sellerId !== ctx.get("seller").id) return ctx.json({ error: "not_found" }, 404); // don't leak existence
    if (key.revokedAt !== null) return ctx.json({ error: "already_revoked" }, 409);

    await c.apiKeys.revoke(keyId);
    return ctx.json({ id: keyId, revokedAt: Date.now() });
  });

  return app;
}
