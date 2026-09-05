#!/usr/bin/env tsx
/**
 * apps/api/scripts/demo-reset.ts
 *
 * Removes all rows flagged as demo data (is_demo = true) from the database
 * by calling POST /demo/reset on the local API.
 *
 * The endpoint is seller-authenticated (requireSeller), so this script logs in
 * as the configured demo seller via SEP-10 — same DEFAULT_SELLER_SECRET as
 * `pnpm demo:seed`.
 *
 * Usage:
 *   pnpm demo:reset
 *   API_URL=http://localhost:8787 pnpm demo:reset
 */

import { loadEnvFile, envValue } from "./lib/env";
import { loginAsSeller } from "./lib/sep10-login";

const envFile = loadEnvFile();
const API_URL = envValue(envFile, "API_URL", envValue(envFile, "NEXT_PUBLIC_API_URL", "http://localhost:8787"));
const DEFAULT_SELLER_SECRET = envValue(envFile, "DEFAULT_SELLER_SECRET");

async function main(): Promise<void> {
  console.log(`\n▶ Authenticating as demo seller via SEP-10…`);
  const { token } = await loginAsSeller(API_URL, DEFAULT_SELLER_SECRET);

  console.log(`▶ Resetting demo data via ${API_URL}/demo/reset…`);
  const res = await fetch(`${API_URL}/demo/reset`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST /demo/reset → ${res.status}: ${text}`);
  }
  const body = JSON.parse(text) as { ok: boolean; deleted: number };
  console.log(`  ✓ Deleted ${body.deleted} demo link(s).\n`);
}

main().catch((err) => {
  console.error("\n[demo-reset] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
