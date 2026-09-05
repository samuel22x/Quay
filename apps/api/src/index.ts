import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./env";
import { createContainer } from "./services/container";
import { linkRoutes } from "./routes/links";
import { webhookRoutes } from "./routes/webhooks";
import { apiKeyRoutes } from "./routes/api-keys";
import { publicRoutes } from "./routes/public";
import { metricsRoutes } from "./routes/metrics";
import { authRoutes } from "./routes/auth";
import { wellKnownRoutes } from "./routes/well-known";
import { kycRoutes } from "./routes/kyc";
import { demoRoutes } from "./routes/demo";
import { telemetryRoutes } from "./routes/telemetry";
import { rateLimit, MemoryStore } from "./middleware/rate-limit";
import { RedisStore } from "./middleware/redis-store";
import { requestContext } from "./request-context";
import { buildAuthMiddleware, apiKeyRateLimitKey } from "./middleware/auth";

const SHUTDOWN_TIMEOUT_MS = env.shutdownTimeoutMs;

async function main(): Promise<void> {
  const container = await createContainer();
  const logger = container.logger;

  const app = new Hono();
  const rateLimitStore = env.redisUrl ? new RedisStore(env.redisUrl) : new MemoryStore();
  // MUST be installed before rate-limit (and everything else) so a 429 still
  // carries a requestId, and every route handler can call getLogger(ctx).
  app.use("*", requestContext(logger));
  app.use(
    "*",
    cors({
      origin: env.corsOrigins,
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      // The session cookie is sent cross-origin (API and web app are separate
      // hosts) — credentials: true plus an explicit (non-"*") origin list is
      // required for the browser to actually attach/accept it.
      credentials: true,
    }),
  );
  app.use(
    "*",
    rateLimit({
      windowMs: env.rateLimitWindowMs,
      max: env.rateLimitMax,
      store: rateLimitStore,
      trustProxyHops: env.trustProxyHops,
    }),
  );
  // Strict limiter for money/management routes. `keyFor` gives every API key
  // its own bucket (per-key rate limit, issue #40 item 4); everyone else is
  // still bucketed by client IP (issue #86).
  const strictRateLimit = rateLimit({
    windowMs: env.rateLimitStrictWindowMs,
    max: env.rateLimitStrictMax,
    store: rateLimitStore,
    trustProxyHops: env.trustProxyHops,
    keyFor: apiKeyRateLimitKey(container.apiKeys),
  });

  // Liveness: the process is up and answering HTTP at all.
  app.get("/health", async (ctx) => {
    const usdcTrustline = await container.service
      .checkSellerUsdcTrustline()
      .catch(() => ({ ok: false as const, reason: "check_failed", message: "trustline preflight check failed" }));
    return ctx.json({
      ok: true,
      network: container.config.network,
      sellerWallet: container.config.sellerWallet,
      usdcTrustline,
      horizon: container.horizonStatus(),
      // Anchor health probe + circuit breaker (issue #19, 3.7) so an operator
      // can tell "the anchor is down" apart from "the API is down" without
      // tailing logs.
      anchor: container.service.healthSnapshot(),
      // On-chain settlement attestation (issue 9.2). Published here because
      // "the contract is deployed" and "the running product actually calls it"
      // are different claims, and only the second one is worth anything to
      // someone deciding whether to trust a receipt. `enabled: false` is the
      // honest answer when it is off, not an omission.
      attestation: container.attestation,
    });
  });

  // Readiness: can this instance actually serve traffic right now? Distinct
  // from liveness — a container HEALTHCHECK / orchestrator readiness probe
  // should use this, not /health, to decide whether to route traffic here.
  // `ok` gates on the database ONLY. Watcher circuit-breaker state is reported
  // for diagnostics but deliberately does NOT fail readiness: this endpoint is
  // now Render's healthCheckPath and the Dockerfile HEALTHCHECK, and a Horizon
  // blip opening a breaker must not depool an instance that can still serve
  // checkout pages and link creation.
  app.get("/ready", async (ctx) => {
    const ok = await container.ready();
    const circuitBreakers = container.getWatcherCircuitBreakerStatus();
    const metrics = container.getWatcherMetrics();

    return ctx.json({
      ok,
      circuitBreakers,
      metrics: {
        accountsWatched: metrics.accountsWatched,
        tickDurationMs: metrics.tickDurationMs,
        circuitBreakersOpen: metrics.circuitBreakersOpen,
        perAccountLag: Object.fromEntries(metrics.perAccountLag),
      },
    }, ok ? 200 : 503);
  });

  app.route("/links", linkRoutes(container, strictRateLimit));
  app.route("/webhooks", webhookRoutes(container));

  // Receipt-specific limiter: tighter than the global cap but looser than
  // the strict bucket — buyers legitimately refresh receipts, but an IP
  // rotating through 120/min is well past what a public-read route needs.
  const receiptRateLimit = rateLimit({
    windowMs: env.rateLimitWindowMs,
    max: Math.floor(env.rateLimitMax / 2),
    store: rateLimitStore,
    trustProxyHops: env.trustProxyHops,
  });
  // CORS for the public receipt endpoint (accessible from any origin). Both
  // of these must be registered before `app.route("/r", ...)`: Hono runs
  // middleware in registration order, so anything mounted after the route it
  // targets never runs at all. The CORS line used to sit below, which is why
  // /r/:reference was answering cross-origin reads with no
  // Access-Control-Allow-Origin header.
  app.use("/r/*", receiptRateLimit);
  app.use("/r/*", cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] }));
  app.route("/r", publicRoutes(container));

  // API-key management (issue #40). Requires a session or an API key that
  // carries `api-keys:manage` — an unauthenticated caller gets a 401, and a
  // key without the scope gets a 403, so no one can mint keys by default.
  const apiKeyAuth = buildAuthMiddleware({
    session: container.auth.session,
    sellers: container.sellers,
    revocations: container.auth.revocations,
    apiKeyRepo: container.apiKeys,
  });
  app.use("/api-keys", strictRateLimit, apiKeyAuth);
  app.use("/api-keys/*", strictRateLimit, apiKeyAuth);
  app.route("/api-keys", apiKeyRoutes(container));

  app.route("/metrics", metricsRoutes(container));
  // /auth is a sensitive route — every attempt triggers a Horizon account
  // lookup, making it both an authentication surface and an outbound-traffic
  // amplifier.  Apply the strict limiter so brute-force or rotation attacks
  // hit 429 well before the global cap.
  app.use("/auth", strictRateLimit);
  app.route(
    "/auth",
    authRoutes({
      challenge: container.auth.challenge,
      session: container.auth.session,
      sellers: container.sellers,
      revocations: container.auth.revocations,
      secureCookie: container.auth.secureCookie,
    }),
  );
  app.route("/.well-known", wellKnownRoutes(container.auth.stellarToml));
  app.route("/seller/kyc", kycRoutes(container));
  app.route("/demo", demoRoutes(container));
  // Operator-only off-ramp telemetry (issue #20, 3.8). The routes gate
  // themselves on TELEMETRY_TOKEN (404 when unset), so mounting them
  // unconditionally is safe.
  app.route("/telemetry", telemetryRoutes(container));

  container.start();

  let server: ReturnType<typeof serve> | undefined = serve({ fetch: app.fetch, port: env.apiPort }, (info) => {
    logger.info(
      {
        event: "api.listening",
        port: info.port,
        network: container.config.network,
        horizon: container.config.horizonUrl,
        sellerWallet: container.config.sellerWallet,
        pollMs: env.pollMs,
      },
      `listening on http://localhost:${info.port}`,
    );
  });

  // Graceful shutdown: stop accepting new connections, let in-flight HTTP
  // requests finish, then stop the watcher/poller. A hard deadline guards
  // against a connection that never closes (e.g. a stuck keep-alive) so the
  // process still exits before the orchestrator's own SIGKILL timeout.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: "api.shutdown", signal }, "shutting down");

    const forceExit = setTimeout(() => {
      logger.warn({ event: "api.shutdown.forced" }, "shutdown grace period elapsed - forcing exit");
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.close(() => {
      container.stop();
      clearTimeout(forceExit);
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  // Logger may not be available yet (boot-time failure); fall back to stderr.
  process.stderr.write(`[api] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
