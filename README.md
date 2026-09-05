# Stellar Checkout

[![CI](https://github.com/determined-001/Quay/actions/workflows/ci.yml/badge.svg)](https://github.com/determined-001/Quay/actions/workflows/ci.yml)
[![Anchor Probe](https://github.com/determined-001/Quay/actions/workflows/anchor-probe.yml/badge.svg)](https://github.com/determined-001/Quay/actions/workflows/anchor-probe.yml)

Stellar Checkout is the open-source, non-custodial merchant checkout for the Stellar anchor network — the inbound counterpart to the Stellar Disbursement Platform.

**Live demo (Stellar testnet):** [dashboard](https://quay-web.vercel.app) ·
[API](https://quay-api.onrender.com/health) — create a link, pay it from any
testnet wallet with the shown memo, and watch it flip to **paid**. Cash-out runs
a real SEP-10 → SEP-38 → SEP-6 flow against `testanchor.stellar.org` (USD quotes;
testnet only, no real money moves).

[![API uptime](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/determined-001/Quay/main/docs/uptime-badge-api.json)](docs/STATUS.md)
[![Web uptime](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/determined-001/Quay/main/docs/uptime-badge-web.json)](docs/STATUS.md)
[![Synthetic check](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/determined-001/Quay/main/docs/uptime-badge-synthetic.json)](docs/STATUS.md)
Checked every 5 minutes — see [`docs/STATUS.md`](docs/STATUS.md) for the last 90 days.

The loop, end to end:

1. A seller creates a payment link in the dashboard (title + amount + asset).
2. The buyer opens the checkout page, scans a QR (or taps a wallet deep-link), and pays
   **USDC straight to the seller's own Stellar wallet** — nothing is custodied in between.
3. A backend worker watches the ledger, matches the incoming payment to the link by memo,
   marks it **paid**, and fires any registered webhooks.
4. When the seller wants cash, they trigger a **seller-initiated** cash-out to local currency
   through the off-ramp adapter.

This is the non-custodial version of a hosted checkout (think Stripe-style PaymentIntent),
built on the chain whose anchor network can actually settle to local rails.

---

## Quickstart (5-Minute Integration)

### 1. Install the Widget
Embed the lightweight modal checkout script tag in your HTML and attach it to any button:

```html
<!-- Include widget script -->
<script src="https://quay-web.vercel.app/widget.js"></script>

<!-- Pay button bound to link ID -->
<button data-stellar-checkout="lnk_123">Pay with USDC</button>

<!-- Or trigger programmatically in JavaScript -->
<script>
  StellarCheckout.open("lnk_123");
</script>
```

**Self-hosting the widget?** Point the script tag at your own deployment and
the widget infers the host from its own `<script src>` automatically - no
extra config needed. If you load `widget.js` some other way (bundled,
inlined, injected without a matching `<script src="...widget.js">` tag),
`Quay.open()` **cannot detect the host and will not guess** — pass it explicitly:

```js
Quay.open({ linkId: "lnk_123", host: "https://checkout.your-domain.com" });
```

A widget that can't determine its host throws a clear error rather than
silently pointing at someone else's deployment.

### 2. Create a Link via API

Both write endpoints require authentication. Mint an API key from the dashboard
(**API keys → Create**, after signing in with your Stellar wallet) and send it
as a bearer token — the plaintext key is shown once, at creation.

Keys are scoped. The default set (`links:read`, `links:write`,
`webhooks:manage`) covers everything in this quickstart; `offramp:initiate`
moves money and must be requested explicitly.

Generate a payment link from your backend server:

```bash
curl -X POST https://quay-api.onrender.com/links \
  -H "Authorization: Bearer ak_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "T-shirt",
    "amount": "10.50",
    "assetCode": "USDC"
  }'
```

**Response (201 Created):**
```json
{
  "link": {
    "id": "lnk_123",
    "reference": "ref_abc",
    "status": "pending",
    "title": "T-shirt",
    "amount": "10.50",
    "asset": { "code": "USDC", "issuer": "GBBD456..." },
    "destination": "GAHK789..."
  },
  "request": {
    "uri": "web+stellar:pay?destination=GAHK789...&amount=10.50&memo=ref_abc",
    "memo": "ref_abc",
    "memoType": "text"
  }
}
```

### 3. Receive the Webhook
Register your endpoint to receive real-time JSON notifications when payments land on-chain:

```bash
curl -X POST https://quay-api.onrender.com/webhooks \
  -H "Authorization: Bearer ak_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://your-domain.com/api/webhooks/checkout" }'
```

Verify incoming HMAC-SHA256 signatures (`x-checkout-signature: sha256=<hex>`) in your webhook route:

```javascript
const crypto = require("crypto");

function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}
```

---

## Why it's shaped this way

The link + checkout + on-chain payment is the easy, commodity part. The **off-ramp is the
hard 80% and the whole moat** — and it isn't a step you bolt on, it's a corridor walking back
in: FX rate risk in flight, KYC on the payout, reconciliation that proves local currency
landed, recovery when the anchor is down.

So two deliberate boundaries are baked into the architecture:

- **Off-ramp runs `seller_initiated`, not `inline`.** The seller receives the stablecoin to a
  wallet they control and cashes out as a separate, authorized action. Custody stays at the
  edges. `inline` mode (value routed through the anchor mid-flight, seller receives local
  currency directly) is what merchants ultimately want — and it is the mode that puts you in
  the money-transmission / custody box. The `OffRampPort` already models both modes; do not
  flip to `inline` until a licensed anchor relationship and a compliance story are real.

- **Ports-and-adapters everywhere.** The domain never imports a chain SDK. `RailPort`,
  `WatcherPort`, and `OffRampPort` are the seams. Today: a Stellar (SEP-7 + Horizon) rail and a
  mock anchor. Tomorrow: the same `PaymentIntent` spine behind an `adapter-gateway` (Arc/Circle)
  or a different chain — without touching the domain or the worker.

---

## Monorepo layout

```
packages/
  core/        Domain brain — entities, status machine, money math, SEP-7 builder,
               the pure payment matcher, port interfaces, zod schemas.  (29 unit tests)
  stellar/     Stellar adapter — SEP-7 rail + Horizon polling watcher (RailPort/WatcherPort).
  offramp/     Off-ramp adapter — MockAnchorOffRamp (OffRampPort, seller_initiated).  *** mock ***
apps/
  api/         Hono API + Drizzle (libSQL) + the ledger-watching worker.
  web/         Next.js (App Router) seller dashboard + buyer checkout page + widget.js.
```

`core` is the only package with business logic worth unit-testing in isolation, and it is:
money is compared in integer **stroops** (never floats), the status machine rejects illegal
transitions, the SEP-7 builder is spec-checked, and the matcher is exhaustively tested for
paid / overpaid / underpaid / wrong-asset / no-memo / unknown-reference.

---

## Run it locally

Requirements: Node 20+ and pnpm 9.

```bash
pnpm install
cp .env.example .env
```

Two processes (two terminals):

```bash
# 1) API + ledger watcher  →  http://localhost:8787
pnpm --filter @checkout/api dev

# 2) Web dashboard + checkout  →  http://localhost:3000
pnpm --filter @checkout/web dev
```

On first boot with no `DEFAULT_SELLER_WALLET` set, the API generates a **throwaway testnet
keypair**, prints it, and gives you a Friendbot link to fund it. Set `DEFAULT_SELLER_WALLET`
in `.env` to a wallet you control to reuse a stable address across restarts.

Then: open the dashboard, create a link, open its checkout page, and pay the displayed amount
of USDC **with the shown memo** from any Stellar testnet wallet. Within a poll interval the
dashboard flips the link to **paid**; hit **Cash out to NGN** to exercise the off-ramp seam.

Useful scripts (from the repo root):

```bash
pnpm typecheck   # all packages
pnpm test        # core unit tests
pnpm build       # builds the web app
pnpm sweep       # pre-entry ritual: uptime + synthetic checks against the live demo
```

### Demo seed (pre-populated dashboard)

Instead of starting from a blank screen, seed the dashboard with real on-chain data in about a
minute. It reads `STELLAR_NETWORK` the same way the API does (defaulting to testnet), so it
works against a mainnet or self-hosted deployment too — not just testnet:

```bash
# With the API already running on http://localhost:8787:
pnpm demo:seed
```

Prerequisite: `DEFAULT_SELLER_SECRET` in `.env` (matching the `DEFAULT_SELLER_WALLET` the API
is running with). Since auth landed, every `/links` route is seller-authenticated, so the script
logs in as the configured demo seller via SEP-10 and creates the links under that same seller —
otherwise the dashboard you already know would have nothing to show.

What it does:

1. Generates a fresh buyer keypair. On testnet, funds it via Friendbot (XLM) and the testanchor
   USDC dispenser. On any other network neither exists, so this step is skipped with a clear
   message — fund the printed buyer address yourself, or the payment step below fails with the
   real Horizon error instead of an obscure one.
2. Authenticates as the demo seller (SEP-10 challenge → session token).
3. Creates several payment links via `POST /links` (flagged as demo data). The `/demo`
   storefront page's "Pay with Quay" button reads the first of these from `GET /demo/link`,
   so it points at a link that actually exists rather than a hardcoded id.
4. Submits real Stellar payments from the buyer to the seller wallet using each link's memo so
   the on-chain watcher can match them.
5. Waits for the watcher to mark the links **paid**, then triggers a cash-out on one so the
   dashboard shows an `offramp_settled` row.

Every seeded row is real on-chain data — nothing is written directly to the database. Demo rows
are labelled with a **demo** badge in the dashboard so they are easy to tell apart from links you
create yourself.

```bash
# Remove all demo-flagged rows:
pnpm demo:reset
```

`demo:reset` calls `POST /demo/reset` on the running API. It's testnet-only (returns 403 on
the public network) and requires a seller session, so the script logs in as the same demo
seller using `DEFAULT_SELLER_SECRET`.

---

## Docker image (`apps/api`)

`apps/api/Dockerfile` is a 3-stage build (`deps` → `build` → `runtime`): the
runtime stage carries only apps/api's real npm production dependencies (all
workspace source is bundled into one compiled `dist/index.js` via esbuild -
see the `build` script in `apps/api/package.json`) and runs as the non-root
`node` user.

- **Base image** is pinned by digest (`node:22-alpine@sha256:...`, see the
  `ARG BASE_IMAGE` at the top of the Dockerfile) - bump it at least monthly,
  or immediately on a disclosed CVE, per that same comment.
- **Signals**: `tini` runs as PID 1 (`ENTRYPOINT`) so `SIGTERM` actually
  reaches the Node process, which drains in-flight HTTP requests before
  exiting (`apps/api/src/index.ts`).
- **Health**: `/health` is liveness (process is up); `/ready` is readiness
  (database is actually reachable) - the `HEALTHCHECK` and Render's
  `healthCheckPath` both use `/ready`.
- **Size target**: under 200 MB, enforced in CI (`.github/workflows/ci.yml`'s
  `docker` job fails the build if it isn't). Not independently measured
  outside CI in this change - no Docker daemon was available in the
  environment this change was authored in, so the size shown above is a
  target the CI job checks on every push, not a number hand-verified here.
- **Security scanning**: the same CI job runs a Trivy scan, failing on any
  HIGH/CRITICAL finding.
- **Read-only root filesystem**: the app writes nothing to disk in
  production (remote Turso database, no local files), so the image is
  compatible with `docker run --read-only --tmpfs /tmp` or an orchestrator's
  equivalent read-only-root setting - Render's blueprint format has no field
  for this today, so it isn't set in `render.yaml`, but nothing in the image
  requires a writable root filesystem.

---

## What's real vs. stubbed

| Piece | Status |
| --- | --- |
| SEP-7 payment-request URIs | **Real**, spec-correct (native vs issued asset, memo ≤28 bytes, %20 encoding, network passphrase). |
| Horizon payment watching + memo matching | **Real** logic against the Stellar SDK v16 API. Polling (restart-safe), idempotent via persisted cursor + processed-tx ledger. One Horizon request per page (`join=transactions` for the memo lookup, not one-plus-N), and a transaction-fetch failure retries the tick rather than silently parking a matchable payment as `no_memo`. Every Horizon call retries transient failures (3 attempts, exponential backoff + full jitter, honors `Retry-After` on 429) and can fail over to `HORIZON_URL_FALLBACK`; sustained failure shows up in `GET /health` instead of silently going idle. |
| Status lifecycle, webhooks (HMAC-SHA256 signed) | **Real**. |
| Persistence | **Real**, libSQL/SQLite for zero-config local dev (swap the `DATABASE_URL` for Turso/Postgres). Tables self-initialize on boot. Encrypted backups (`pnpm db:backup`) and a tested restore path (`pnpm db:restore`) exist — see [the runbook](docs/RUNBOOK.md) for the honest RPO/RTO (nightly backups ⇒ up to 24h RPO, not continuous protection). |
| Account/trustline preflight | **Real.** `POST /links` checks the seller's wallet actually exists and (for USDC) has an authorized, under-limit trustline before the link goes live — `422 destination_cannot_receive` otherwise, with a SEP-7 deep link to add the trustline. Re-checked in `GET /health` so a revoked trustline shows up in ops, not as a dead checkout page. |
| Persistence | **Real**, libSQL/SQLite for zero-config local dev (swap the `DATABASE_URL` for Turso/Postgres). Tables self-initialize on boot. |
| Off-ramp (`@checkout/offramp`) | **Real, opt-in.** Set `OFFRAMP=testanchor` for a genuine SEP-10 → SEP-38 → SEP-6 flow against the public Stellar testnet anchor (`https://testanchor.stellar.org`). Defaults to `OFFRAMP=mock` (`MockAnchorOffRamp`, fake FX rate, no money moves) for offline dev — the dashboard labels the cash-out button "(simulated)" whenever mock mode is active. |
| Metrics | **Real.** `GET /metrics` (Prometheus text format, `METRICS_TOKEN`-gated) — payment/webhook/anchor counters, watcher-lag and latency histograms, a circuit breaker around the off-ramp adapter. See [`docs/API.md`](docs/API.md#get-metrics) and [`docs/grafana-dashboard.json`](docs/grafana-dashboard.json). |
| Embeddable widget (`/widget.js`) | **Real**, lightweight embeddable script rendering modal checkout. |
| Auth | **Real, and enforced.** SEP-10 wallet login (`GET/POST /auth`) issues a short-lived session JWT (`sub`, `sellerId`, `jti`, `exp` ≤ 24h) and sets it as an httpOnly cookie; `requireSeller` middleware gates every `/links` and `/webhooks` route (401 unauthenticated, 403 wrong seller), `POST /auth/logout` revokes a token by `jti`. **No web UI exists yet to actually log in** (needs a wallet-connect button — separate issue) — the demo dashboard needs that wired up before it can create/list links post-upgrade. See [`docs/API.md`](docs/API.md#authentication). |

---

## Before you go live (the parts code can't do)

1. **Verify the USDC issuer.** `.env.example` ships placeholder Circle issuers for testnet and
   public. Confirm the current issuer for your network before relying on it — a wrong issuer
   silently matches nothing (or the wrong asset).
2. **Get a real anchor relationship first.** A checkout that dead-ends in USDC isn't the
   product. `packages/offramp/src/testanchor.ts` is a real SEP-10 → SEP-38 → SEP-6 adapter, but
   against Stellar's public *testnet reference sandbox* — not a licensed anchor. Fork its shape
   for a production adapter against a licensed Nigerian anchor's SEP endpoints, and validate the
   anchor will actually onboard you and pay out **before** building further.
3. **Don't enable `inline` off-ramp without legal review.** See the boundary note above.
4. **Build the wallet-connect UI.** SEP-10 login + session enforcement are both
   real now (`/auth`, `requireSeller` on `/links` and `/webhooks`), but there's
   no button anywhere to actually sign in — that needs a wallet-connect
   integration (Stellar Wallets Kit or similar) calling `apps/web/lib/api.ts`'s
   `getAuthChallenge`/`submitAuthChallenge`. Add API keys for programmatic access.
5. **Multiple sellers / scale:** the watcher polls per active destination account; for many
   sellers you may want a streaming `WatcherPort` implementation (the interface already allows it).

> This README is engineering guidance, not legal advice. Money transmission is the box you do
> not want to back into by accident.

---

## Docs & contributing

- **[Architecture](docs/ARCHITECTURE.md)** — package graph, the three ports, sequence diagrams for each flow, the status machine, and how to add a new chain/anchor/rail.
- **[Triage & review SLAs](docs/TRIAGE.md)** — issue taxonomy, 48h labelling SLA, and the stale-issue policy.
- **[HTTP API reference](docs/API.md)** — endpoints, request/response shapes, and webhook delivery.
- **[Runbook](docs/RUNBOOK.md)** — deploy, rollback, database backup/restore, key rotation, anchor outage, watcher-stuck, stuck off-ramp jobs, and the incident template.
- **[Mainnet cutover](docs/MAINNET.md)** — choosing a production anchor, generating and funding real keys, the public-network guardrails and why each refuses to boot, and the pre-announcement verification list.
- **[SCF Build proposal](docs/PROPOSAL.md)** — the problem, the wedge, milestones, budget, traction, and risk register.
- **[Contributing](CONTRIBUTING.md)** — setup, the check suite, and PR guidelines.
- **[Security policy](SECURITY.md)** — how to report a vulnerability privately.
- **[Code of conduct](CODE_OF_CONDUCT.md)**.

Licensed under the [Apache License 2.0](LICENSE).
