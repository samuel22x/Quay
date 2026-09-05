#!/usr/bin/env node
// Enforces "every env var the API reads is documented": fails if any
// process.env.X read under apps/api/src has no matching X= line in either
// .env.example or .env.public.example. Run via `pnpm docs:check-env-docs`
// (wired into CI) — see issue #164.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = resolve(here, "..", "apps/api/src");

// Platform-injected/standard-convention vars, not Quay-specific tuning knobs
// an operator sets from the example templates.
const EXEMPT = new Set(["NODE_ENV", "RENDER_EXTERNAL_HOSTNAME"]);

const ENV_READ_RE = /process\.env\.([A-Z][A-Z0-9_]*)/g;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) yield* walk(full);
    else if (entry.endsWith(".ts")) yield full;
  }
}

const readVars = new Map(); // name -> [files]
for (const file of walk(apiSrc)) {
  const raw = readFileSync(file, "utf8");
  // Strip line/block comments first so illustrative snippets in doc comments
  // (e.g. `process.env.X ?? "6000"`) aren't mistaken for real reads.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  let m;
  while ((m = ENV_READ_RE.exec(src))) {
    const name = m[1];
    if (EXEMPT.has(name)) continue;
    if (!readVars.has(name)) readVars.set(name, []);
    readVars.get(name).push(file);
  }
}

const exampleFiles = [
  resolve(here, "..", ".env.example"),
  resolve(here, "..", ".env.public.example"),
];
const documented = new Set();
const KEY_LINE_RE = /^#?\s*([A-Z][A-Z0-9_]*)=/;
for (const file of exampleFiles) {
  const src = readFileSync(file, "utf8");
  for (const line of src.split("\n")) {
    const m = KEY_LINE_RE.exec(line);
    if (m) documented.add(m[1]);
  }
}

const missing = [...readVars.keys()].filter((name) => !documented.has(name)).sort();

if (missing.length > 0) {
  console.error("[check-env-docs] env vars read in apps/api/src but not documented in an example file:\n");
  for (const name of missing) {
    const files = readVars.get(name).map((f) => f.replace(resolve(here, ".."), "").replace(/\\/g, "/"));
    console.error(`  ${name} (read in ${[...new Set(files)].join(", ")})`);
  }
  console.error(
    "\nAdd a commented KEY=default line (with a one-line explanation of what changing it " +
      "does) to .env.example, or to .env.public.example if it's mainnet-only. If this var is " +
      "platform-injected rather than operator-set, add it to EXEMPT in scripts/check-env-docs.mjs instead.",
  );
  process.exit(1);
}

console.log(`[check-env-docs] clean — every env var read in apps/api/src is documented.`);
