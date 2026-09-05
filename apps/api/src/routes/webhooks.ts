import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { registerWebhookSchema, listWebhookDeliveriesQuerySchema } from "@checkout/core";
import type { PublicWebhook, Webhook } from "@checkout/core";
import type { Container } from "../services/container";
import { buildAuthMiddleware, requireScope, type AuthVariables } from "../middleware/auth";
import { guardWebhookUrl } from "../services/ssrf-guard";
import { getLogger } from "../request-context";

const HOST_ALLOWLIST = process.env.WEBHOOK_HOST_ALLOWLIST
  ? process.env.WEBHOOK_HOST_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
  : undefined;

/** How long the previous secret keeps signing deliveries after a rotation. */
export const SECRET_ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;

function generateSecret(): string {
  return randomBytes(24).toString("hex");
}

/** Strips secret material before a webhook is ever serialized in a response. */
function toPublic(h: Webhook): PublicWebhook {
  const { secretEncrypted, previousSecretEncrypted, ...safe } = h;
  return safe;
}

export function webhookRoutes(c: Container): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  // Composed auth: session (requireSeller, ALL_SCOPES) or a scoped API key
  // (issue #40). Every route additionally requires webhooks:manage.
  app.use(
    "*",
    buildAuthMiddleware({
      session: c.auth.session,
      sellers: c.sellers,
      revocations: c.auth.revocations,
      apiKeyRepo: c.apiKeys,
    }),
    requireScope("webhooks:manage"),
  );

  // Register a webhook. The secret is returned ONCE — store it to verify signatures.
  app.post("/", async (ctx) => {
    const log = getLogger(ctx);
    let body: unknown;
    try {
      body = await ctx.req.json();
    } catch {
      body = {};
    }
    const parsed = registerWebhookSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ event: "webhook.register.invalid", issues: parsed.error.issues }, "invalid register webhook body");
      return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }

    // SSRF guard: validate the URL and resolve the hostname before storing.
    const guard = await (c.webhookGuard ?? ((u: string) => guardWebhookUrl(u, { allowlist: HOST_ALLOWLIST })))(
      parsed.data.url,
    );
    if (!guard.ok) {
      return ctx.json({ error: "invalid_webhook_url", reason: guard.reason }, 422);
    }

    const seller = ctx.get("seller");
    const secret = generateSecret();
    const hook = await c.webhooks.create({ sellerId: seller.id, url: parsed.data.url, secret });
    log.info({ event: "webhook.registered", webhookId: hook.id, sellerId: seller.id }, "webhook registered");
    return ctx.json({ ...toPublic(hook), secret }, 201);
  });

  // List registered webhooks (secrets are not returned; deleted ones are excluded).
  app.get("/", async (ctx) => {
    const seller = ctx.get("seller");
    const hooks = await c.webhooks.listBySeller(seller.id);
    return ctx.json({ webhooks: hooks.map(toPublic) });
  });

  // Remove a webhook. Soft delete — delivery history stays visible afterward.
  app.delete("/:id", async (ctx) => {
    const seller = ctx.get("seller");
    const deleted = await c.webhooks.softDelete(ctx.req.param("id"), seller.id);
    if (!deleted) return ctx.json({ error: "not_found" }, 404);
    return ctx.body(null, 204);
  });

  // Rotate a webhook's signing secret. The new secret is returned ONCE, exactly
  // like at creation. The old secret keeps signing deliveries for 24h (see
  // WebhookSender) so an in-flight deploy of the new secret doesn't drop events.
  app.post("/:id/rotate-secret", async (ctx) => {
    const seller = ctx.get("seller");
    const secret = generateSecret();
    const hook = await c.webhooks.rotateSecret(ctx.req.param("id"), seller.id, secret, SECRET_ROTATION_OVERLAP_MS);
    if (!hook) return ctx.json({ error: "not_found" }, 404);
    return ctx.json({ ...toPublic(hook), secret });
  });

  // Paginated delivery history for one webhook (visible even after it's deleted).
  app.get("/:id/deliveries", async (ctx) => {
    const seller = ctx.get("seller");
    const parsed = listWebhookDeliveriesQuerySchema.safeParse({
      limit: ctx.req.query("limit"),
      cursor: ctx.req.query("cursor"),
    });
    if (!parsed.success) return ctx.json({ error: "invalid_query", issues: parsed.error.issues }, 400);

    const owned = await c.webhooks.getById(ctx.req.param("id"), seller.id, { includeDeleted: true });
    if (!owned) return ctx.json({ error: "not_found" }, 404);

    const { deliveries, nextCursor } = await c.webhooks.listDeliveries(owned.id, seller.id, parsed.data);
    return ctx.json({ deliveries, nextCursor });
  });

  /**
   * POST /webhooks/deliveries/:id/replay
   *
   * Re-enqueues a dead-lettered (or any) queue entry for immediate redelivery.
   * Returns 202 Accepted with the updated entry summary. The actual delivery
   * happens on the next WebhookWorker tick (within seconds).
   *
   * Idempotent if called on an entry that is already pending or delivered:
   *   - pending   → next_attempt_at reset to now (no-op on next tick if already 0)
   *   - delivered → re-queued as pending (manual replay of a successful delivery)
   *   - dead      → re-queued as pending (the primary use-case)
   *   - claimed   → 409 (delivery is in-flight; wait for it to settle first)
   */
  app.post("/deliveries/:id/replay", async (ctx) => {
    const seller = ctx.get("seller");
    const id = ctx.req.param("id");
    const entry = await c.webhooks.findQueueEntry(id);

    // Ownership: the queue entry names a webhook, and the webhook names a
    // seller. Resolving through getById scopes the replay to the caller's own
    // tenant — without it, any authenticated seller could re-fire another
    // merchant's events by guessing an id. A queue entry the caller does not
    // own is reported as absent, so the endpoint leaks no id space either.
    const owned = entry ? await c.webhooks.getById(entry.webhookId, seller.id, { includeDeleted: true }) : null;

    if (!entry || !owned) {
      return ctx.json({ error: "not_found", message: `No delivery queue entry with id "${id}"` }, 404);
    }

    if (entry.status === "claimed") {
      return ctx.json(
        { error: "in_flight", message: "Delivery is currently in-flight; wait for it to settle before replaying." },
        409,
      );
    }

    await c.webhooks.updateQueueEntry(id, {
      status: "pending",
      attempts: entry.attempts, // preserve history count; worker increments on next attempt
      nextAttemptAt: Date.now(),
      lastStatusCode: entry.lastStatusCode,
      lastError: entry.lastError,
    });

    return ctx.json(
      {
        id: entry.id,
        webhookId: entry.webhookId,
        linkId: entry.linkId,
        event: entry.event,
        previousAttempts: entry.attempts,
        status: "pending",
        message: "Queued for immediate redelivery.",
      },
      202,
    );
  });

  return app;
}
