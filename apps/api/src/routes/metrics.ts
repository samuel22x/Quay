import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import type { Container } from "../services/container";
import { metrics } from "../metrics";
import { getLogger, type RequestContextVariables } from "../request-context";

/** Length-independent constant-time comparison. `timingSafeEqual` throws on a
 *  length mismatch, and the length itself is the first thing a `!==` leaks. */
function secretEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // Compare a fixed-size digest-shaped padding so differing lengths still cost
  // the same as matching ones.
  const len = Math.max(bufA.length, bufB.length);
  const padA = Buffer.alloc(len);
  const padB = Buffer.alloc(len);
  bufA.copy(padA);
  bufB.copy(padB);
  return timingSafeEqual(padA, padB) && bufA.length === bufB.length;
}

/** `GET /metrics` in Prometheus text format, guarded by a bearer token
 *  (`Authorization: Bearer <token>` or `?token=`). */
export function metricsRoutes(container: Container): Hono<{ Variables: RequestContextVariables }> {
  const app = new Hono<{ Variables: RequestContextVariables }>();

  app.get("/", async (ctx) => {
    const header = ctx.req.header("authorization");
    const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    const queryToken = ctx.req.query("token");
    const provided = bearer ?? queryToken;

    // `?token=` is still honoured so existing scrape configs keep working, but
    // it puts a bearer secret in proxy access logs, browser history and Referer
    // headers. Warn on use; the header is the supported form.
    if (!bearer && queryToken) {
      getLogger(ctx).warn(
        { event: "metrics.deprecated_query_token" },
        "GET /metrics authenticated via ?token= — use `Authorization: Bearer <token>` instead; the query parameter leaks the token into request logs",
      );
    }

    // Constant-time: `!==` leaks a prefix-match oracle through response timing.
    if (!provided || !secretEquals(provided, container.metricsToken)) {
      return ctx.text("unauthorized\n", 401);
    }

    const [accounts, pendingCashOuts] = await Promise.all([
      container.links.activeDestinations(),
      container.links.listByStatus("offramp_pending"),
    ]);
    metrics.accountsWatched.set(accounts.length);
    metrics.pendingCashOuts.set(pendingCashOuts.length);
    metrics.webhookQueueDepth.set(await container.service.webhookQueueDepth());
    metrics.circuitBreakerState.set(container.circuitBreakerState());
    metrics.watcherLagSeconds.set(container.watcherLagSeconds());

    return ctx.text(metrics.registry.render(), 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });

  return app;
}
