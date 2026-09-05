# HTTP API

The API is served by `@checkout/api` (Hono) on `http://localhost:8787` by default
(`API_PORT`). All request and response bodies are JSON.

> **Auth:** `POST /auth` issues a session JWT after a wallet-signed SEP-10
> challenge; a seller row is created for the wallet on first login. **`/links`
> and `/webhooks` now require it** — every route under those two prefixes needs
> `Authorization: Bearer <token>` (or the httpOnly `session` cookie set by
> `POST /auth`) and returns `401` without one. There is currently no web UI to
> obtain a token (that needs a wallet-connect button — tracked separately), so
> the demo dashboard will need one wired up before it can create/list links
> again post-upgrade. See `apps/web/lib/api.ts`'s `getAuthChallenge` /
> `submitAuthChallenge` for the client-side pieces already in place.

CORS is restricted to the origins in `CORS_ORIGINS` (comma-separated), with
`credentials: true` (required for the browser to send/receive the session cookie
cross-origin — so `CORS_ORIGINS` can't be `*` while auth is in use).

## Authentication

Every route marked **Requires auth** below needs `Authorization: Bearer <token>`
(from `POST /auth`) or the httpOnly `session` cookie it also sets.

- **401 `unauthorized`** — you're not authenticated at all: no token, or one
  that's missing, malformed, tampered, expired, or revoked (`POST /auth/logout`
  put its `jti` on the revocation list). The response body always has this
  shape: `{ "error": "unauthorized", "message": "<why>" }`.
- **403 `forbidden`** — you *are* authenticated, just not as the seller who
  owns the resource (e.g. someone else's link). `{ "error": "forbidden", "message": "<why>" }`.

These are deliberately different failure modes: 401 means "prove who you are
again"; 403 means "you did, and the answer is still no."

## Conventions

- Money amounts are decimal strings (e.g. `"10.50"`), validated to at most 7
  decimals. Internally compared in integer stroops, never floats.
- Errors return `{ "error": "<code>", ... }` with an appropriate HTTP status.
  Validation failures return `400` with `{ "error": "invalid_body", "issues": [...] }`.

## Idempotency

`POST /links` and `POST /links/:id/cash-out` support the `Idempotency-Key` header.

```
Idempotency-Key: <unique-string-per-logical-request>
```

- **Same key + same body** — the original response is replayed byte-for-byte with an
  `Idempotent-Replayed: true` header. No second link is created; no second anchor job is started.
- **Same key + different body** — `409 idempotency_key_reuse`.
- **Key still in-flight** — `409 request_in_progress`.
- Keys expire after **24 hours**.

Use a UUID or any sufficiently random string. Retry safely on network timeouts by
resending the same key and body.

---

## `GET /health`

Liveness + basic config echo, plus the watcher's Horizon health and a re-check of
the seller's own USDC trustline (cached up to 60s — see the account/trustline
preflight note below) so a revoked trustline shows up in ops without anyone
touching logs.

**200**
```json
{
  "ok": true,
  "network": "testnet",
  "sellerWallet": "G...",
  "usdcTrustline": { "ok": true },
  "horizon": { "degraded": false, "usingFallback": false, "consecutiveFailures": 0 },
  "attestation": {
    "enabled": true,
    "contractId": "CD6AFLZTNUKC6CWXWLAVOEH3FY4ZN47SVX6DPYQBZBTPBBSN6LEFIFZ3"
  }
}
```
`attestation` reports whether this instance is writing settlement attestations
on-chain, and to which registry. It is published because "the contract is
deployed" and "the running product actually calls it" are different claims, and
only the second is worth anything to someone deciding whether to trust a
receipt. `enabled: false` (with `contractId: null`) is the honest answer when
`ATTESTATION_CONTRACT_ID` is unset — settlement is unaffected either way.

`ok` is pure liveness (the process is up) — check `horizon.degraded` for whether
the ledger watcher is actually keeping up. Every Horizon call (`packages/stellar`)
goes through a retry policy first — 3 attempts, exponential backoff with full
jitter, honoring `Retry-After` on `429` — so a single blip never surfaces here at
all. `horizon.degraded` only flips to `true` once retries have been exhausted
`HORIZON_DEGRADED_THRESHOLD` times in a row (default 3): a transient 429 that
recovers on retry #2 never trips this, but a sustained outage does, instead of
silently degrading to "nothing is ever marked paid." `usingFallback` is `true`
once it has switched to `HORIZON_URL_FALLBACK` (if configured); it switches back
to the primary automatically on the next successful call. `400`/`404` responses
(e.g. an account that doesn't exist yet) are treated as a normal, prompt answer —
never retried, never counted against `consecutiveFailures`.

When the seller's own wallet can't currently receive USDC:
```json
{
  "ok": true,
  "network": "testnet",
  "sellerWallet": "G...",
  "usdcTrustline": {
    "ok": false,
    "reason": "no_trustline",
    "message": "Account G... has no trustline for USDC (issuer G...) — add one before this link can be paid.",
    "trustlineUri": "web+stellar:tx?xdr=...&network_passphrase=..."
  }
}
```

---

## `GET /auth?account=G...`

Step 1 of [SEP-10](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md)
wallet login: builds a challenge transaction for the given account to sign.

**200**
```json
{ "transaction": "AAAAAgAAAAA...", "network_passphrase": "Test SDF Network ; September 2015" }
```
**400** — `{ "error": "missing_account" }` or `{ "error": "account must be a valid Stellar G-address" }`

---

## `POST /auth`

Step 2: submit the challenge transaction signed by the account's wallet(s).
Verifies the server's own signature, timebounds, domain fields, and that
signature weight from the account's actual signers (via Horizon, M-of-N aware)
meets its medium threshold — the account's master key if it isn't funded yet.
Each challenge can be redeemed exactly once.

On success, a seller row is created for the wallet if one doesn't exist yet
(the wallet address **is** the identity).

**Request**
```json
{ "transaction": "AAAAAgAAAAA..." }
```

**200**
```json
{ "token": "<session JWT>" }
```
**401** — `{ "error": "<reason>" }`, e.g. signature verification failed, challenge
already used, or the transaction doesn't match what we issued.

---

## `GET /.well-known/stellar.toml`

[SEP-1](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0001.md)
descriptor advertising `SIGNING_KEY`, `WEB_AUTH_ENDPOINT`, and `NETWORK_PASSPHRASE`
so wallets can discover this service's SEP-10 endpoint — the server-side mirror of
how `packages/offramp/src/sep10.ts` discovers anchors.

---

## `GET /metrics`

Prometheus text-format metrics (`content-type: text/plain; version=0.0.4`).
Guarded by `METRICS_TOKEN` — pass `Authorization: Bearer <token>` or `?token=`.
If `METRICS_TOKEN` isn't set, the API generates an ephemeral one at boot and
prints it once (so the endpoint is never open by default, even locally).

**401** — wrong or missing token: `unauthorized`

**Counters**
| Metric | Labels |
| --- | --- |
| `payments_matched_total` | `outcome` (`paid`, `underpaid`, `asset_mismatch`, `no_memo`, `unknown_reference`) |
| `link_status_transitions_total` | `to` |
| `wallet_submissions_total` | `outcome` (`submitted`, `invalid_xdr`, `rejected`) |
| `webhook_attempts_total` | `result` (`ok`, `error`) — every retry counts separately |
| `anchor_calls_total` | `method` (`quote`~SEP-38, `initiate`/`status`~SEP-6), `status` |

**Histograms**
| Metric | Labels |
| --- | --- |
| `watcher_tick_duration_seconds` | — |
| `payment_to_paid_latency_seconds` | — |
| `anchor_call_duration_seconds` | `method` |
| `quote_to_settlement_duration_seconds` | `outcome` (`settled`, `failed`) |

**Gauges**
| Metric | Meaning |
| --- | --- |
| `accounts_watched` | distinct destinations the watcher is currently polling |
| `pending_cash_outs` | links in `offramp_pending` |
| `webhook_deliveries_in_flight` | webhook deliveries currently being attempted, including retries |
| `offramp_circuit_breaker_state` | `0`=closed, `1`=half_open, `2`=open — see below |
| `watcher_lag_seconds` | seconds since the watcher's last completed poll tick |

A ready-made dashboard for these is at [`docs/grafana-dashboard.json`](grafana-dashboard.json)
(import directly into Grafana, point it at your Prometheus data source).

**Off-ramp circuit breaker:** every off-ramp adapter call (mock or
`testanchor`) is routed through `CircuitBreakerOffRamp`
(`apps/api/src/services/circuit-breaker.ts`), which opens after 3 consecutive
failures and stays open for 30s before allowing a half-open trial call — so a
down anchor can't be hammered by every cash-out poll. This is also the single
seam `anchor_calls_total` / `anchor_call_duration_seconds` are recorded from.

---

## `GET /auth?account=G...`

Step 1 of [SEP-10](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md)
wallet login: builds a challenge transaction for the given account to sign.

**200**
```json
{ "transaction": "AAAAAgAAAAA...", "network_passphrase": "Test SDF Network ; September 2015" }
```
**400** — `{ "error": "missing_account" }` or `{ "error": "account must be a valid Stellar G-address" }`

---

## `POST /auth`

Step 2: submit the challenge transaction signed by the account's wallet(s).
Verifies the server's own signature, timebounds, domain fields, and that
signature weight from the account's actual signers (via Horizon, M-of-N aware)
meets its medium threshold — the account's master key if it isn't funded yet.
Each challenge can be redeemed exactly once.

On success, a seller row is created for the wallet if one doesn't exist yet
(the wallet address **is** the identity).

**Request**
```json
{ "transaction": "AAAAAgAAAAA..." }
```

**200** — also sets an httpOnly `session` cookie (`Secure` unless `COOKIE_SECURE=false`,
`SameSite=Lax`), for server-side/SSR requests that can't hold the token in JS memory.
```json
{ "token": "<session JWT>", "expiresAt": 1750003600 }
```
- `token` — an HS256 JWT (`sub`=wallet G-address, `sellerId`, `jti`, `exp` ≤ 24h from
  now). Keep it **in memory only** on the client — never `localStorage`/`sessionStorage`.
- There is no refresh token by design: renew by re-signing a fresh challenge
  (`GET /auth` → `POST /auth` again) before `expiresAt`.

**401** — `{ "error": "<reason>" }`, e.g. signature verification failed, challenge
already used, or the transaction doesn't match what we issued.

---

## `POST /auth/logout`

**Requires auth.** Revokes the current token's `jti` (rejected by every
protected route from then on, even though it hasn't expired yet) and clears
the `session` cookie.

**200**
```json
{ "ok": true }
```
**401** — same as any protected route: missing/invalid/expired/already-revoked token.

---

## `GET /.well-known/stellar.toml`

[SEP-1](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0001.md)
descriptor advertising `SIGNING_KEY`, `WEB_AUTH_ENDPOINT`, and `NETWORK_PASSPHRASE`
so wallets can discover this service's SEP-10 endpoint — the server-side mirror of
how `packages/offramp/src/sep10.ts` discovers anchors.

---

## `POST /links`

**Requires auth.** Creates the link under the authenticated seller (the
one the token's `sellerId` resolves to).

**Request**
```json
{
  "title": "T-shirt",
  "amount": "10.50",
  "assetCode": "USDC",
  "expiresInMinutes": 60
}
```
- `title` — required, 1–120 chars.
- `amount` — required, positive, ≤ 7 decimals.
- `assetCode` — `"USDC"` (default) or `"XLM"`. The USDC issuer is resolved
  server-side from config.
- `expiresInMinutes` — optional positive integer (≤ 43200). Omit for no expiry.

**201**
```json
{
  "link": {
    "id": "lnk_...",
    "reference": "...",
    "status": "pending",
    "title": "T-shirt",
    "amount": "10.50",
    "asset": { "code": "USDC", "issuer": "G..." },
    "destination": "G...",
    "expiresAt": 1750000000000
  },
  "request": {
    "uri": "web+stellar:pay?destination=...&amount=...&memo=...",
    "memo": "...",
    "memoType": "text"
  }
}
```
The `request.uri` is a spec-correct SEP-7 payment URI for the buyer's wallet/QR.
The buyer **must** pay with the given `memo` — that is how the watcher correlates
the on-chain payment back to this link.

**422** — the destination (the seller's wallet) can't currently receive this
asset: not yet created/funded on-chain, no trustline for an issued asset, the
trustline is unauthorized (frozen by the issuer), or it's already at its limit.
Checked on every `POST /links` (an unfunded/trustline-less seller wallet used to
mean a checkout page that could never actually be paid — see
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md) for why this matters). Cached 60s per
(account, asset) so this stays cheap.
```json
{
  "error": "destination_cannot_receive",
  "message": "Account G... has no trustline for USDC (issuer G...) — add one before this link can be paid.",
  "reason": "no_trustline",
  "asset": { "code": "USDC", "issuer": "G..." },
  "trustlineUri": "web+stellar:tx?xdr=...&network_passphrase=..."
}
```
- `reason` — `account_not_found` | `no_trustline` | `trustline_not_authorized` | `trustline_limit_exceeded`.
- `trustlineUri` — present for `no_trustline` (and any reason where a trustline
  exists to sign for): a SEP-7 `tx` deep link wrapping an unsigned `changeTrust`
  operation. The seller's wallet can sign it directly — nothing server-side ever
  touches their key. Absent for `account_not_found` (no account yet, so no
  sequence number to build a transaction from).

---

## `GET /links`

**Requires auth.** Lists the authenticated seller's own links only.

**200**
```json
{ "links": [ { "id": "lnk_...", "status": "paid", "...": "..." } ] }
```

---

## `GET /links/:id`

**Public — no auth.** Fetch one link plus its payment request (used by the
checkout page). The link id is the bearer capability; seller-only detail remains
behind `GET /links/:id/detail`.

**200** — same shape as the `POST /links` response.
**404** — `{ "error": "not_found" }`

---

## `POST /links/:id/submit`

**Public — no auth.** The buyer submits a transaction signed by their own wallet.
The API parses and validates the complete XDR before relaying it to Horizon. It
accepts exactly one payment operation and verifies the destination, asset, amount,
and required `MEMO_TEXT` against the link. It never marks the link paid directly;
the ledger watcher remains the source of truth.

**Request**
```json
{ "signedXdr": "AAAAAgAAAAA..." }
```

**200**
```json
{ "txHash": "b166269ace8a96efe..." }
```

**400** — malformed XDR, fee-bump envelope, or a transaction containing anything
other than exactly one payment operation.

**409** — the link is unavailable, or the transaction does not match the link.
A Horizon rejection returns `{ "error": "payment_rejected", "reason": "...", "detail": "..." }`,
where `reason` can distinguish `insufficient_balance`, `missing_trustline`, or a
generic `payment_rejected`.

---

## `GET /r/:reference`

**Public — no auth.** The buyer-facing receipt, keyed by the payment reference
(the same value carried in the Stellar memo). Deliberately narrow: it returns
only what is safe to hand a stranger holding the link. It never includes
`sellerId`, `isDemo`, or any of the off-ramp economics (`offrampRate`,
`offrampFeeAmount`, `offrampNetTargetAmount`) — a buyer must not learn the
seller's realized FX rate or anchor fees.

Only settled links resolve. An `active`, `expired` or `cancelled` link returns
`404`: an unpaid link is not a receipt.

**200**
```json
{
  "reference": "pl_0eipnodm7s2o",
  "title": "Order #1042",
  "amount": "3",
  "asset": { "code": "XLM", "issuer": null },
  "status": "paid",
  "txHash": "b166269ace8a96efe...",
  "payer": "G...",
  "paidAmount": "3",
  "createdAt": 1786094880000,
  "updatedAt": 1786094898582,
  "attestation": {
    "contractId": "CD6AFLZTNUKC6CWXWLAVOEH3FY4ZN47SVX6DPYQBZBTPBBSN6LEFIFZ3",
    "refHash": "cdd4838dc2edbe2721bb609126eb230a53a1cc3e3e8a706cd96c0f41d7d7498f",
    "txHash": "7b62b57563d31f35d5f7cc27f115061a6890d20f342b5ccf09d3ca18276e6874",
    "ledger": 4014880,
    "attestedAt": 1786094898582
  }
}
```

### Verifying a receipt without trusting this API

`attestation` is the point of the endpoint. Quay saying a link is `paid` is a
claim about its own database; the attestation is the same fact recorded in a
Soroban registry Quay cannot rewrite, so the receipt can be checked against the
ledger instead of against us.

- `refHash` is `sha256(reference)` and is **what the registry is keyed by** —
  the reference itself is never written on-chain, because it is effectively an
  invoice id and publishing them would leak a seller's invoice volume and
  sequence to any observer. Recompute it yourself from `reference`; you do not
  have to take this field's word for it either.
- `txHash` is the transaction that *wrote the attestation*, not the payment.
  The payment's own hash is the top-level `txHash`. They are two facts on two
  different ledgers. It is `null` (with `ledger: null`) when the attestation was
  found already present rather than written by this instance — the registry
  stores the fact, not the invocation that carried it.
- `attestation` is `null` when the payment has not been attested. That is not an
  error: settlement is proven by the classic ledger regardless, and a missing
  block is the honest display rather than a claim of verifiability that isn't
  there.

```bash
REF=pl_0eipnodm7s2o
REFHASH=$(node -e "console.log(require('crypto').createHash('sha256').update('$REF').digest('hex'))")

stellar contract invoke \
  --id CD6AFLZTNUKC6CWXWLAVOEH3FY4ZN47SVX6DPYQBZBTPBBSN6LEFIFZ3 \
  --source <any-funded-account> --network testnet --send=no \
  -- verify --ref_hash $REFHASH
```

**404** — `{ "error": "not_found" }`: unknown reference, or the link is not
settled.

---

## `POST /links/:id/cash-out`

**Requires auth** (403 if the link belongs to a different seller). Seller-initiated off-ramp of a **paid** link to local currency. Runs
`quote → initiate` against the off-ramp adapter and moves the link to
`offramp_pending`; a background poller advances it to `offramp_settled` /
`offramp_failed`.

> The default adapter is `MockAnchorOffRamp` — it simulates an FX quote and payout
> and **moves no money**.

**Request**
```json
{
  "targetCurrency": "NGN",
  "payoutFields": { "bank": "...", "accountNumber": "..." }
}
```
- `targetCurrency` — 3-letter code, defaults to `NGN`.
- `payoutFields` — opaque string map handed to the anchor adapter.

**200**
```json
{
  "job": {
    "jobId": "ofr_...",
    "linkId": "lnk_...",
    "status": "pending",
    "targetCurrency": "NGN",
    "targetAmount": "17325.00",
    "rate": "1650"
  },
  "interactiveUrl": "https://anchor.example.com/sep24/interactive?id=..."
}
```
- `interactiveUrl` — **present only when the anchor requires the seller in a
  browser** (SEP-24). Absent for field-driven anchors (SEP-6), which is every
  adapter shipped today. When present, open it and keep polling `status()`
  exactly as before — the link is already `offramp_pending` either way, so the
  field is additive and a client that ignores it behaves as it did previously.
  It is always `https`; the dashboard refuses any other scheme.

**409** — link is not in `paid` state: `{ "error": "Link must be paid to cash out (is \"pending\")" }`
**404** — `{ "error": "Link not found" }`
**403** — `{ "error": "kyc_required" }`. Only possible with `OFFRAMP=testanchor`: the
seller's SEP-12 KYC (see below) hasn't reached `ACCEPTED` yet. `payoutFields` is
bank/routing info only — it is never used as a source of identity data.

---

## `GET /seller/kyc`

Current SEP-12 requirements and status for the seller, re-synced from the anchor
(`OFFRAMP=mock` always reports `ACCEPTED` — there's no real anchor to satisfy).

**200**
```json
{
  "status": "NEEDS_INFO",
  "requiredFields": [
    { "name": "first_name", "type": "string", "optional": false },
    { "name": "email_address", "type": "string", "optional": false }
  ],
  "providedFields": { "first_name": "Ada" },
  "message": null,
  "lastSyncedAt": 1750000000000
}
```
`status` is one of `unsubmitted | NEEDS_INFO | PROCESSING | ACCEPTED | REJECTED`.

---

## `PUT /seller/kyc`

Submit or update identity fields. Values are sent to the anchor **exactly as
given** — no field is ever defaulted or fabricated. Call with `{}` to kick off
discovery before any fields are known.

**Request**
```json
{ "first_name": "Ada", "email_address": "ada@example.org" }
```

**200** — same shape as `GET /seller/kyc`, reflecting the anchor's response
(which may reveal further required fields — SEP-12 discovery is progressive).

**422**
```json
{ "error": "kyc_required", "missingFields": ["email_address"] }
```
Returned when a field the anchor is already known to require is missing —
naming exactly which ones, never silently substituting a placeholder.

---

## `POST /webhooks`

Register a webhook endpoint. The signing secret is returned **once** — store it.
It's encrypted at rest (not stored in plaintext); the API can never show it to you
again after this response, only a display-only `secretLast4`.
**Requires auth.** Register a webhook endpoint for the authenticated seller.
The signing secret is returned **once** — store it.

**Request**
```json
{ "url": "https://example.com/hooks/checkout" }
```

**201**
```json
{ "id": "...", "url": "https://example.com/hooks/checkout", "secretLast4": "a1b2", "secret": "<hex>" }
```

---

## `GET /webhooks`

List registered webhooks. Secrets are **not** returned — only `secretLast4` for
display. Deleted webhooks are excluded.
**Requires auth.** Lists the authenticated seller's registered webhooks.
Secrets are **not** returned.

**200**
```json
{
  "webhooks": [
    {
      "id": "...",
      "url": "...",
      "secretLast4": "a1b2",
      "previousSecretLast4": null,
      "previousSecretExpiresAt": null,
      "deletedAt": null,
      "createdAt": 1750000000000
    }
  ]
}
```

---

## `DELETE /webhooks/:id`

Removes a webhook (soft delete — it stops receiving events immediately, but its
delivery history remains readable via `GET /webhooks/:id/deliveries`).

**204** — no body.
**404** — `{ "error": "not_found" }` if the id doesn't exist or isn't yours.

---

## `POST /webhooks/:id/rotate-secret`

Issues a new signing secret, returned **once** just like at creation. The
previous secret keeps signing deliveries for **24 hours** after rotation (see
"Webhook delivery" below), so you can redeploy your receiver with the new
secret without dropping any events in between.

**200**
```json
{ "id": "...", "url": "...", "secretLast4": "c3d4", "secret": "<hex>" }
```

**404** — `{ "error": "not_found" }`

---

## `GET /webhooks/:id/deliveries?limit=&cursor=`

Paginated delivery history for one webhook, newest first. Works even after the
webhook has been deleted. `limit` defaults to 20, max 100.

**200**
```json
{
  "deliveries": [
    {
      "id": "whd_...",
      "webhookId": "whk_...",
      "linkId": "lnk_...",
      "event": "link.paid",
      "statusCode": 200,
      "ok": true,
      "error": null,
      "createdAt": 1750000000000
    }
  ],
  "nextCursor": "b3RoZXI"
}
```

Pass `nextCursor` back as `?cursor=` to fetch the next page; `null` means there
are no more results.

**404** — `{ "error": "not_found" }` if the id doesn't exist or isn't yours.

---

## `POST /webhooks/deliveries/:id/replay`

Manually re-queue a webhook delivery for immediate redelivery. Useful for
recovering dead-lettered entries or forcing a retry without waiting for the
next backoff window.

`:id` is the queue entry id returned in delivery metadata, or visible in
`webhook_queue.id`. Scoped to the calling seller: an entry belonging to another
merchant's webhook is reported as **404**, the same as one that does not exist.

**Behaviour by current status**

| Entry status | Effect                                          |
| ------------ | ----------------------------------------------- |
| `dead`       | Re-queued as `pending`, `nextAttemptAt = now`.  |
| `pending`    | `nextAttemptAt` reset to now (accelerates next attempt). |
| `delivered`  | Re-queued as `pending` (re-sends an already-delivered event). |
| `claimed`    | **409** — delivery is in-flight; wait for it to settle. |

**202**
```json
{
  "id": "wqe_...",
  "webhookId": "whk_...",
  "linkId": "lnk_...",
  "event": "link.paid",
  "previousAttempts": 5,
  "status": "pending",
  "message": "Queued for immediate redelivery."
}
```
**404** — queue entry not found, or not yours.
**409** — delivery is currently in-flight.

---

## Webhook delivery

When a link changes state, the API writes a delivery row to the durable queue
and returns immediately — event emission never blocks a state transition. A
background `WebhookWorker` claims due rows and POSTs the event to each
registered URL.

### Events

| Event             | Fired when                                  |
| ----------------- | ------------------------------------------- |
| `link.paid`       | a matching payment settled (exact or over)  |
| `link.underpaid`  | a payment arrived for less than requested   |
| `offramp.settled` | a cash-out job settled                       |
| `offramp.failed`  | a cash-out job failed                        |

### Body
```json
{
  "event": "link.paid",
  "data": {
    "linkId": "lnk_...",
    "reference": "...",
    "status": "paid",
    "amount": "10.50",
    "paidAmount": "10.50",
    "asset": { "code": "USDC", "issuer": "G..." },
    "txHash": "...",
    "overpaid": false
  },
  "id": "lnk_...",
  "sentAt": "2026-06-19T12:00:00.000Z"
}
```

### Headers
- `x-checkout-event` — the event name.
- `x-checkout-signature` — one or more `sha256=<hex>` HMAC-SHA256 signatures of
  the **exact raw body**, comma-separated. Normally just one, signed with your
  current secret. For 24h after a secret rotation, **two** are sent (current +
  previous secret) — accept the delivery if *any* listed signature matches, so
  you can redeploy without dropping events.

### Delivery guarantees

- **Durable**: the event body is serialised once at write time and persisted in
  `webhook_queue`, so every attempt re-sends byte-identical content. A process
  crash during backoff does not lose the event — it is delivered after restart,
  and a crash mid-delivery releases its claim so another worker picks it up.
  Signing happens per attempt, which is what lets a secret rotated between
  attempts take effect.
- **At-least-once**: retried up to 5 attempts with exponential backoff + full
  jitter (base 5 s → max ceiling doubles per attempt). Make receivers idempotent.
- **Per-attempt history**: every attempt is written to `webhook_deliveries`
  (`attempt` column + `queue_entry_id`), so you can inspect exactly which
  attempts failed and why.
- **Transient failures** (network errors, `5xx`, `429`) are retried.
- **Permanent failures** (`4xx` except `429`) are dead-lettered immediately.
- **Dead letters** are replayable via `POST /webhooks/deliveries/:id/replay`.

Return `2xx` quickly to acknowledge receipt. Long-running processing should be
done asynchronously.

For **replay protection**, reject events whose in-body `sentAt` is older than a
small window (e.g. 5 minutes). `sentAt` is inside the signed body and cannot be
forged without the secret.

### Verifying signatures

Recompute over the raw body and compare in constant time:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, header, secret) {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return header.split(",").some((part) => {
    const a = Buffer.from(part.trim());
    const b = Buffer.from(`sha256=${expected}`);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
```
