import { Hono, type MiddlewareHandler } from "hono";
import {
  createLinkSchema,
  cashOutSchema,
  submitPaymentSchema,
  OffRampDisabledError,
  type PaymentLink,
} from "@checkout/core";
import type { Container } from "../services/container";
import { HttpError } from "../services/link-service";
import { buildAuthMiddleware, requireScope, type AuthVariables } from "../middleware/auth";
import { idempotency } from "../middleware/idempotency";
import { getLogger } from "../request-context";

export function linkRoutes(c: Container, strictRateLimit: MiddlewareHandler): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  // Applied per-route, NOT via app.use("*", ...). `GET /links/:id` is the
  // buyer-facing checkout fetch: the buyer paying an invoice is not the seller
  // and holds no session, and `apps/web/app/pay/[id]/page.tsx` renders it in a
  // server component with no cookie at all. Gating it would 401 every checkout.
  //
  // Accepts either a session (requireSeller, ALL_SCOPES) or a scoped API key
  // (issue #40): both resolve to the same seller context.
  const auth = buildAuthMiddleware({
    session: c.auth.session,
    sellers: c.sellers,
    revocations: c.auth.revocations,
    apiKeyRepo: c.apiKeys,
  });

  // Idempotency is mounted after `auth` so it can scope stored responses to the
  // authenticated seller (issue #26).
  const idempotent = idempotency(c.db);

  // strictRateLimit runs BEFORE auth so unauthenticated floods are throttled
  // too — a limiter that only applies to valid sessions protects nothing.
  // Create a payment link.
  app.post("/", strictRateLimit, auth, idempotent, async (ctx) => {
    const log = getLogger(ctx);
    const parsed = createLinkSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) {
      log.warn({ event: "link.create.invalid", issues: parsed.error.issues }, "invalid create-link body");
      return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }
    try {
      const result = await c.service.createLink(ctx.get("seller").id, parsed.data);
      log.info({ event: "link.create.ok", linkId: result.link.id }, "link created");
      return ctx.json(result, 201);
    } catch (err) {
      if (err instanceof HttpError) {
        log.warn({ event: "link.create.error", error: err.message }, "create-link failed");
        return ctx.json({ error: err.message, ...err.extra }, err.status as 422);
      }
      throw err;
    }
  });

  // (linkId is included in the link.create.ok payload above so a grep on
  // `linkId` finds both the route-level `link.create.*` and the service-level
  // `link.created` events symmetrically, the same way POST /:id/cash-out
  // includes linkId in every route-level line.)

  // List the seller's links.
  app.get("/", auth, async (ctx) => {
    return ctx.json({ links: await c.service.listLinks(ctx.get("seller").id) });
  });

  // CSV export of links for a date range.
  // NOTE: must be registered BEFORE /:id to avoid being shadowed by the wildcard.
  // Seller reconciliation export — gated, and scoped to the caller's own links.
  app.get("/export/csv", auth, requireScope("links:read"), async (ctx) => {
    const from = ctx.req.query("from");
    const to = ctx.req.query("to");
    const links = await c.service.listLinks(ctx.get("seller").id);

    // Filter by date range if provided.
    let filtered = links;
    if (from) {
      const fromMs = new Date(from).getTime();
      if (!isNaN(fromMs)) filtered = filtered.filter((l) => l.createdAt >= fromMs);
    }
    if (to) {
      const toMs = new Date(to).getTime();
      if (!isNaN(toMs)) filtered = filtered.filter((l) => l.createdAt <= toMs);
    }

    const header = "id,reference,title,amount,asset,status,payer,tx_hash,paid_amount,created_at,updated_at\n";
    const rows = filtered.map(
      (l) =>
        [
          l.id,
          l.reference,
          csvCell(l.title),
          l.amount,
          l.asset.code,
          l.status,
          l.payer ?? "",
          l.txHash ?? "",
          l.paidAmount ?? "",
          new Date(l.createdAt).toISOString(),
          new Date(l.updatedAt).toISOString(),
        ].join(","),
    );
    const csv = header + rows.join("\n");

    return ctx.newResponse(csv, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="quay-links-export.csv"`,
    });
  });

  // Fetch one link plus its payment request (for the checkout page).
  // PUBLIC by design — the link id is the bearer capability, and the buyer must
  // be able to read this to pay.
  //
  // The response is an explicit whitelist, not the stored row. This used to
  // return the whole PaymentLink, which meant anyone holding a link id could
  // read the seller's realized FX rate, the indicative-vs-firm spread, and the
  // anchor fees they paid (offrampRate, offrampRateDelta, offrampFeeAmount,
  // offrampNetTargetAmount, …) plus the internal sellerId. None of that is
  // needed to pay an invoice. Seller-facing views use the gated
  // GET /:id/detail, which still returns everything.
  app.get("/:id", async (ctx) => {
    const result = await c.service.getLink(ctx.req.param("id"), { logger: getLogger(ctx) });
    if (!result) return ctx.json({ error: "not_found" }, 404);
    return ctx.json({ link: toCheckoutView(result.link), request: result.request });
  });

  // Indicative off-ramp prices — SEP-38 GET /prices, no firm quote consumed.
  // Safe to call on every dashboard load (issue 3.5).
  // Optional query param: ?currency=NGN — when provided, the indicative rate for
  // that currency is persisted against the link for spread-delta telemetry.
  // Seller-only: this reads the seller's off-ramp corridor AND persists the
  // indicative rate against the link, so it must not be reachable with just a
  // link id.
  app.get("/:id/offramp-preview", auth, requireScope("links:read"), async (ctx) => {
    const currency = ctx.req.query("currency") ?? undefined;
    try {
      const owned = await c.service.getLink(ctx.req.param("id"));
      if (!owned) return ctx.json({ error: "not_found" }, 404);
      if (owned.link.sellerId !== ctx.get("seller").id) {
        return ctx.json({ error: "forbidden", message: "this link belongs to a different seller" }, 403);
      }
      const result = await c.service.getOfframpPreview(ctx.req.param("id"), currency);
      if (result === null) {
        // Adapter doesn't support indicative prices — return empty prices list
        // so the dashboard degrades gracefully.
        return ctx.json({ indicative: true, prices: [], sourceAmount: null });
      }
      return ctx.json(result);
    } catch (err) {
      if (err instanceof HttpError) return ctx.json({ error: err.message }, err.status as 404 | 409 | 502);
      throw err;
    }
  });

  // Field descriptors + masked saved fields for the cash-out form (issue #32).
  // Seller-only: it returns the seller's own saved payout destination, so it is
  // gated and ownership-checked like the other seller routes — never reachable
  // with just a link id.
  // OFFRAMP=none refuses every adapter call. That is a permanent property of
  // the deployment, not an anchor outage, so it answers 501 rather than the
  // 502 an unreachable anchor gets — a client that retries a 502 would spin
  // forever on this one.
  const OFFRAMP_DISABLED_BODY = {
    error: "offramp_disabled",
    message: "This deployment has no cash-out leg. Payments settle directly to the seller's wallet.",
  } as const;

  app.get("/:id/offramp-requirements", auth, requireScope("links:read"), async (ctx) => {
    try {
      const owned = await c.service.getLink(ctx.req.param("id"));
      if (!owned) return ctx.json({ error: "not_found" }, 404);
      if (owned.link.sellerId !== ctx.get("seller").id) {
        return ctx.json({ error: "forbidden", message: "this link belongs to a different seller" }, 403);
      }
      const result = await c.service.getOfframpRequirements(ctx.req.param("id"));
      return ctx.json(result);
    } catch (err) {
      if (err instanceof OffRampDisabledError) return ctx.json(OFFRAMP_DISABLED_BODY, 501);
      if (err instanceof HttpError) return ctx.json({ error: err.message }, err.status as 404 | 403 | 502);
      throw err;
    }
  });

  // Firm cash-out quote — gross/fee/net — without initiating anything (issue
  // 1.5). Seller-only: mirrors the ownership check on cash-out itself, since
  // this exercises the same KYC/health gates and hits the anchor for real.
  app.get("/:id/cash-out/quote", auth, requireScope("links:read"), async (ctx) => {
    const linkId = ctx.req.param("id");
    const targetCurrency = ctx.req.query("targetCurrency");
    if (!targetCurrency) return ctx.json({ error: "invalid_query", message: "targetCurrency is required" }, 400);
    try {
      const existing = await c.service.getLink(linkId);
      if (!existing) return ctx.json({ error: "not_found" }, 404);
      if (existing.link.sellerId !== ctx.get("seller").id) {
        return ctx.json({ error: "forbidden", message: "this link belongs to a different seller" }, 403);
      }
      const quote = await c.service.quoteCashOut(linkId, targetCurrency, { logger: getLogger(ctx) });
      return ctx.json(quote);
    } catch (err) {
      if (err instanceof OffRampDisabledError) return ctx.json(OFFRAMP_DISABLED_BODY, 501);
      if (err instanceof HttpError) return ctx.json({ error: err.message }, err.status as 403 | 404 | 409 | 502);
      throw err;
    }
  });

  // Seller-initiated cash-out to local currency.
  //
  // requireScope("offramp:initiate") is the point of that scope existing: it is
  // deliberately excluded from DEFAULT_SCOPES (see services/api-keys.ts) because
  // this route moves money, so a key must opt into it explicitly. Without the
  // guard mounted here, any key carrying only the default
  // links:read/links:write/webhooks:manage set could cash a paid link out — the
  // scope was documented and enforced nowhere.
  // Relay a transaction the buyer signed in their own wallet (issue #31).
  // Public and strict-rate-limited: the payer is a buyer holding a link, not an
  // authenticated seller, so there is no account to gate on. The XDR itself is
  // validated in full by the service before anything reaches Horizon.
  app.post("/:id/submit", strictRateLimit, async (ctx) => {
    const parsed = submitPaymentSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    try {
      const result = await c.service.submitPayment(ctx.req.param("id"), parsed.data.signedXdr, {
        logger: ctx.get("logger"),
      });
      return ctx.json(result, 200);
    } catch (err) {
      if (err instanceof HttpError) {
        return ctx.json({ error: err.message, ...(err.extra ?? {}) }, err.status as 400 | 404 | 409 | 502);
      }
      throw err;
    }
  });

  app.post("/:id/cash-out", strictRateLimit, auth, requireScope("offramp:initiate"), idempotent, async (ctx) => {
    const log = getLogger(ctx);
    const linkId = ctx.req.param("id");
    const parsed = cashOutSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) {
      log.warn({ event: "cashout.invalid", linkId, issues: parsed.error.issues }, "invalid cash-out body");
      return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }
    log.info({ event: "cashout.request.received", linkId }, "cash-out request received");
    try {
      const existing = await c.service.getLink(linkId);
      if (!existing) return ctx.json({ error: "not_found" }, 404);
      if (existing.link.sellerId !== ctx.get("seller").id) {
        log.warn({ event: "cashout.request.rejected", linkId }, "cash-out rejected: not the link's seller");
        return ctx.json({ error: "forbidden", message: "this link belongs to a different seller" }, 403);
      }
      const { job, initiation } = await c.service.triggerCashOut(linkId, parsed.data, { logger: log });
      log.info({ event: "cashout.request.ok", linkId, jobId: job.jobId }, "cash-out request succeeded");
      const interactiveUrl = initiation.kind === "interactive" ? initiation.url : undefined;
      return ctx.json({ job, interactiveUrl });
    } catch (err) {
      if (err instanceof OffRampDisabledError) {
        log.warn({ event: "cashout.request.disabled", linkId }, "cash-out requested but off-ramp is disabled");
        return ctx.json(OFFRAMP_DISABLED_BODY, 501);
      }
      if (err instanceof HttpError) {
        log.warn({ event: "cashout.request.error", linkId, error: err.message }, "cash-out request failed");
        return ctx.json({ error: err.message }, err.status as 403 | 404 | 409 | 502);
      }
      throw err;
    }
  });

  // Link detail with webhook deliveries (for the seller's timeline page).
  // Gated and ownership-checked: unlike GET /:id this is the seller's
  // reconciliation view and carries webhook delivery history.
  app.get("/:id/detail", auth, requireScope("links:read"), async (ctx) => {
    const result = await c.service.getLink(ctx.req.param("id"));
    if (!result) return ctx.json({ error: "not_found" }, 404);
    if (result.link.sellerId !== ctx.get("seller").id) {
      return ctx.json({ error: "forbidden", message: "this link belongs to a different seller" }, 403);
    }
    const deliveries = await c.webhooks.listDeliveriesByLinkId(result.link.id);
    return ctx.json({ link: result.link, request: result.request, deliveries });
  });

  // Seller voids a link they created by mistake. Idempotent: cancelling an
  // already-`cancelled` link is a successful no-op. Any state from which
  // `cancelled` is not reachable is rejected with 409 (the on-chain payment
  // must NOT be reversed client-side; the seller refunds out of band via the
  // off-ramp / from their own wallet). No request body.
  app.post("/:id/cancel", auth, requireScope("links:write"), async (ctx) => {
    try {
      // Ownership check mirrors cash-out: a link id alone must not let one
      // seller void another seller's link.
      const existing = await c.service.getLink(ctx.req.param("id"));
      if (!existing) return ctx.json({ error: "not_found" }, 404);
      if (existing.link.sellerId !== ctx.get("seller").id) {
        return ctx.json({ error: "forbidden", message: "this link belongs to a different seller" }, 403);
      }
      const link = await c.service.cancelLink(ctx.req.param("id"));
      return ctx.json({ link });
    } catch (err) {
      if (err instanceof HttpError) return ctx.json({ error: err.message }, err.status as 403 | 404 | 409);
      throw err;
    }
  });

  return app;
}

/**
 * The buyer-visible projection of a payment link.
 *
 * Whitelist, deliberately — a field is exposed to an unauthenticated holder of
 * the link id only if the checkout page or the embeddable widget actually
 * renders it. Everything about the seller's off-ramp economics stays behind the
 * gated seller routes.
 */
export function toCheckoutView(link: PaymentLink) {
  return {
    id: link.id,
    reference: link.reference,
    destination: link.destination,
    muxedId: link.muxedId,
    title: link.title,
    amount: link.amount,
    asset: link.asset,
    status: link.status,
    txHash: link.txHash,
    paidAmount: link.paidAmount,
    expiresAt: link.expiresAt,
    isDemo: link.isDemo,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}

/**
 * Quote a CSV cell and neutralise spreadsheet formula injection.
 *
 * Excel, LibreOffice and Google Sheets evaluate any cell whose first character
 * is `=`, `+`, `-`, `@`, or a leading tab/CR as a formula — so a link titled
 * `=cmd|'/c calc'!A1` becomes executable content in the reconciliation export.
 * Prefixing with an apostrophe makes the spreadsheet treat it as literal text;
 * the apostrophe is not displayed. Quotes are still doubled per RFC 4180.
 */
export function csvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  const needsGuard = /^[=+\-@\t\r]/.test(value);
  return `"${needsGuard ? `'${escaped}` : escaped}"`;
}

async function safeJson(ctx: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await ctx.req.json();
  } catch {
    return {};
  }
}
