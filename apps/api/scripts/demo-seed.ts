#!/usr/bin/env tsx
/**
 * apps/api/scripts/demo-seed.ts
 *
 * Populates the dashboard with real on-chain data so a first-time visitor
 * sees a genuinely populated, paid, and cashed-out demo instead of an empty
 * screen. Runs against whatever STELLAR_NETWORK the API itself is configured
 * for (defaulting to testnet) — see the Config section below.
 *
 * What it does:
 *   1. Authenticates as the configured demo seller (SEP-10 login → session).
 *   2. Generates a fresh "buyer" keypair. On testnet, funds it via Friendbot;
 *      on any other network, Friendbot doesn't exist, so this step is skipped
 *      with a clear message instead of failing obscurely later.
 *   3. Adds a USDC trustline on the buyer.
 *   4. On testnet, funds the buyer with USDC via the testanchor dispenser.
 *   5. Creates several payment links via POST /links (flagged isDemo:true),
 *      including one with the fixed id the /demo storefront page links to.
 *   6. Submits real Stellar payments from the buyer to the seller using the
 *      correct memo for each link so the watcher can match them.
 *   7. Polls GET /links until the target links flip to "paid".
 *   8. Triggers POST /links/:id/cash-out on one paid link so the dashboard
 *      shows an offramp_settled row (mock off-ramp settles quickly).
 *
 * Invariant: every row written is real on-chain data — nothing is fabricated
 * directly in the database.
 *
 * Auth: the script authenticates as the configured demo seller (SEP-10 login)
 * so the seeded links land under the same seller the dashboard already knows.
 * Requires DEFAULT_SELLER_SECRET (matching DEFAULT_SELLER_WALLET) in .env.
 *
 * Usage:
 *   pnpm demo:seed                         # uses defaults from .env
 *   API_URL=http://localhost:8787 pnpm demo:seed
 *
 * This lives under apps/api/ (not the repo root) because it depends on
 * @stellar/stellar-sdk — pnpm's strict node_modules layout means a script in
 * the repo root cannot resolve it (see apps/api/scripts/gen-mainnet-secrets.mjs).
 */

import {
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
  Horizon,
} from "@stellar/stellar-sdk";
import { resolveStellarConfig, type StellarNetwork } from "@checkout/stellar";
import { loadEnvFile, envValue, envValueOptional } from "./lib/env";
import { loginAsSeller } from "./lib/sep10-login";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const envFile = loadEnvFile();
const API_URL = envValue(envFile, "API_URL", envValue(envFile, "NEXT_PUBLIC_API_URL", "http://localhost:8787"));

// Same network the API itself reads (apps/api/src/env.ts) — defaulting to
// testnet, never hardcoded, so this script works against a mainnet or
// self-hosted deployment too.
const NETWORK = (envValueOptional(envFile, "STELLAR_NETWORK") ?? "testnet") as StellarNetwork;
if (NETWORK !== "testnet" && NETWORK !== "public") {
  throw new Error(`STELLAR_NETWORK must be "testnet" or "public", got "${NETWORK}"`);
}
const USDC_ISSUER =
  NETWORK === "public"
    ? envValue(envFile, "USDC_ISSUER_PUBLIC")
    : envValue(envFile, "USDC_ISSUER_TESTNET", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const stellar = resolveStellarConfig({
  network: NETWORK,
  horizonUrl: envValueOptional(envFile, "HORIZON_URL"),
  usdcIssuer: USDC_ISSUER,
});
const HORIZON_URL = stellar.horizonUrl;
const NETWORK_PASSPHRASE = stellar.networkPassphrase;

// The seed script logs in as the demo seller (SEP-10) so links land under the
// seller the dashboard already shows. Only a secret can sign the challenge.
const DEFAULT_SELLER_SECRET = envValue(envFile, "DEFAULT_SELLER_SECRET");
const IS_TESTNET = NETWORK === "testnet";
const FRIENDBOT = "https://friendbot.stellar.org";
// The testanchor hosts a USDC dispenser for testnet.
const USDC_FRIENDBOT = "https://testanchor.stellar.org/testnet/friendbot";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function friendbot(address: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}?addr=${address}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 400 with "createAccountAlreadyExist" means it's already funded — fine.
    if (body.includes("createAccountAlreadyExist")) return;
    throw new Error(`Friendbot failed for ${address}: ${res.status} ${body}`);
  }
}

async function usdcFriendbot(address: string): Promise<void> {
  const res = await fetch(`${USDC_FRIENDBOT}?addr=${address}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // testanchor friendbot may 400 if already funded; ignore gracefully.
    if (res.status === 400) {
      console.warn(`  [warn] USDC friendbot returned 400 for ${address}: ${body.slice(0, 120)}`);
      return;
    }
    throw new Error(`USDC friendbot failed: ${res.status} ${body}`);
  }
}

async function addTrustline(server: Horizon.Server, account: Keypair, issuer: string): Promise<void> {
  const usdcAsset = new Asset("USDC", issuer);
  const acc = await server.loadAccount(account.publicKey());
  // Check if trustline already exists.
  const hasTrust = acc.balances.some(
    (b) => b.asset_type === "credit_alphanum4" &&
      (b as { asset_code: string; asset_issuer: string }).asset_code === "USDC" &&
      (b as { asset_code: string; asset_issuer: string }).asset_issuer === issuer,
  );
  if (hasTrust) {
    console.log(`  trustline already exists for ${account.publicKey().slice(0, 8)}…`);
    return;
  }
  const tx = new TransactionBuilder(acc, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset: usdcAsset }))
    .setTimeout(30)
    .build();
  tx.sign(account);
  await server.submitTransaction(tx);
  console.log(`  trustline added for ${account.publicKey().slice(0, 8)}…`);
}

async function sendUsdc(
  server: Horizon.Server,
  from: Keypair,
  to: string,
  amount: string,
  memo: string,
): Promise<string> {
  const usdcAsset = new Asset("USDC", USDC_ISSUER);
  const acc = await server.loadAccount(from.publicKey());
  const tx = new TransactionBuilder(acc, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({ destination: to, asset: usdcAsset, amount }),
    )
    .addMemo({ value: memo, type: "text" } as Parameters<TransactionBuilder["addMemo"]>[0])
    .setTimeout(30)
    .build();
  tx.sign(from);
  const result = await server.submitTransaction(tx);
  return result.hash;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiPost<T>(path: string, body: unknown, token: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function apiGet<T>(path: string, token?: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Link definitions
// ---------------------------------------------------------------------------

interface LinkDef {
  title: string;
  amount: string;
  /** Whether to pay this link during seeding. */
  pay: boolean;
  /** Whether to trigger a cash-out after payment (requires mock off-ramp). */
  cashOut?: boolean;
}

const LINK_DEFS: LinkDef[] = [
  { title: "Demo — Handcrafted Ceramic Mug",        amount: "25.00", pay: true, cashOut: true },
  { title: "Demo — SaaS subscription (monthly)",    amount: "49.00", pay: true },
  { title: "Demo — Freelance design retainer",      amount: "250.00", pay: false },
  { title: "Demo — E-book: Stellar for Developers", amount: "9.99",  pay: true },
  { title: "Demo — Conference ticket deposit",      amount: "75.00", pay: false },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface LinkResponse {
  link: { id: string; reference: string; destination: string; status: string; amount: string };
  request: { memo: string; destination: string; amount: string };
}

async function main(): Promise<void> {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║           Stellar Checkout — demo seed script           ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // -- Check API is reachable -------------------------------------------------
  console.log(`▶ Checking API at ${API_URL}…`);
  const health = await apiGet<{ ok: boolean; network: string; sellerWallet: string }>("/health");
  if (!health.ok) throw new Error("API health check failed");
  if (health.network !== NETWORK) {
    throw new Error(
      `This script is configured for STELLAR_NETWORK="${NETWORK}", but the API at ${API_URL} ` +
      `is running "${health.network}". Point STELLAR_NETWORK/API_URL at the same deployment.`,
    );
  }
  const sellerWallet = health.sellerWallet;
  console.log(`  ✓ API ok  network=${NETWORK}  seller=${sellerWallet.slice(0, 8)}…\n`);

  // -- Authenticate as the demo seller (SEP-10) -------------------------------
  console.log("▶ Authenticating as demo seller via SEP-10…");
  const { token, publicKey } = await loginAsSeller(API_URL, DEFAULT_SELLER_SECRET);
  if (publicKey !== sellerWallet) {
    // Belt-and-braces: the secret the operator configured must actually match
    // the wallet the API is collecting payments into.
    throw new Error(
      "DEFAULT_SELLER_SECRET does not match the seller wallet served by GET /health " +
      `(secret → ${publicKey.slice(0, 8)}…, health → ${sellerWallet.slice(0, 8)}…)`,
    );
  }
  console.log(`  ✓ session minted for seller ${sellerWallet.slice(0, 8)}…\n`);

  const server = new Horizon.Server(HORIZON_URL);

  // -- Fund buyer account via Friendbot ---------------------------------------
  console.log("▶ Generating buyer keypair…");
  const buyer = Keypair.random();
  console.log(`  buyer: ${buyer.publicKey()}`);
  if (IS_TESTNET) {
    console.log("  funding via Friendbot…");
    await friendbot(buyer.publicKey());
    console.log("  ✓ XLM funded");
  } else {
    console.log(
      `  [skip] Friendbot only exists on testnet — this is "${NETWORK}". Fund ${buyer.publicKey()} ` +
      "with XLM (and USDC, below) yourself before the payment step, or it will fail with the " +
      "real Horizon error (e.g. account not found) rather than silently.",
    );
  }

  // -- Add USDC trustlines ----------------------------------------------------
  console.log("\n▶ Adding USDC trustlines…");
  await addTrustline(server, buyer, USDC_ISSUER);

  // -- Fund buyer with USDC ---------------------------------------------------
  if (IS_TESTNET) {
    console.log("\n▶ Requesting testnet USDC for buyer via testanchor friendbot…");
    await usdcFriendbot(buyer.publicKey());
    // Give Horizon a moment to see the USDC balance.
    await sleep(3000);
  } else {
    console.log(
      `\n▶ [skip] The testanchor USDC dispenser only exists on testnet — fund ${buyer.publicKey()} ` +
      "with USDC manually before the payment step below.",
    );
  }
  const buyerAcc = await server.loadAccount(buyer.publicKey());
  const usdcBalance = buyerAcc.balances.find(
    (b) =>
      b.asset_type === "credit_alphanum4" &&
      (b as { asset_code: string }).asset_code === "USDC",
  );
  const buyerUsdc = usdcBalance ? (usdcBalance as { balance: string }).balance : "0";
  console.log(`  buyer USDC balance: ${buyerUsdc}`);
  if (parseFloat(buyerUsdc) < 1) {
    console.warn(
      "  [warn] buyer has very little USDC. Paid links may fail.\n" +
      "  To fund manually, send USDC to:\n  " + buyer.publicKey(),
    );
  }

  // -- Create payment links via the API ---------------------------------------
  console.log("\n▶ Creating demo payment links…");
  const created: Array<{ def: LinkDef; link: LinkResponse["link"]; memo: string }> = [];
  for (const def of LINK_DEFS) {
    const result = await apiPost<LinkResponse>("/links", {
      title: def.title,
      amount: def.amount,
      assetCode: "USDC",
      isDemo: true,
    }, token);
    console.log(`  ✓ ${def.title.padEnd(45)} ${def.amount} USDC  ref=${result.link.reference}`);
    created.push({ def, link: result.link, memo: result.request.memo });
  }

  // -- Submit on-chain payments for links marked pay:true --------------------
  console.log("\n▶ Submitting on-chain USDC payments from buyer…");
  const paidIds: string[] = [];
  for (const { def, link, memo } of created) {
    if (!def.pay) continue;
    console.log(`  paying ${link.amount} USDC → memo="${memo}"…`);
    const hash = await sendUsdc(server, buyer, sellerWallet, link.amount, memo);
    console.log(`  ✓ tx: ${hash}`);
    paidIds.push(link.id);
    await sleep(1000); // small gap between submissions
  }

  // -- Wait for the watcher to mark links as paid ----------------------------
  if (paidIds.length > 0) {
    console.log(`\n▶ Waiting for watcher to mark ${paidIds.length} link(s) paid…`);
    const POLL_MAX = 60; // up to 60s
    const POLL_INTERVAL = 3000;
    let settled = new Set<string>();
    for (let i = 0; i < POLL_MAX * (1000 / POLL_INTERVAL); i++) {
      await sleep(POLL_INTERVAL);
      const { links } = await apiGet<{ links: Array<{ id: string; status: string }> }>("/links", token);
      for (const l of links) {
        if (paidIds.includes(l.id) && l.status === "paid") settled.add(l.id);
      }
      const remaining = paidIds.filter((id) => !settled.has(id));
      process.stdout.write(`\r  paid: ${settled.size}/${paidIds.length}  (${remaining.length} pending…)  `);
      if (remaining.length === 0) break;
    }
    console.log(`\n  ✓ All target links paid (or timed out).`);
  }

  // -- Trigger cash-out on one paid link ------------------------------------
  const cashOutDef = created.find((c) => c.def.cashOut);
  if (cashOutDef) {
    console.log(`\n▶ Triggering cash-out on "${cashOutDef.def.title}"…`);
    try {
      const job = await apiPost<{ job: { jobId: string; status: string; targetAmount: string } }>(
        `/links/${cashOutDef.link.id}/cash-out`,
        { targetCurrency: "NGN" },
        token,
      );
      console.log(`  ✓ job=${job.job.jobId}  status=${job.job.status}  target=${job.job.targetAmount} NGN`);
      // Wait for mock off-ramp to settle (it settles in ~8s).
      console.log("  Waiting for mock off-ramp to settle…");
      await sleep(12000);
      const { links } = await apiGet<{ links: Array<{ id: string; status: string }> }>("/links", token);
      const settled = links.find((l) => l.id === cashOutDef.link.id);
      if (settled?.status === "offramp_settled") {
        console.log("  ✓ Link status: offramp_settled");
      } else {
        console.log(`  status: ${settled?.status ?? "unknown"} (may still be settling)`);
      }
    } catch (err) {
      // Don't fail the whole seed if cash-out doesn't work (e.g. link not yet paid).
      console.warn(`  [warn] cash-out failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // -- Summary ---------------------------------------------------------------
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  ✓  Demo seed complete!                                 ║");
  console.log("║                                                          ║");
  console.log("║  Open the dashboard to see real paid and settled rows.  ║");
  console.log("║  Run `pnpm demo:reset` to clear the seeded data.        ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
}

main().catch((err) => {
  console.error("\n[demo-seed] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
