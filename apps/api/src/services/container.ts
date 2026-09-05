import { randomBytes } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  resolveStellarConfig,
  StellarRail,
  HorizonWatcher,
  StreamingHorizonWatcher,
  type HorizonStatus,
} from "@checkout/stellar";
import { DisabledOffRamp, MockAnchorOffRamp, NoKycRequired, TestAnchorKyc, TestAnchorOffRamp } from "@checkout/offramp";
import type { KycPort, Logger, OffRampPort, OffRampStateRepository, OffRampTelemetryRepository } from "@checkout/core";
import { env, type OffRampKind } from "../env";
import { createDb, bootstrap, type DB } from "../db/client";
import { parsePiiKey } from "../crypto/pii";
import { createLogger } from "../logger";
import {
  DrizzleLinkRepository,
  DrizzleSellerRepository,
  DrizzleWebhookRepository,
  DrizzleWatcherStateRepository,
  DrizzleTokenRevocationRepository,
  DrizzleOffRampStateRepository,
  DrizzleKycRepository,
  DrizzleOfframpTelemetryRepository,
  DrizzleApiKeyRepository,
} from "../repos/index";
import { LinkService, AnchorHealth } from "./link-service";
import { SorobanAttestation } from "@checkout/soroban";
import {
  WatcherLoop,
  startCashOutPoller,
  startAnchorProbeTimer,
  startAttestationSweeper,
  type AccountCircuitBreakerStatus,
  type WatcherMetrics,
} from "../worker/watcher-loop";
import { ChallengeService } from "./challenge";
import { RedisUsedChallengeStore } from "./redis-used-challenge-store";
import { horizonSignerFetcher } from "./horizon-signers";
import { SessionIssuer } from "./session";
import type { StellarTomlConfig } from "../routes/well-known";
import { CircuitBreakerOffRamp } from "./circuit-breaker";
import { WebhookWorker } from "../worker/webhook-worker";
import { WebhookSender } from "./webhook-sender";
import { assertKeyConfigured } from "./secret-crypto";

export interface Container {
  service: LinkService;
  logger: Logger;
  links: DrizzleLinkRepository;
  sellers: DrizzleSellerRepository;
  webhooks: DrizzleWebhookRepository;
  apiKeys: DrizzleApiKeyRepository;
  db: DB;
  kyc: KycPort;
  telemetry: OffRampTelemetryRepository;
  config: { network: string; horizonUrl: string; sellerWallet: string };
  horizonStatus(): HorizonStatus;
  /** Optional SSRF guard override for webhook URLs. Tests inject a permissive
   *  one so route tests do not depend on live DNS. */
  webhookGuard?: (url: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  metricsToken: string;
  /** Whether settlements are being attested on-chain, and to which registry.
   *  Surfaced on /health so "the contract is deployed" and "the product calls
   *  it" can be told apart from outside, without an account or a log tail. */
  attestation: { enabled: boolean; contractId: string | null };
  watcherLagSeconds(): number;
  circuitBreakerState(): number;
  auth: {
    challenge: ChallengeService;
    session: SessionIssuer;
    stellarToml: StellarTomlConfig;
    revocations: DrizzleTokenRevocationRepository;
    secureCookie: boolean;
  };
  start(): void;
  stop(): void;
  /** Readiness probe: can this instance actually serve traffic right now (i.e. is the database reachable)? Distinct from liveness (`/health`) - a process can be alive but not yet/no-longer able to serve. */
  ready(): Promise<boolean>;
  getWatcherCircuitBreakerStatus(): AccountCircuitBreakerStatus[];
  getWatcherMetrics(): WatcherMetrics;
}

export async function createContainer(): Promise<Container> {
  // Root pino logger is the single source. The request-context middleware
  // builds child loggers bound to requestId/method/path and routes pass
  // those children explicitly into service calls — so deep subsystems
  // (LinkService, off-ramp adapters, webhook sender) inherit requestId
  // without us needing any ambient / AsyncLocalStorage plumbing.
  const logger = createLogger({ level: env.logLevel, base: { network: env.network } });

  // Resolve the webhook-secret encryption key NOW rather than lazily on the
  // first encrypt/decrypt. `secret-crypto.ts` throws when the key is missing in
  // production — but it is only reached when a seller first registers a
  // webhook, so a misconfigured deploy boots green and fails on a customer's
  // request hours later. Touching it here turns that into a boot failure the
  // deploy itself surfaces.
  assertKeyConfigured();

  const stellar = resolveStellarConfig({
    network: env.network,
    horizonUrl: env.horizonUrl,
    usdcIssuer: env.usdcIssuer,
  });

  const { db, client } = createDb(env.databaseUrl, env.databaseAuthToken);
  await bootstrap(client);

  const linksRepo = new DrizzleLinkRepository(db);
  const sellersRepo = new DrizzleSellerRepository(db);
  const webhooksRepo = new DrizzleWebhookRepository(db);
  const stateRepo = new DrizzleWatcherStateRepository(db);
  const revocationsRepo = new DrizzleTokenRevocationRepository(db);
  const offrampStateRepo = new DrizzleOffRampStateRepository(db);
  const telemetryRepo = new DrizzleOfframpTelemetryRepository(db);
  const apiKeysRepo = new DrizzleApiKeyRepository(db);

  const seller = resolveSellerKeypairOrWallet(logger);
  const sellerWallet = seller.publicKey;
  await sellersRepo.ensureDefault(sellerWallet, env.defaultSellerName);

  const rail = new StellarRail(stellar);
  // Polling watcher gets the retry / fallback / degraded-tracking wrapper
  // (issue #10). The streaming path has its own reconnect handling.
  const pollingWatcher = new HorizonWatcher({
    primaryServer: stellar.horizonUrl,
    fallbackServer: env.horizonUrlFallback,
    degradedThreshold: env.horizonDegradedThreshold,
    log: (m) => console.log(`[horizon] ${m}`),
  });
  const watcher =
    env.watchMode === "stream"
      ? new StreamingHorizonWatcher(stellar.horizonUrl, { log: (m) => console.log(`[watcher:stream] ${m}`) })
      : pollingWatcher;
  const offramp = new CircuitBreakerOffRamp(createOffRamp(seller.keypair, offrampStateRepo, logger));
  const kyc = createKyc(seller.keypair, db);

  // Anchor health probe + circuit breaker (issue #19, 3.7). With mock or no
  // off-ramp the probe is disabled and short-circuits to "always available" so
  // the surface still works offline; for testanchor/anchor we hit the real
  // anchor.
  const anchorHealth = buildAnchorHealth(env.offramp, sellerWallet);

  // Resolved before the service because the attester IS the SEP-10 signing
  // identity: the key a wallet already authenticated against is the one that
  // vouches for receipts, so a verifier has exactly one identity to trust.
  const serverKeypair = resolveServerSigningKeypair();
  const attestation = createAttestation(serverKeypair, stellar.networkPassphrase, logger);

  const service = new LinkService({
    links: linksRepo,
    sellers: sellersRepo,
    webhooks: webhooksRepo,
    rail,
    offramp,
    offrampState: offrampStateRepo,
    kyc,
    attestation,
    stellar,
    telemetry: telemetryRepo,
    health: anchorHealth,
    correlation: env.correlation,
    logger,
  });

  // A link stuck in `offramp_pending` whose job has no row in offramp_jobs was
  // orphaned by a restart before this state was persisted (or, going forward,
  // a genuinely lost job). Recoverable state doesn't exist for it — fail it out
  // so the seller isn't stuck in silent limbo.
  const backfilled = await service.backfillLostOffRampJobs();
  if (backfilled > 0) {
    console.log(`[offramp] backfilled ${backfilled} link(s) stuck with lost job state -> offramp_failed`);
  }

  const loop = new WatcherLoop({
    watcher,
    links: linksRepo,
    state: stateRepo,
    service,
    pollMs: env.pollMs,
    logger,
    pageLimit: env.watchPageLimit,
    maxPagesPerTick: env.watchMaxPagesPerTick,
    log: (m) => console.log(`[watcher] ${m}`),
  });

  // The worker's own sender: it performs a single hardened attempt per tick and
  // leaves retry scheduling to the queue, so its maxAttempts is deliberately 1.
  const webhookWorker = new WebhookWorker(
    webhooksRepo,
    new WebhookSender(webhooksRepo, { maxAttempts: 1, logger }),
    { log: (m) => console.log(`[webhook] ${m}`) },
  );
  const metricsToken = resolveMetricsToken();
  const challenge = new ChallengeService({
    serverKeypair,
    homeDomain: env.homeDomain,
    webAuthDomain: env.webAuthDomain,
    networkPassphrase: stellar.networkPassphrase,
    fetchAccountSigners: horizonSignerFetcher(stellar.horizonUrl),
    // Same REDIS_URL branch the rate limiter uses (index.ts) — without it,
    // "single-use" only holds per process (issue 6.7).
    usedChallengeStore: env.redisUrl ? new RedisUsedChallengeStore(env.redisUrl) : undefined,
  });
  const session = new SessionIssuer(resolveJwtSecret());
  const stellarToml: StellarTomlConfig = {
    signingKey: serverKeypair.publicKey(),
    webAuthEndpoint: `https://${env.webAuthDomain}/auth`,
    networkPassphrase: stellar.networkPassphrase,
    orgName: env.defaultSellerName,
  };

  let stopPoller: (() => void) | null = null;
  let stopRevocationSweep: (() => void) | null = null;
  let stopProbe: (() => void) | null = null;
  let stopAttestationSweep: (() => void) | null = null;

  return {
    service,
    logger,
    links: linksRepo,
    sellers: sellersRepo,
    webhooks: webhooksRepo,
    apiKeys: apiKeysRepo,
    db,
    kyc,
    telemetry: telemetryRepo,
    config: { network: stellar.network, horizonUrl: stellar.horizonUrl, sellerWallet },
    horizonStatus: () => pollingWatcher.getStatus(),
    metricsToken,
    attestation: { enabled: attestation !== undefined, contractId: attestation?.contractId ?? null },
    watcherLagSeconds: () => loop.getLagSeconds(),
    circuitBreakerState: () => offramp.getStateNumeric(),
    auth: { challenge, session, stellarToml, revocations: revocationsRepo, secureCookie: env.cookieSecure },
    start() {
      logger.info({ event: "watcher.start", pollMs: env.pollMs }, "watcher started");
      loop.start();
      webhookWorker.start();
      // With no off-ramp there is nothing to advance: no link can reach
      // offramp_pending, so the poller would query an always-empty set on
      // every tick forever. The anchor probe is likewise pointless with no
      // anchor — buildAnchorHealth already disables it, and this skips the
      // timer that would only call a disabled probe.
      if (env.offramp !== "none") {
        stopPoller = startCashOutPoller(service, Math.max(3000, env.pollMs));
        stopProbe = startAnchorProbeTimer(anchorHealth, 60_000);
      }
      if (attestation) {
        stopAttestationSweep = startAttestationSweeper(service, env.attestationSweepMs, logger);
      }
      const sweepTimer = setInterval(
        () => void revocationsRepo.sweepExpired(Math.floor(Date.now() / 1000)),
        60 * 60 * 1000, // hourly — revocation rows are cheap and self-limiting (max 24h lifetime) anyway
      );
      stopRevocationSweep = () => clearInterval(sweepTimer);
    },
    async stop() {
      await loop.stop();
      webhookWorker.stop();
      stopPoller?.();
      stopRevocationSweep?.();
      if (watcher instanceof StreamingHorizonWatcher) watcher.stop();
      stopProbe?.();
      stopAttestationSweep?.();
      stopPoller = null;
      stopProbe = null;
      stopAttestationSweep = null;
      // Attestations are fire-and-forget, but killing the DB client out from
      // under one in flight turns a clean "not attested yet" into a crash in
      // the logs. Join them first; each already has its own error handling.
      await service.whenAttestationsSettled();
      await client.close();
      console.log("[api] all services stopped");
    },
    getWatcherCircuitBreakerStatus() {
      return loop.getCircuitBreakerStatus();
    },
    getWatcherMetrics() {
      return loop.getMetrics();
    },
    async ready() {
      try {
        await client.execute("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Build an AnchorHealth with sensible defaults anchored at the public Stellar
 * testnet reference sandbox. Caller can override via env (read raw — we keep
 * the surface minimal and don't pollute env.ts which lives outside the
 * scope of issue 3.7).
 */
function buildAnchorHealth(offrampKind: OffRampKind, probeAccount: string): AnchorHealth {
  const enabled = offrampKind === "testanchor" || offrampKind === "anchor";
  // For OFFRAMP=anchor env.ts already required both of these, so the ??
  // fallbacks only ever apply to the testanchor sandbox preset.
  const url = enabled ? env.anchorUrl ?? "https://testanchor.stellar.org" : null;
  const homeDomain = enabled ? env.anchorHomeDomain ?? "testanchor.stellar.org" : null;
  const failureThreshold = Number(process.env.ANCHOR_PROBE_FAILURE_THRESHOLD ?? "3");
  const cooldownMs = Number(process.env.ANCHOR_PROBE_COOLDOWN_MS ?? "30000");
  return new AnchorHealth({
    enabled,
    url,
    homeDomain,
    // The configured seller wallet is a real, funded account, which is what the
    // anchor requires to issue a challenge.
    probeAccount: enabled ? probeAccount : null,
    failureThreshold: Number.isFinite(failureThreshold) && failureThreshold > 0 ? failureThreshold : 3,
    cooldownMs: Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : 30_000,
  });
}

/**
 * Builds the on-chain attestation adapter, or returns undefined when the
 * registry isn't configured (issue 9.2).
 *
 * Unconfigured is a supported state, not a degraded one: settlement is proven
 * by the classic ledger either way, and a receipt without an attestation simply
 * doesn't claim to have one. That is why this returns undefined rather than
 * throwing — a missing contract id must never keep the API from booting and
 * taking payments.
 */
function createAttestation(
  attester: Keypair,
  networkPassphrase: string,
  logger: Logger,
): SorobanAttestation | undefined {
  if (!env.attestationContractId) {
    // Say so. A silent undefined here means the deployed API takes payments and
    // attests nothing, and the only outward sign is a receipt quietly missing a
    // block nobody was watching for.
    logger.warn(
      { event: "attestation.disabled", reason: "no_contract_id" },
      "ATTESTATION_CONTRACT_ID is not set — settlements will not be attested on-chain",
    );
    return undefined;
  }
  if (!env.sorobanRpcUrl) {
    logger.warn(
      { event: "attestation.disabled", reason: "no_rpc_url" },
      "ATTESTATION_CONTRACT_ID is set but SOROBAN_RPC_URL is not — attestation disabled",
    );
    return undefined;
  }
  logger.info(
    {
      event: "attestation.configured",
      contractId: env.attestationContractId,
      rpcUrl: env.sorobanRpcUrl,
      attester: attester.publicKey(),
    },
    "on-chain settlement attestation enabled",
  );
  return new SorobanAttestation({
    contractId: env.attestationContractId,
    rpcUrl: env.sorobanRpcUrl,
    networkPassphrase,
    attester,
    logger,
  });
}

/**
 * Resolves the seller's public key, plus its Keypair when we actually hold the
 * secret in-memory (auto-generated testnet keypair, or DEFAULT_SELLER_SECRET
 * explicitly supplied). The Keypair is only needed to sign the SEP-10 auth
 * challenge for `OFFRAMP=testanchor` — never persisted beyond this process.
 *
 * The one human-facing line of output (the testnet convenience banner with
 * the secret) is guarded by `LOG_LEVEL=debug|trace` so an ordinary run never
 * echoes the seller key. When plaintext output is wanted, set LOG_LEVEL=debug.
 */
function resolveSellerKeypairOrWallet(logger: Logger): { keypair: Keypair | null; publicKey: string } {
  if (env.defaultSellerWallet) {
    if (!StrKey.isValidEd25519PublicKey(env.defaultSellerWallet)) {
      throw new Error("DEFAULT_SELLER_WALLET is not a valid Stellar G-address");
    }
    if (!env.defaultSellerSecret) {
      logger.info(
        { event: "seller.configured", wallet: env.defaultSellerWallet, hasSecret: false, network: env.network },
        "seller wallet configured (no secret loaded)",
      );
      return { keypair: null, publicKey: env.defaultSellerWallet };
    }
    const kp = Keypair.fromSecret(env.defaultSellerSecret);
    if (kp.publicKey() !== env.defaultSellerWallet) {
      throw new Error("DEFAULT_SELLER_SECRET does not match DEFAULT_SELLER_WALLET");
    }
    logger.info(
      { event: "seller.configured", wallet: kp.publicKey(), hasSecret: true, network: env.network },
      "seller wallet configured (secret loaded)",
    );
    return { keypair: kp, publicKey: kp.publicKey() };
  }
  if (env.network === "public") {
    throw new Error("Set DEFAULT_SELLER_WALLET to your wallet address before running on public network");
  }
  // Testnet convenience: generate a throwaway account and tell the operator how to fund it.
  // The plaintext secret banner is opt-in (LOG_LEVEL=debug|trace) so an ordinary
  // pino runtime never echoes a secret.
  const kp = Keypair.random();
  const pub = kp.publicKey();
  logger.warn(
    {
      event: "seller.generated",
      publicKey: pub,
      fund: `https://friendbot.stellar.org/?addr=${pub}`,
      network: env.network,
    },
    "no DEFAULT_SELLER_WALLET set — generated throwaway testnet seller",
  );
  if (process.env.LOG_LEVEL === "debug" || process.env.LOG_LEVEL === "trace") {
    process.stdout.write(
      [
        "",
        "──────────────────────────────────────────────────────────────────",
        " Testnet seller key (LOG_LEVEL=debug printed this once):",
        ` Public key (receives funds): ${pub}`,
        ` Secret key (import into a wallet to move funds): ${kp.secret()}`,
        " Set DEFAULT_SELLER_WALLET/DEFAULT_SELLER_SECRET in .env to reuse.",
        "──────────────────────────────────────────────────────────────────",
        "",
      ].join("\n") + "\n",
    );
  }
  return { keypair: kp, publicKey: pub };
}

/**
 * Both `testanchor` and `anchor` are the same SEP-6 adapter; they differ only
 * in whether the endpoint is the SDF sandbox or an operator-supplied
 * production anchor. Passing the URL/domain through as `undefined` for
 * `testanchor` lets the adapter's own testnet defaults stand, so the sandbox
 * preset keeps working with no configuration at all.
 */
function createOffRamp(
  sellerKeypair: Keypair | null,
  state: OffRampStateRepository,
  logger: Logger,
): OffRampPort {
  if (env.offramp === "none") {
    // No cash-out leg. Every method throws OffRampDisabledError, which the
    // routes translate to 501 — see packages/offramp/src/disabled.ts.
    return new DisabledOffRamp();
  }
  if (env.offramp === "mock") {
    // Demo off-ramp: settles 8s after a seller triggers cash-out. NOT a real anchor.
    return new MockAnchorOffRamp({ state, settleAfterMs: 8000 });
  }
  if (!sellerKeypair) {
    throw new Error(
      `OFFRAMP=${env.offramp} requires the seller's secret key to sign SEP-10 auth: ` +
        "set DEFAULT_SELLER_SECRET (matching DEFAULT_SELLER_WALLET), or leave " +
        "DEFAULT_SELLER_WALLET unset on testnet to use the auto-generated keypair.",
    );
  }
  return new TestAnchorOffRamp({
    sellerKeypair,
    state,
    baseUrl: env.anchorUrl,
    homeDomain: env.anchorHomeDomain,
    preferredWithdrawType: env.offrampType,
    logger,
  });
}

function createKyc(sellerKeypair: Keypair | null, db: DB): KycPort {
  if (env.offramp === "mock" || env.offramp === "none") {
    // No real anchor, nothing to be compliant with. For "none" there is no
    // cash-out to gate at all; for "mock" it never gates the simulated one.
    return new NoKycRequired();
  }
  if (!sellerKeypair) {
    throw new Error(
      `OFFRAMP=${env.offramp} requires the seller's secret key to sign SEP-10 auth: ` +
        "set DEFAULT_SELLER_SECRET (matching DEFAULT_SELLER_WALLET), or leave " +
        "DEFAULT_SELLER_WALLET unset on testnet to use the auto-generated keypair.",
    );
  }
  // env.kycEncryptionKey is guaranteed set whenever OFFRAMP != mock (see env.ts).
  const repo = new DrizzleKycRepository(db, parsePiiKey(env.kycEncryptionKey as string));
  return new TestAnchorKyc({
    sellerKeypair,
    repo,
    baseUrl: env.anchorUrl,
    homeDomain: env.anchorHomeDomain,
  });
}

/**
 * Resolves the keypair that SIGNS SEP-10 challenges — the platform's own login
 * identity, distinct from any seller's wallet. Required to be stable
 * (SERVER_SIGNING_SECRET) on public network; auto-generates a throwaway testnet
 * keypair otherwise, same convenience as `resolveSellerKeypairOrWallet`.
 */
function resolveServerSigningKeypair(): Keypair {
  if (env.serverSigningSecret) return Keypair.fromSecret(env.serverSigningSecret);
  if (env.network === "public") {
    throw new Error("Set SERVER_SIGNING_SECRET before running on public network (SEP-10 needs a stable signing key)");
  }
  const kp = Keypair.random();
  console.log(
    [
      "",
      "──────────────────────────────────────────────────────────────────",
      " No SERVER_SIGNING_SECRET set — generated a TESTNET SEP-10 signing keypair.",
      ` Signing key (in stellar.toml): ${kp.publicKey()}`,
      " Set SERVER_SIGNING_SECRET in .env to keep this stable across restarts —",
      " every restart otherwise invalidates in-flight sessions and stellar.toml.",
      "──────────────────────────────────────────────────────────────────",
      "",
    ].join("\n"),
  );
  return kp;
}

/** Resolves the JWT session secret. Required on public network; auto-generates
 *  an ephemeral one on testnet (sessions won't survive a restart). */
function resolveJwtSecret(): string {
  if (env.jwtSecret) return env.jwtSecret;
  if (env.network === "public") {
    throw new Error("Set JWT_SECRET before running on public network (needed to mint stable sessions)");
  }
  console.log(" No JWT_SECRET set — generated an ephemeral testnet session secret (won't survive a restart).");
  return randomBytes(32).toString("hex");
}

/** Resolves the bearer token that gates `GET /metrics`. Auto-generates an
 *  ephemeral one (printed once at boot) if METRICS_TOKEN isn't set — the
 *  endpoint is always gated, never open by default. */
function resolveMetricsToken(): string {
  if (env.metricsToken) return env.metricsToken;
  const token = randomBytes(24).toString("hex");
  console.log(` No METRICS_TOKEN set — generated an ephemeral one for /metrics: ${token}`);
  return token;
}
