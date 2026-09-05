#!/usr/bin/env node
// Uptime + synthetic check, multi-environment (issue 8.8). Run standalone
// (`pnpm sweep`) or on a schedule (.github/workflows/uptime.yml), which also
// persists history to docs/uptime-state.json and regenerates docs/STATUS.md +
// the README badges.
//
// No external monitoring service required: this is the whole check.
//
// Environments: testnet is always checked, using the same env vars and target
// ids (`api` / `web` / `synthetic`) this script has always used — existing
// history and badge files keep working with no migration. Mainnet is checked
// only once UPTIME_MAINNET_API_URL is actually set (a repo Actions variable,
// see docs/RUNBOOK.md): unlike testnet there is no default of any kind, on
// purpose — render.mainnet.yaml's own guidance is that a default here would
// silently mean "the testnet sandbox", and a mainnet outage that goes
// unreported because the checker quietly monitored the wrong service is worse
// than one that's honestly unconfigured. Mainnet's targets are prefixed
// (`mainnet-api` / `mainnet-web` / `mainnet-synthetic`) so they get their own
// history series and never collide with testnet's.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const statePath = resolve(root, "docs/uptime-state.json");
const statusPath = resolve(root, "docs/STATUS.md");

const HISTORY_DAYS = 90;
const FETCH_TIMEOUT_MS = 15000;
const FAILURE_THRESHOLD = 2;

function envUrl(vars, name) {
  const v = vars[name];
  return v && v.trim() ? v.trim() : null;
}

/**
 * The environments this run checks. `apiUrl: null` means "not configured" —
 * filtered out below rather than checked against a guessed URL.
 */
export function buildEnvironments(vars = process.env) {
  return [
    {
      id: "testnet",
      label: "Testnet",
      // Back-compat: UPTIME_API_URL / UPTIME_WEB_URL are the original,
      // unprefixed names this script has always read; always defaults to the
      // public testnet deploy so `pnpm sweep` works with zero setup.
      apiUrl: envUrl(vars, "UPTIME_TESTNET_API_URL") ?? envUrl(vars, "UPTIME_API_URL") ?? "https://quay-api.onrender.com",
      webUrl: envUrl(vars, "UPTIME_TESTNET_WEB_URL") ?? envUrl(vars, "UPTIME_WEB_URL") ?? "https://quay-web.vercel.app",
      // Dedicated least-privilege key (links:read + links:write) for the
      // synthetic write check — POST /links has required auth since 6.x.
      apiKey: envUrl(vars, "UPTIME_API_KEY"),
      syntheticLink: true,
      prefixIds: false,
    },
    {
      id: "mainnet",
      label: "Mainnet",
      apiUrl: envUrl(vars, "UPTIME_MAINNET_API_URL"),
      webUrl: envUrl(vars, "UPTIME_MAINNET_WEB_URL"),
      // Its own key, never testnet's — a testnet key cannot create links on
      // mainnet, and sharing one would defeat the least-privilege point.
      apiKey: envUrl(vars, "UPTIME_MAINNET_API_KEY"),
      // Off unless explicitly opted into: this writes a throwaway row into the
      // REAL production database on every successful run. Issue 8.9 gave the
      // check a scoped key and cleanup, so it is now safe to enable — but it
      // stays opt-in because "safe to run" is not the same as "should run
      // against production without the operator deciding to".
      syntheticLink: envUrl(vars, "UPTIME_MAINNET_SYNTHETIC_CHECK") === "1",
      prefixIds: true,
    },
  ];
}

/** Environments that actually have an API URL configured — the rest are skipped, not guessed. */
export function activeEnvironments(environments) {
  return environments.filter((env) => env.apiUrl);
}

/** Per-environment targets: API (always), web (if configured), synthetic-link (if enabled). */
export function buildTargets(environments) {
  const targets = [];
  for (const env of activeEnvironments(environments)) {
    const prefix = env.prefixIds ? `${env.id}-` : "";
    targets.push({
      id: `${prefix}api`,
      kind: "API",
      label: `${env.label} — API`,
      env,
      check: () => checkGet(`${env.apiUrl}/health`),
    });
    if (env.webUrl) {
      targets.push({
        id: `${prefix}web`,
        kind: "Web dashboard",
        label: `${env.label} — Web dashboard`,
        env,
        check: () => checkGet(env.webUrl),
      });
    }
    if (env.syntheticLink) {
      targets.push({
        id: `${prefix}synthetic`,
        kind: "Create-link (synthetic)",
        label: `${env.label} — Create-link (synthetic)`,
        env,
        check: () => checkSyntheticLink(env.apiUrl, env.apiKey),
      });
    }
  }
  return targets;
}

async function checkGet(url) {
  const res = await fetchWithTimeout(url, { method: "GET" });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
}

/**
 * Synthetic create-link check: proves the authenticated public write path
 * works end to end (issue 8.9).
 *
 * `POST /links` has required a seller session or a scoped API key since 6.x,
 * so this check 401'd on every run for reasons that had nothing to do with
 * availability — a permanent false negative sitting next to two real checks.
 * It now sends a dedicated least-privilege key (`links:read` + `links:write`).
 *
 * The created link is cancelled immediately afterwards so synthetic rows stop
 * accumulating. Cleanup failure is logged, not fatal: the write path — the
 * thing being measured — already succeeded by that point, and failing the
 * probe over cleanup would report an outage that isn't one.
 */
export async function checkSyntheticLink(apiUrl, apiKey, fetchImpl = fetchWithTimeout) {
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const createRes = await fetchImpl(`${apiUrl}/links`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "uptime-check", amount: "0.0000001", assetCode: "XLM" }),
  });

  if (createRes.status === 401 && !apiKey) {
    throw new Error(
      `POST ${apiUrl}/links -> HTTP 401 and no API key is configured. ` +
        "Add a least-privilege API key (links:read + links:write) as the UPTIME_API_KEY repo secret " +
        "(UPTIME_MAINNET_API_KEY for mainnet).",
    );
  }

  if (createRes.status !== 201) {
    throw new Error(`POST ${apiUrl}/links -> HTTP ${createRes.status} (expected 201)`);
  }

  try {
    const body = await createRes.json();
    const linkId = body?.link?.id;
    if (!linkId) return;
    const cancelRes = await fetchImpl(`${apiUrl}/links/${linkId}/cancel`, {
      method: "POST",
      headers,
    });
    if (!cancelRes.ok) {
      console.warn(`[uptime] could not cancel synthetic link ${linkId} (HTTP ${cancelRes.status})`);
    }
  } catch (err) {
    console.warn(`[uptime] synthetic link cleanup failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function fetchWithTimeout(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return { targets: {} };
  }
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // "2026-07-27"
}

function emptyTargetState() {
  return { consecutiveFailures: 0, lastStatus: null, lastCheckedAt: null, today: null, history: [] };
}

/** Mutates `state.targets[id]` with this run's result; returns { justFailed, justRecovered }. */
export function recordResult(state, id, ok, message) {
  const t = (state.targets[id] ??= emptyTargetState());
  const day = todayUTC();

  if (!t.today || t.today.date !== day) {
    if (t.today) {
      t.history.push({ date: t.today.date, up: t.today.up, down: t.today.down });
      if (t.history.length > HISTORY_DAYS) t.history = t.history.slice(-HISTORY_DAYS);
    }
    t.today = { date: day, up: 0, down: 0 };
  }
  if (ok) t.today.up += 1;
  else t.today.down += 1;

  const wasFailing = t.consecutiveFailures >= FAILURE_THRESHOLD;
  t.consecutiveFailures = ok ? 0 : t.consecutiveFailures + 1;
  const isFailing = t.consecutiveFailures >= FAILURE_THRESHOLD;

  t.lastStatus = ok ? "up" : "down";
  t.lastCheckedAt = new Date().toISOString();
  t.lastError = ok ? null : message;

  return { justFailed: !wasFailing && isFailing, justRecovered: wasFailing && ok };
}

export function uptimePct(history, today) {
  const days = today ? [...history, { up: today.up, down: today.down }] : history;
  const totals = days.reduce((acc, d) => ({ up: acc.up + d.up, down: acc.down + d.down }), { up: 0, down: 0 });
  const total = totals.up + totals.down;
  return total === 0 ? 100 : (100 * totals.up) / total;
}

function renderBadge(targetState, id) {
  const pct = uptimePct(targetState.history, targetState.today);
  const color =
    targetState.consecutiveFailures >= FAILURE_THRESHOLD ? "red" : pct >= 99.5 ? "brightgreen" : pct >= 95 ? "yellow" : "orange";
  return {
    schemaVersion: 1,
    label: id,
    message: `${pct.toFixed(2)}% (90d)`,
    color,
  };
}

/** Grouped by environment, so a green testnet section can never stand in for a missing mainnet one. */
export function renderStatusMd(state, environments) {
  const targets = buildTargets(environments);
  const lines = [
    "# Status",
    "",
    // Issue 8.9: regeneration stopped when the schedule was disabled, so this
    // page kept showing an old green. A visible timestamp makes a stale page
    // read as stale rather than as healthy.
    `> **Last regenerated:** ${new Date().toISOString()}`,
    "",
    "Generated by `.github/workflows/uptime.yml` (every 5 minutes) — do not edit by hand.",
    "",
  ];
  for (const env of activeEnvironments(environments)) {
    const envTargets = targets.filter((t) => t.env === env);
    if (!envTargets.some((t) => state.targets[t.id])) continue; // never checked yet — nothing to report
    lines.push(`## ${env.label}`);
    lines.push("");
    for (const target of envTargets) {
      const t = state.targets[target.id];
      if (!t) continue;
      const pct = uptimePct(t.history, t.today);
      lines.push(`### ${target.kind}`);
      lines.push("");
      lines.push(`- Status: **${t.lastStatus === "up" ? "🟢 up" : "🔴 down"}** (last checked ${t.lastCheckedAt})`);
      lines.push(`- Uptime (last ${HISTORY_DAYS} days): **${pct.toFixed(2)}%**`);
      if (t.lastError) lines.push(`- Last error: \`${t.lastError}\``);
      lines.push("");
      lines.push("| Date | Up | Down |");
      lines.push("| --- | --- | --- |");
      const rows = [...t.history, t.today].filter(Boolean).slice(-HISTORY_DAYS);
      for (const row of rows.slice().reverse()) {
        lines.push(`| ${row.date} | ${row.up} | ${row.down} |`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

async function main() {
  const environments = buildEnvironments(process.env);
  const targets = buildTargets(environments);
  const state = await loadState();
  const events = [];

  for (const target of targets) {
    let ok = true;
    let message = null;
    try {
      await target.check();
    } catch (err) {
      ok = false;
      message = err instanceof Error ? err.message : String(err);
    }
    const { justFailed, justRecovered } = recordResult(state, target.id, ok, message);
    console.log(`[uptime] ${target.label}: ${ok ? "OK" : `FAIL — ${message}`}`);
    if (justFailed) events.push({ type: "failed", target });
    if (justRecovered) events.push({ type: "recovered", target });
  }

  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2) + "\n");
  await writeFile(statusPath, renderStatusMd(state, environments) + "\n");

  for (const target of targets) {
    const badgePath = resolve(root, `docs/uptime-badge-${target.id}.json`);
    await writeFile(badgePath, JSON.stringify(renderBadge(state.targets[target.id], target.id), null, 2) + "\n");
  }

  if (events.length > 0) {
    console.log(
      "EVENTS_JSON=" +
        JSON.stringify(events.map((e) => ({ type: e.type, target: e.target.id, label: e.target.label }))),
    );
  }

  const anyDown = targets.some((t) => state.targets[t.id]?.consecutiveFailures >= FAILURE_THRESHOLD);
  if (anyDown && process.env.UPTIME_STRICT_EXIT === "1") process.exitCode = 1;
}

function isCliInvocation() {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isCliInvocation()) {
  main().catch((err) => {
    console.error("[uptime] fatal:", err);
    process.exitCode = 1;
  });
}
