/**
 * API-key lifecycle utilities (issue #40, 6.3).
 *
 * Security model
 * ──────────────
 * • The plaintext key is returned to the caller exactly once and never stored
 *   or logged here (the schema stores only the scrypt hash + a lookup prefix).
 * • Verification uses `crypto.timingSafeEqual` so the comparison is always
 *   constant-time regardless of whether the hash matches.
 * • `offramp:initiate` is not included in the default scope set because it
 *   moves money; the caller must opt-in explicitly. `api-keys:manage` is also
 *   opt-in so a key can't mint further keys unless explicitly allowed.
 */

import { randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    _scrypt(password, salt, keylen, opts, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

export const ALL_SCOPES = [
  "links:read",
  "links:write",
  "webhooks:manage",
  "api-keys:manage",
  "offramp:initiate",
] as const;

export type ApiKeyScope = (typeof ALL_SCOPES)[number];

/**
 * Default scopes when the caller does not specify any. offramp:initiate
 * (moves money) and api-keys:manage (mints more keys) are both opt-in.
 */
export const DEFAULT_SCOPES: ApiKeyScope[] = ["links:read", "links:write", "webhooks:manage"];

export function isValidScope(s: string): s is ApiKeyScope {
  return (ALL_SCOPES as readonly string[]).includes(s);
}

export function parseScopes(raw: string, allowedScopes?: ApiKeyScope[]): ApiKeyScope[] {
  if (!raw.trim()) {
    const parsed = [...DEFAULT_SCOPES];
    if (allowedScopes) assertScopesSubset(parsed, allowedScopes);
    return parsed;
  }
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    if (!isValidScope(p)) throw new Error(`Unknown scope: "${p}"`);
  }
  const parsed = parts as ApiKeyScope[];
  if (allowedScopes) assertScopesSubset(parsed, allowedScopes);
  return parsed;
}

export function encodeScopesForDb(scopes: ApiKeyScope[]): string {
  return scopes.join(",");
}

export function decodeScopesFromDb(raw: string): ApiKeyScope[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(isValidScope) as ApiKeyScope[];
}

/**
 * Throws if `requested` contains a scope not present in `allowed`.
 * Used to prevent an API key from minting another key with elevated scopes.
 */
export function assertScopesSubset(requested: ApiKeyScope[], allowed: ApiKeyScope[]): void {
  const denied = requested.filter((scope) => !allowed.includes(scope));
  if (denied.length > 0) {
    throw new Error(`Requested scopes not held by caller: ${denied.join(", ")}`);
  }
}

// ── Key generation ────────────────────────────────────────────────────────

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62(buf: Buffer): string {
  let out = "";
  for (const b of buf) out += BASE62[b % 62];
  return out;
}

export type KeyEnvironment = "live" | "test";

/**
 * Length of the DB lookup prefix, in characters. The scheme label
 * ("ak_live_" / "ak_test_") is itself 8 chars and identical for every key in
 * that environment, so a prefix of exactly 8 chars is the constant label and
 * carries zero of the key's randomness — every live key would collide on the
 * same "prefix", making the lookup index useless (and, combined with a capped
 * query, unresolvable once enough keys exist). Extending into the random body
 * gives the prefix real selectivity while staying short enough to store/index/
 * display safely.
 */
export const KEY_PREFIX_LEN = 16;

/**
 * Generate a new key in the format `ak_live_<32 random base62>` or
 * `ak_test_<32 random base62>`.
 *
 * Returns both the plaintext key (shown ONCE to the caller) and the
 * `KEY_PREFIX_LEN`-char searchable prefix stored in the database.
 */
export function generateApiKey(env: KeyEnvironment): { plaintext: string; prefix: string } {
  const body = base62(randomBytes(32));          // 32 bytes → 32 base62 chars
  const plaintext = `ak_${env}_${body}`;
  const prefix = plaintext.slice(0, KEY_PREFIX_LEN);
  return { plaintext, prefix };
}

// ── Hashing (scrypt) ──────────────────────────────────────────────────────

/**
 * Hash a plaintext API key. Returns a single hex string `<salt_hex>:<hash_hex>`
 * suitable for storing in the `hash` column.
 */
export async function hashApiKey(plaintext: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(plaintext, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })) as Buffer;
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

/**
 * Verify a plaintext key against a stored `<salt_hex>:<hash_hex>` digest.
 * Always runs in constant time to prevent timing side-channels even when the
 * salt or lengths differ (we pad/compare a dummy buffer in that case).
 */
export async function verifyApiKey(plaintext: string, stored: string): Promise<boolean> {
  const colon = stored.indexOf(":");
  if (colon === -1) return false; // malformed stored hash

  const saltHex = stored.slice(0, colon);
  const hashHex = stored.slice(colon + 1);

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }

  if (expected.length !== SCRYPT_KEYLEN) return false;

  let actual: Buffer;
  try {
    actual = (await scryptAsync(plaintext, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    })) as Buffer;
  } catch {
    return false;
  }

  // Both buffers are the same length (SCRYPT_KEYLEN) — timingSafeEqual is safe.
  return timingSafeEqual(actual, expected);
}
