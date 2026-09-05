# TODO

Outstanding work, ordered by what blocks what. `MAINTAINER.md` is the older
Drips-wave plan and is kept separate — this file tracks the mainnet cutover and
the maintenance items that came out of it.

Last updated: 2026-08-26.

---

## Done (2026-08-21)

- [x] **Stopped the automated PRs.** They came from Dependabot
      (`.github/dependabot.yml`), not from a workflow. Now monthly,
      security-updates only, with `ignore` rules suppressing routine version
      bumps. CVE PRs still arrive, because CI has a hard `pnpm audit` gate.
- [x] **Fixed CI.** The `pnpm audit --audit-level=high` step failed on
      `GHSA-2v37-7h3g-55p8` (`nanoid <3.3.18`, pulled in transitively via
      `postcss` ← `next`/`vite`). Fixed with a `pnpm.overrides` pin to
      `^3.3.18` — deliberately range-pinned to the 3.x line, because a bare
      `>=3.3.18` resolves to nanoid 6 under postcss.
- [x] `OFFRAMP=anchor` mode — the SEP-6 adapter pointed at an operator-supplied
      production anchor via `ANCHOR_URL` / `ANCHOR_HOME_DOMAIN` / `OFFRAMP_TYPE`.
- [x] Public-network boot guards in `apps/api/src/env.ts`, with tests in
      `apps/api/test/env-mainnet-guards.test.ts`.
- [x] `.env.public.example`, `render.mainnet.yaml`, `docs/MAINNET.md`,
      `pnpm secrets:mainnet`.

---

## 1. Blocking — mainnet cannot proceed without these

None of these are code. See `docs/MAINNET.md` for the full runbook.

- [ ] ~~**Choose a production anchor**~~ — **deferred.** No longer blocking:
      `OFFRAMP=none` ships payments without it (see §2). Still required before
      cash-out to fiat exists. This gates
      everything else in the off-ramp path. Production anchors do not serve
      anonymous traffic. Confirm it quotes USDC against your target currency
      over SEP-38 and settles to the rail your sellers actually use.
- [ ] **Get compliance advice** for the jurisdictions you operate in. Much
      reduced under `OFFRAMP=none` — no fiat conversion, no identity data, and
      funds never touch an account this service controls — but "reduced" is not
      "none", and this file is not advice.
- [ ] **Verify Circle's pubnet USDC issuer** against Circle's own published
      address before taking a single real payment. Minting an asset with the
      code `USDC` from a different issuer is trivial and it is worth nothing.
- [ ] **Generate and fund real keys.** `pnpm secrets:mainnet`, then fund the
      seller wallet with XLM *and* add a USDC trustline — until the trustline
      exists the account cannot receive USDC at all. Under `OFFRAMP=none` skip
      `DEFAULT_SELLER_SECRET` and `KYC_ENCRYPTION_KEY` entirely.
- [ ] **Provision a real database.** `file:./local.db` is lost on every
      redeploy, taking the payment ledger with it.
- [ ] **Set `NEXT_PUBLIC_STELLAR_NETWORK=public` on the web deployment.** Easy
      to miss and it fails opaquely — the browser signs with the passphrase this
      selects, so leaving it unset means every wallet signature is built for
      testnet and rejected, with no error naming the cause.

---

## 2. Payments-only mainnet — implemented, decision made

**Decided 2026-08-21: ship payments-only first.** `OFFRAMP=none` is implemented
and tested. Buyers pay the seller's wallet directly; the seller moves their own
funds. See `docs/MAINNET.md` Phase 0.

- [x] `DisabledOffRamp` (`packages/offramp/src/disabled.ts`) — throws a typed
      `OffRampDisabledError` on every method rather than deleting the working,
      tested off-ramp code.
- [x] `OFFRAMP=none` allowed on public in `env.ts`; `KYC_ENCRYPTION_KEY` and
      the `ANCHOR_*` variables no longer required in that mode.
- [x] Cash-out routes answer **501**, not 500 — and deliberately not 502, which
      is what an anchor *outage* returns and which clients retry.
- [x] Dashboard hides the cash-out button, KYC panel and cash-out modal.
- [x] Cash-out poller and anchor probe never start.
- [x] `offramp_*` statuses left in the machine, unreachable — re-enabling
      cash-out later is a config change, not a migration.

Remaining for this path:

- [ ] Set `OFFRAMP=none` and `NEXT_PUBLIC_OFFRAMP_MODE=none` in the mainnet
      deployment, and leave `DEFAULT_SELLER_SECRET` unset.
- [ ] Add an `OFFRAMP=none` variant to `render.mainnet.yaml`, or note in the
      dashboard which variables to omit.
- [ ] Decide how the dashboard should explain that sellers cash out themselves —
      right now the button simply is not there, with no copy replacing it.

## 3. Buyer-side on-ramp checkout — design note, not yet scoped

The strategic direction as of 2026-08-23. Nothing here is built.

### The idea

Today a buyer can only pay if they already hold USDC on Stellar. That is the
actual ceiling on this product, and no amount of merchant-side work lifts it —
it is why comparable projects have a good codebase and no users.

Instead, let the buyer pay through an on-ramp anchor they already have an
account with, and offer a choice of anchors at checkout. Buyer pays fiat, the
merchant receives USDC, nobody has to be crypto-native.

### Why the mechanics work

- **Third-party deposit destinations are spec-legal.** Per SEP-24: "both the
  source account of a withdrawal payment and the destination account of a
  deposit can be different from the account authenticated via SEP-10 or
  SEP-45." So a buyer authenticates with their own anchor and the funds land
  in the merchant's wallet.
- **This uses the abundant anchor set, not the scarce one.** The SEP-6-only
  gap that an anchor-facing checkout would have targeted is tiny and mostly
  dead — 12 domains, 8 with no SEP-10 at all, exactly one (mtl.montelibero.org)
  with SEP-10 + SEP-12 (see `scripts/anchor-sep-scan.mjs`). For a buyer-side
  picker you want **SEP-24**, because the anchor hosts its own KYC webview and
  we build none of it — and SEP-24 anchors numbered 61+ in a partial scan.
- **Anchors are suppliers here, not competitors.** They want on-ramp volume.

### The constraint that shapes the whole design

Every transaction in this flow is, by construction, a **third-party payment**:
the buyer is KYC'd by the anchor, but the funds go to a merchant the anchor has
never seen. That is a named and heavily-scrutinised AML category — guidance
requires AML-manager approval and beneficiary name-screening for third-party
deposits, and says firms that cannot mitigate the risk should refuse them
outright. "Sudden large deposits followed by immediate transfers to unrelated
parties" is listed as a scrutiny trigger, which is a literal description of
checkout.

**Mitigation: reusable merchant KYC.** If the merchant carries a credential the
anchor can verify, the merchant stops being an unknown beneficiary and the
anchor can screen both ends. Two Stellar projects already do this:

- **SAK (Stellar Anchor KYC)** — shared encrypted identity layer, KYC once,
  anchors verify over SEP-12, ZK proofs return validity and tier without raw
  data. An Anclap pilot is planned.
- **StellarProof** — reusable credential bound to a Stellar wallet; anchors
  verify the credential rather than re-checking documents.

This also puts the friction in the right place: merchants tolerate onboarding,
buyers abandon it.

The residual problem is legal, not technical — reliance regimes let an anchor
rely on someone else's CDD but it stays liable, so anchors will want contracts
before accepting a third-party credential.

### What has to change in this codebase

- [ ] **A pending-settlement state.** Fiat deposits clear in minutes to days.
      The status machine goes `active -> paid` with a TTL and the checkout
      renders an expiry countdown; a deposit pending for hours breaks both.
      Needs a state that means "payment initiated, not yet settled" — the way
      ACH and bank transfer already work, which merchants accept when it is
      labelled honestly.
- [ ] **Decide who carries the gap.** The anchor will not: it has no contract
      with the merchant, and the merchant's counterparty is us. Fronting the
      funds would mean custody, capital and licensing, which destroys the
      non-custodial property that is the actual differentiator. So: explicit
      pending state, plus an FX quote with a buffer and a hard expiry.
- [ ] **A deposit path at all.** Everything built so far is withdrawal
      (`OffRampPort`). This needs the mirror: a SEP-24 deposit initiation, an
      anchor picker in the checkout, and settlement detection that reconciles
      an anchor deposit against a link.
- [ ] **Anchor discovery/registry** so the picker has something to offer.
      `scripts/anchor-sep-scan.mjs` already produces the raw data.

### Open questions — cheaper to ask than to build

- [ ] **Will an anchor permit SEP-24 deposits to a third-party destination?**
      The spec allows it; a compliance team may not. This decides whether the
      architecture works at all. **Anclap** is the better first conversation
      than Cowrie — it runs SEP-6 + SEP-24 + SEP-10 + SEP-12 (the most complete
      anchor in the scan) and is already in the SAK reusable-KYC pilot.
- [ ] **What fraction of buyers in the target corridor hold an account with
      *any* supported anchor?** Aggregation answers any single anchor's small
      base, but ten anchors with 8,000 users each is 80,000 people, not a
      market. On-chain holder counts are a floor, not the answer — an anchor's
      customer base is larger than the set holding its Stellar asset.

### Related: privacy as a later differentiator

Confidential Tokens (private balances and transfer amounts, addresses stay
public for compliance) and Nethermind's Stellar Private Payments (shields both
parties) are both **testnet-only developer previews, explicitly not approved
for mainnet**, with audits underway. No competitor offers this.

Two caveats if it is picked up later: Confidential Tokens leave **deposit and
withdrawal amounts public**, so a one-shot checkout leaks roughly the revenue
figure it was meant to hide; and it needs USDC via the Stellar Asset Contract,
which makes payments Soroban calls that `HorizonWatcher` — which matches
classic payments by memo — cannot see at all.

Worth a testnet spike while audits run. Not worth stopping shipping for.

## 4. Known gaps — not blockers, each has a real production cost

- [ ] **`TestAnchorOffRamp` requires SEP-38, which the most plausible real
      anchor does not implement.** `testanchor.ts:165` calls `getSep38Quote`
      and `:116` calls `getSep38Prices`. Cowrie's stellar.toml declares
      TRANSFER_SERVER, WEB_AUTH_ENDPOINT, KYC_SERVER and DIRECT_PAYMENT_SERVER
      but **no ANCHOR_QUOTE_SERVER** — and no SEP-6-only anchor in the scan has
      one. Integrating a real anchor therefore needs a non-SEP-38 pricing path:
      fees are available from `/sep6/info` (`feeFixed` / `feePercent`), but the
      FX rate is not.
- [ ] **`REDIS_URL` unset.** Rate-limit counters live in an in-process `Map`, so
      N instances allow N times the configured limit. Set before scaling past
      one instance.
- [ ] **`.github/workflows/anchor-probe.yml` probes `testanchor.stellar.org`**
      and auto-files a GitHub issue when that sandbox is down. On a mainnet
      project it watches the wrong host — repoint it at your anchor or disable
      it. (It is also a second source of automated repo noise, alongside the
      Dependabot PRs.)
- [ ] **`AnchorOffRamp` (SEP-24, `packages/offramp/src/anchor.ts`) must stay
      unexported** until its quotes and jobs are persisted through
      `OffRampStateRepository`. It keeps them in in-process `Map`s, so a restart
      mid-withdrawal loses `sendTxHash` — money-adjacent state that does not
      survive a redeploy has no business on pubnet. Four money bugs in it were
      fixed on 2026-08-21 (wrong network passphrase, network inferred from a
      substring that pubnet does not contain, send leg hardcoded to XLM
      regardless of the asset withdrawn, and a fabricated placeholder job that
      could re-send a payment); the state-durability blocker remains.
- [ ] **`db-backup.yml` points at the testnet database.** Repoint before relying
      on it for mainnet.
- [x] ~~**Dependabot PR #148**~~ — closed 2026-08-22. The repo has no open
      Dependabot PRs; the monthly security-only config is doing its job.

---

## 5. Mainnet-readiness audit (2026-08-25) — what stays with you

The audit's twenty findings were triaged on 2026-08-26. Fifteen are ordinary
engineering and are now filed as contributor issues — **#152–#166**, in
`ISSUES.md` as 4.11, 4.12, 5.8–5.12, 6.6, 6.7, 7.8 and 8.8–8.12. What is left
here is the part no contributor can do for you: it needs a secret, a credential,
a paid account, or your judgement about real money.

**Gate these two before anyone's fix ships**

- [ ] **#152 — duplicate-payment protection keyed by transaction, not operation.**
      A two-operation transaction, or one transaction paying two watched sellers,
      leaves a fully-paid link `underpaid` or `unpaid` forever with no recovery
      path. Review the fix and its migration yourself; a wrong dedup key is worse
      than none.
- [ ] **#159 — an API key can mint itself a broader key.** The escalation ends at
      `payoutFields` on cash-out, which redirects proceeds. Review the subset
      check personally, and rotate any API key issued before the fix lands.

**Infrastructure you have to buy or provision**

- [ ] **Redis.** `REDIS_URL` unset means rate-limit counters *and* SEP-10
      challenge nonces (#160) are per-process — N instances, N× the limit and N
      redemptions of one signature. Provision before scaling past one instance.
- [ ] **A real database.** Tracked in §1; repeated here because it is the single
      item that loses the payment ledger rather than degrading a feature.
- [ ] **A least-privilege API key for the synthetic uptime check** (#163), stored
      as a repo secret. The check has been failing since seller auth landed and
      cannot be fixed without a credential you issue.
- [ ] **Mainnet monitoring targets** (#162). The code change is delegated; the
      URLs and secrets for `quay-api-mainnet`, and re-enabling the schedule in
      `.github/workflows/uptime.yml` (disabled in `a0f06d1`), are yours.
- [ ] **Repoint `anchor-probe.yml` and `db-backup.yml`** at mainnet
      infrastructure — see §4. Both still watch testnet.

**Repo settings**

- [ ] **Authorize Vercel deployments for pull requests.** Every contributor PR
      currently shows a red Vercel check reading *"Authorization required to
      deploy"*. It is not a code failure, but it trains reviewers to ignore a red
      check, which is how a real one gets missed.
- [ ] **Keep the base-image digest fresh.** `apps/api/Dockerfile` pins
      `node:22-alpine` by digest and the Trivy gate fails HIGH/CRITICAL, so a
      disclosed CVE turns every PR red until someone bumps it. On 2026-08-26 that
      was CVE-2026-14456 (openssl); the fix in place is a targeted
      `apk upgrade libcrypto3 libssl3`, because the newer tag carries the same
      unpatched openssl and 2 MB more, which breaks the 250 MB size budget. The
      monthly cadence noted in the Dockerfile is the real mitigation.

**Backlog hygiene**

- [ ] Six stale contributor PRs were closed on 2026-08-26 (#80, #101, #102, #104,
      #110, #118) — each had drifted a month behind `main` and no longer merged;
      one did not compile. Their issues stay open and unclaimed: **#14** (SEP-1
      discovery), **#22** (durable webhook queue — also the audit's "one slow
      receiver stalls every seller" finding), **#35** (expiry countdown),
      **#37** (Playwright e2e), **#41** (per-seller scoping), **#49** (coverage
      gating). Consider labelling `help-wanted` so they are visibly free.

---

## 6. Verification before announcing

The full list is in `docs/MAINNET.md` (Phase 5). The two that matter most:

- [ ] A **small real payment** moves a link to `paid`.
- [ ] If the off-ramp is enabled: a **small real cash-out** reaches `settled`
      and the money actually arrives — before anyone else uses the service.
