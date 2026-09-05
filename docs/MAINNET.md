# Mainnet cutover

Moving Quay from the Stellar testnet to the public network (pubnet).

The code is already network-parameterised — `STELLAR_NETWORK=public` selects the
pubnet passphrase, Horizon endpoint, and USDC issuer throughout. What follows is
therefore mostly configuration, one genuine code decision (which anchor), and a
set of checks. It is written as a runbook: do the steps in order, and do not
skip the verification at the end of each phase.

**Read this first:** the public-network guardrails throw at boot rather than
warn. A service that refuses to start is loud; one that quietly settles into a
sandbox anchor is not. The guards are split across two files: the OFFRAMP and
anchor-URL checks fire in `apps/api/src/env.ts` at module load (lines
114–142), as does the USDC issuer check (line 189); the
`DEFAULT_SELLER_WALLET` (line 386),
`SERVER_SIGNING_SECRET` (line 489), and `JWT_SECRET` (line 512) checks fire in
`apps/api/src/services/container.ts` inside `createContainer()`. If a guard
fires, fix the configuration — never relax the guard to get a green deploy.

---

## What the guardrails refuse

| Condition | Why it is fatal on pubnet |
|---|---|
| `OFFRAMP=mock` | The mock anchor fakes settlement 8s after cash-out and pays out nothing. Sellers would see completed cash-outs against real funds that never left. Use `none`, not `mock`, to ship without a cash-out leg. |
| `OFFRAMP=testanchor` | `testanchor.stellar.org` is the SDF testnet sandbox. It does not settle real money. |
| `OFFRAMP=anchor` without `ANCHOR_URL` / `ANCHOR_HOME_DOMAIN` | There is deliberately no default. A default would mean "the sandbox". |
| `ANCHOR_URL` over plain HTTP | SEP-10 auth tokens and SEP-12 KYC fields cross this connection. |
| Missing `USDC_ISSUER_PUBLIC` | Without an issuer the watcher cannot tell real USDC from an impostor asset. |
| Missing `KYC_ENCRYPTION_KEY` (`OFFRAMP=anchor`) | Seller SEP-12 PII would be stored unencrypted. Not required under `OFFRAMP=none`, which collects none. |
| Missing `DEFAULT_SELLER_WALLET` | Auto-generating a throwaway wallet on pubnet means funds land in a key nobody kept. |
| Missing `SERVER_SIGNING_SECRET` | A per-boot SEP-10 identity changes the advertised `SIGNING_KEY` on every restart, breaking every wallet that cached it. |
| Missing `JWT_SECRET` | Every seller is logged out on each deploy. |
| A blank or non-numeric numeric var | A blank value used to yield `0` — `TRUST_PROXY_HOPS=` silently collapsed every client into one rate-limit bucket. A typo yields `NaN`, and `setInterval(NaN)` is a tight loop against Horizon, not a slow poll. |

The OFFRAMP, USDC issuer, anchor-URL, and KYC key guards are covered by
`apps/api/test/env-mainnet-guards.test.ts`. The `DEFAULT_SELLER_WALLET`,
`SERVER_SIGNING_SECRET`, and `JWT_SECRET` guards live in
`apps/api/src/services/container.ts` and are not yet covered by a dedicated
test file.

---

## Phase 0 — Decide whether you need an anchor at all

`OFFRAMP=none` ships payments without a cash-out leg. Buyers pay the seller's
wallet directly, the watcher confirms the payment on the ledger, receipts and
webhooks fire as normal, and the seller moves their own funds. Everything that
is verified working stays; only cash-out to fiat is absent.

This is the fastest route to a live mainnet deployment, and the lowest-risk one:

- **No anchor agreement**, which is otherwise the only blocker that money and
  code cannot solve.
- **No SEP-12 identity data**, so no `KYC_ENCRYPTION_KEY` and none of the
  data-protection surface that holding seller PII creates.
- **No `DEFAULT_SELLER_SECRET`.** That key is required only to sign SEP-10 auth
  for a real anchor, so with the off-ramp disabled the server holds no key that
  can spend a seller's funds at all. This is a materially smaller blast radius
  than any configuration with an anchor in it.
- **Non-custodial end to end** — funds move from buyer to seller on the public
  ledger and never touch an account this service controls.

Structurally it is a small change because the off-ramp hangs off the *end* of
the payment flow rather than running through it: `paid` is the only status that
leads into the `offramp_*` states (`packages/core/src/domain/status.ts`). Those
states stay in the machine, simply unreachable, so enabling cash-out later is a
change of environment variable, not a migration.

To run this way:

```
OFFRAMP=none                      # API
NEXT_PUBLIC_OFFRAMP_MODE=none     # web
```

and leave `ANCHOR_URL`, `ANCHOR_HOME_DOMAIN`, `KYC_ENCRYPTION_KEY` and
`DEFAULT_SELLER_SECRET` unset. The dashboard hides the cash-out button, the KYC
panel and the cash-out modal; the API answers **501** (not 502 — this is
permanent, not an outage) on `/:id/cash-out`, `/:id/cash-out/quote` and
`/:id/offramp-requirements`; and the cash-out poller and anchor probe never
start.

**If you are shipping payments-only, skip to Phase 2.** Phase 1 and Phase 4
apply only when you add the off-ramp.

---

## Phase 1 — Choose an anchor

Only if you are enabling cash-out. This is the one decision no configuration
can make for you, and it gates everything else.

Quay's off-ramp adapter speaks SEP-10 (auth), SEP-12 (KYC), SEP-38 (quotes) and
SEP-6 (withdrawal). Any production anchor implementing that set works with no
code change — `OFFRAMP=anchor` is the same adapter as `testanchor`, pointed at a
different host.

What you need from the anchor before proceeding:

- **A commercial agreement.** Production anchors do not serve anonymous traffic.
- **The corridor you actually need.** Confirm it quotes USDC against your target
  currency via SEP-38, and settles to the rail your sellers use.
- **Its SEP-6 withdrawal types.** If it publishes more than one, set
  `OFFRAMP_TYPE`; otherwise the adapter refuses rather than guessing a rail.
- **Its KYC requirements.** SEP-12 fields are collected per seller ahead of
  time, not per transaction.

Verify before writing any config:

```bash
curl -s https://<anchor-domain>/.well-known/stellar.toml
```

Confirm it advertises `WEB_AUTH_ENDPOINT`, `TRANSFER_SERVER`, `KYC_SERVER`,
`ANCHOR_QUOTE_SERVER`, and that `NETWORK_PASSPHRASE` is
`Public Global Stellar Network ; September 2015`. An anchor whose TOML names the
testnet passphrase is a sandbox regardless of its domain.

> **Compliance is yours, not the anchor's.** Moving real customer money means
> money-transmission rules that vary by jurisdiction, and holding seller SEP-12
> identity data means data-protection obligations. Neither this document nor the
> code makes you compliant. Get advice appropriate to where you operate before
> taking a payment from a member of the public.

---

## Phase 2 — Generate secrets

```bash
pnpm secrets:mainnet
```

Prints every required secret and writes nothing to disk — these are spending
authority over real funds and identity for SEP-10 login, so they must not land
in a file the repo could pick up, in shell history, or in an agent transcript.
Copy each value straight into your platform's secret manager, then close the
terminal.

It generates `JWT_SECRET`, `KYC_ENCRYPTION_KEY`,
`WEBHOOK_SECRET_ENCRYPTION_KEY`, `METRICS_TOKEN`, the seller keypair, and
`SERVER_SIGNING_SECRET`. It does not generate `ANCHOR_URL`,
`ANCHOR_HOME_DOMAIN`, `DATABASE_URL`, `DATABASE_AUTH_TOKEN` or `CORS_ORIGINS` —
supply those by hand.

### Fund and prepare the accounts

There is no friendbot on pubnet. Both accounts must be funded with real XLM.

1. **Seller wallet** (`DEFAULT_SELLER_WALLET`) — send XLM to cover the base
   reserve, then add a **USDC trustline** to Circle's issuer. Until the
   trustline exists, the account cannot receive USDC at all and the checkout
   preflight will reject links.
2. **Signing identity** (`SERVER_SIGNING_SECRET`) — only needs XLM if you enable
   Soroban attestation (Phase 4). It pays contract invocation fees.

### Verify the USDC issuer

`USDC_ISSUER_PUBLIC` defaults to
`GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` in the templates.
**Check it against Circle's own published address** before taking a payment:
<https://developers.circle.com/stablecoins/stellar-usdc>

Minting an asset with the code `USDC` from a different issuer is trivial and it
is worth nothing. The issuer is the only thing that distinguishes real USDC.

---

## Phase 3 — Configure and deploy

Start from the templates rather than editing the testnet ones:

- `.env.public.example` — every variable, annotated, for local or non-Render use
- `render.mainnet.yaml` — a Render blueprint

`render.mainnet.yaml` deliberately creates a **separate** service
(`quay-api-mainnet`) instead of repointing the existing testnet one. Testnet
stays available as a staging environment, and a bad mainnet config cannot take
the testnet deploy down with it.

### Database

`DATABASE_URL=file:./local.db` is lost on every redeploy, taking the payment
ledger with it. Use a real, backed-up database (Turso), and confirm
`.github/workflows/db-backup.yml` points at the mainnet database, not the
testnet one.

### The web app

`NEXT_PUBLIC_STELLAR_NETWORK=public` **must** be set on the web deployment.

This one is easy to miss and fails opaquely: the browser signs with the
passphrase this variable selects, so leaving it unset means every wallet
signature is built for testnet and rejected by the network the API is watching —
with no error message that names the cause. Like every `NEXT_PUBLIC_*`
variable, this is baked into the client bundle **at build time** — changing
it and redeploying without rebuilding does nothing; the old value is still
what's in the bundle a visitor's browser downloads.

`NEXT_PUBLIC_API_URL` has the exact same failure shape, and it has actually
happened: a Vercel build once ran with this unset, so the code's own
`http://localhost:8787` local-dev fallback got baked into the production
bundle instead, and every visitor's browser silently tried (and failed) to
reach `localhost:8787` **on their own machine** — "Create link" just did
nothing, no error naming the cause (`docs/FIXLOG.md`, BUG-1.4). The fallback
now only applies outside a production build; a production build with this
unset fails loudly in the browser instead, at load time, rather than issuing
doomed requests — but that guard only catches "unset," not "wrong region/
wrong deployment," so still set it deliberately rather than relying on the
guard to catch a typo'd URL. Also set:

- `NEXT_PUBLIC_API_URL` / `API_URL` — the mainnet API origin
- `NEXT_PUBLIC_ENABLE_WALLET_PAY=true` — enable the lazy-loaded desktop wallet
  checkout path; leave unset/false to retain QR and deep-link fallbacks
- `NEXT_PUBLIC_OFFRAMP_MODE=anchor` — so the dashboard labels cash-out honestly
- `NEXT_PUBLIC_OFFRAMP_CURRENCY` — a currency your anchor actually quotes

And set `CORS_ORIGINS` on the API to the real web origin. No localhost.

---

## Phase 4 — Soroban attestation (optional)

The contract id in `render.yaml`
(`CD6AFLZTNUKC6CWXWLAVOEH3FY4ZN47SVX6DPYQBZBTPBBSN6LEFIFZ3`) is a **testnet**
deployment and will not resolve on pubnet.

Either leave `ATTESTATION_CONTRACT_ID` and `SOROBAN_RPC_URL` both unset —
receipts then honestly state they carry no attestation, and settlement is
unaffected, being proven by the classic ledger either way — or redeploy:

```bash
cd contracts
stellar keys generate quay-deployer --network public   # then fund it with real XLM
stellar contract build
stellar contract deploy \
  --wasm target/wasm32v1-none/release/quay_attest.wasm \
  --source quay-deployer --network public
```

Set both variables together. `env.ts` deliberately does not default
`SOROBAN_RPC_URL` on public, so an unset value can never silently mean
"testnet".

---

## Phase 5 — Verify before announcing

Work down this list against the deployed mainnet service. Stop at the first
failure.

```bash
API=https://<your-mainnet-api>

# 1. It booted at all — every guardrail passed.
curl -s $API/health | jq

# 2. It is on pubnet, watching the right issuer.
curl -s $API/.well-known/stellar.toml
#    NETWORK_PASSPHRASE must be "Public Global Stellar Network ; September 2015"
#    SIGNING_KEY must be your SERVER_SIGNING_SECRET's public key, and must not
#    change across a restart.

# 3. The database is reachable, not just the process alive.
curl -s $API/ready
```

Then, by hand:

- [ ] Seller wallet holds XLM **and** a USDC trustline to the verified issuer.
- [ ] `SIGNING_KEY` in the TOML is unchanged after a deliberate service restart.
- [ ] A wallet can complete SEP-10 login from the production web origin.
- [ ] A **small real payment** — a few USDC — moves a link to `paid`.
- [ ] A **small real cash-out** through the anchor reaches `settled` and the
      money actually arrives. Do this before anyone else uses the service.
- [ ] Webhook deliveries verify against the stored signing secret.
- [ ] `GET /metrics` requires `METRICS_TOKEN` and is not publicly readable.

---

## Rollback

Because mainnet is a separate service, rollback is: stop routing traffic to
`quay-api-mainnet` and point the web app's `NEXT_PUBLIC_API_URL` back at the
testnet API (with `NEXT_PUBLIC_STELLAR_NETWORK=testnet`).

Payments already settled on-chain cannot be rolled back. In-flight anchor
withdrawals continue at the anchor regardless of whether your service is
running — reconcile them through the anchor's own transaction records, not by
replaying local state.

---

## Known gaps to close

Not blockers for a first cutover, but each has a real production cost:

- **`REDIS_URL` unset.** Rate-limit counters live in an in-process `Map`, so N
  instances allow N times the configured limit. SEP-10 challenge single-use
  tracking has the same gap: without it, the same signed challenge can be
  redeemed once per instance instead of once, ever. Set it before scaling past
  one instance.
- **`apps/api/scripts/demo-seed.ts` reads `STELLAR_NETWORK` like the API does**,
  but Friendbot and the testanchor USDC dispenser only exist on testnet — on
  public network it skips both with a clear message and expects the generated
  buyer keypair to already be funded, or the payment step fails with the real
  Horizon error rather than an obscure one.
- **`.github/workflows/anchor-probe.yml` probes `testanchor.stellar.org`** and
  auto-files a GitHub issue when that sandbox is down. On a mainnet project it
  is watching the wrong host — repoint it at your anchor or disable it.
- **`AnchorOffRamp` (SEP-24, `packages/offramp/src/anchor.ts`) is not exported
  and must stay that way** until its quotes and jobs are persisted through
  `OffRampStateRepository`. It currently keeps them in in-process `Map`s, so a
  restart mid-withdrawal loses `sendTxHash` — and money-adjacent state that does
  not survive a redeploy has no business on pubnet. `TestAnchorOffRamp` (SEP-6)
  is the adapter that is wired in, and it persists both.
