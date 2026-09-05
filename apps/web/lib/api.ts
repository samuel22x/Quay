import type { KycFieldSpec, KycStatus, PaymentLink, PaymentRequest, PayoutFieldDescriptor } from "@checkout/core";

export type { PaymentLink, PaymentRequest, PayoutFieldDescriptor };

export interface LinkWithRequest {
  link: PaymentLink;
  request: PaymentRequest;
}

/** Anchor field descriptors + the seller's previously-saved (masked) payout
 *  fields for the cash-out form (issue #32). */
export interface OfframpRequirements {
  /** Anchor's field descriptors — drives the dynamic form. */
  descriptors: PayoutFieldDescriptor[];
  /**
   * Previously-saved values, masked to last 4 chars server-side. Null on first
   * cash-out. The form uses these to show "already on file" and skips fields
   * the seller leaves blank (meaning "reuse saved value").
   */
  savedFields: Record<string, string> | null;
}

/** A webhook delivery record for timeline display. */
export interface WebhookDelivery {
  webhookId: string;
  linkId: string;
  event: string;
  statusCode: number | null;
  ok: boolean;
  error: string | null;
  createdAt: number;
}

export interface LinkDetail {
  link: PaymentLink;
  request: PaymentRequest;
  deliveries: WebhookDelivery[];
}

/** Fields exposed on the public receipt — never includes seller PII. */
export interface PublicReceipt {
  reference: string;
  title: string;
  amount: string;
  asset: { code: string; issuer: string | null };
  status: string;
  txHash: string | null;
  payer: string | null;
  paidAmount: string | null;
  createdAt: number;
  updatedAt: number;
  /**
   * On-chain settlement attestation, or null when this payment has not been
   * attested. `refHash` is what the registry is keyed by — the reference itself
   * is never written on-chain — so it is the value a holder looks up to check
   * this receipt without trusting whoever served it.
   */
  attestation: {
    contractId: string;
    refHash: string;
    txHash: string | null;
    ledger: number | null;
    attestedAt: number;
  } | null;
}

export interface KycView {
  status: KycStatus;
  requiredFields: KycFieldSpec[];
  providedFields: Record<string, string>;
  message: string | null;
  lastSyncedAt: number | null;
}

// Browser calls go to NEXT_PUBLIC_API_URL; server-side calls fall back to API_URL.
//
// This has actually broken production once already (docs/FIXLOG.md, BUG-1.4,
// 2026-07-14): a Vercel build ran with NEXT_PUBLIC_API_URL unset, so this
// fallback got baked into the client bundle, and every visitor's browser
// silently tried (and failed) to reach `localhost:8787` on their own
// machine - no error naming the real cause, just "Create link" doing
// nothing. The fix that shipped afterward was procedural (a deploy-checklist
// reminder), not code - nothing here actually stopped it from recurring.
// This does: the fallback only applies outside production, and a production
// build (NODE_ENV=production) missing the variable fails loudly, in the
// browser, at load time - before any component gets a chance to issue a
// doomed request. See docs/MAINNET.md's "NEXT_PUBLIC_*" footgun section.
const DEV_FALLBACK = "http://localhost:8787";

const BROWSER_BASE = ((): string => {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  if (process.env.NODE_ENV !== "production") return DEV_FALLBACK;

  // `typeof window` is a reliable environment check here (not a runtime
  // toggle): Next.js produces genuinely separate server and browser
  // bundles, and each evaluates this module's top level for the first time
  // in its own environment - a browser bundle really does run this inside
  // an actual browser. The server bundle doesn't need NEXT_PUBLIC_API_URL at
  // all if API_URL is set (see apiBase() below), so it isn't punished for a
  // client-only variable it never uses.
  if (typeof window !== "undefined") {
    throw new Error(
      "NEXT_PUBLIC_API_URL is not set. This is a production build, so there is no " +
        "localhost fallback - without it, every request from this browser would " +
        "silently target the visitor's own machine (this exact failure has happened " +
        "before - see docs/FIXLOG.md, BUG-1.4). Set NEXT_PUBLIC_API_URL and REBUILD: " +
        "NEXT_PUBLIC_* values are baked in at build time, so redeploying alone will " +
        "not pick up a newly-set value.",
    );
  }

  return DEV_FALLBACK;
})();

export function apiBase(): string {
  if (typeof window === "undefined") {
    return process.env.API_URL ?? BROWSER_BASE;
  }
  return BROWSER_BASE;
}

// Session token lives ONLY in memory for the lifetime of the page — never
// localStorage/sessionStorage (a persistent, JS-readable store is exactly what
// an XSS payload would go looking for). It's lost on a hard refresh; the
// httpOnly `session` cookie the API also sets is what survives that (sent
// automatically via `credentials: "include"`, never readable by this code).
let sessionToken: string | null = null;

export function setSessionToken(token: string | null): void {
  sessionToken = token;
}

export function getSessionToken(): string | null {
  return sessionToken;
}

// ── Typed error envelope ────────────────────────────────────────────────────

/** Machine-readable error codes the API can return in its `error` field. */
export type ApiErrorCode =
  | "not_found"
  | "invalid_body"
  | "conflict"
  | "kyc_required" // seller's SEP-12 KYC isn't ACCEPTED yet — see `missingFields`
  | "destination_cannot_receive" // seller wallet can't receive the asset — see `details.trustlineUri`
  | "payment_rejected" // wallet transaction was refused by Horizon; see `details.reason`
  | "wallet_rejected" // buyer closed or rejected the wallet prompt
  | "insufficient_balance"
  | "missing_trustline"
  | "wrong_network"
  | "unreachable" // synthetic — fetch itself threw (DNS / network down)
  | "server_error"; // 5xx or unexpected non-JSON response

/** Structured error thrown by http() so callers can branch on code. */
export class CheckoutError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    detail: string,
    /** Set when `code === "kyc_required"` and the API named specific missing fields. */
    readonly missingFields?: string[],
    /** Everything else in the error body — e.g. `reason`, `trustlineUri`. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(`${code} (${status}): ${detail}`);
    this.name = "CheckoutError";
  }
}

/** Map an error code to copy suitable for a seller-facing dashboard. */
export function describeError(err: CheckoutError): string {
  switch (err.code) {
    case "not_found":
      return "This link no longer exists. It may have been removed or the id is wrong.";
    case "invalid_body":
      return "The data sent to the server was invalid. Check your inputs and try again.";
    case "conflict":
      return "This action cannot be completed right now. The link may be in an unexpected state. Try refreshing.";
    case "kyc_required":
      return "Identity verification is required before you can cash out. See the panel above.";
    case "destination_cannot_receive":
      return "Your wallet can't receive this asset yet. Add the trustline and try again.";
    case "payment_rejected":
      return "The network rejected this payment. Check your balance, trustline, and wallet network, then try again.";
    case "insufficient_balance":
      return "Your wallet does not have enough balance to pay this invoice.";
    case "missing_trustline":
      return "Your wallet needs a trustline for this asset before it can pay.";
    case "wrong_network":
      return "Your wallet is connected to the wrong Stellar network for this invoice.";
    case "wallet_rejected":
      return "The wallet request was cancelled.";
    case "unreachable":
      return "We can't reach the payment service right now. Check your connection and try again.";
    case "server_error":
      return "Something went wrong on the server. Please try again in a moment.";
    default:
      return "An unexpected error occurred. Please try again.";
  }
}

// ── HTTP client ─────────────────────────────────────────────────────────────

/**
 * Thin fetch wrapper.
 *
 * - 2xx → parse JSON and return `T` (204 → `undefined`, e.g. DELETE /webhooks/:id)
 * - 4xx/5xx → extract `{ error: string }` envelope and throw `CheckoutError`
 * - Network failure → throw `CheckoutError` with code `"unreachable"`
 */
async function http<T>(path: string, init?: RequestInit & { idempotencyKey?: string; raw?: boolean }): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
  if (init?.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      credentials: "include", // send the httpOnly session cookie cross-origin
    });
  } catch {
    throw new CheckoutError("unreachable", 0, "Network request failed");
  }

  if (!res.ok) {
    // The session is no longer good for anything — drop it so the UI can
    // re-authenticate rather than retrying with a dead token.
    if (res.status === 401) setSessionToken(null);
    const raw = await res.text().catch(() => "");
    const body = parseJsonObject(raw) ?? {};
    const { error, missingFields: rawMissing, message, ...details } = body;
    const apiCode = typeof error === "string" ? error : undefined;
    const missingFields = Array.isArray(rawMissing) ? (rawMissing as string[]) : undefined;
    const reason = typeof details.reason === "string" ? details.reason : undefined;
    const code: ApiErrorCode =
      res.status >= 500
        ? "server_error"
        : res.status === 409 && reason === "insufficient_balance"
          ? "insufficient_balance"
          : res.status === 409 && reason === "missing_trustline"
            ? "missing_trustline"
            : res.status === 409 && reason === "wrong_network"
              ? "wrong_network"
              : res.status === 409 && apiCode === "payment_rejected"
                ? "payment_rejected"
                : res.status === 409
                  ? "conflict"
                  : apiCode === "not_found"
                    ? "not_found"
                    : apiCode === "invalid_body"
                      ? "invalid_body"
                      : apiCode === "kyc_required"
                        ? "kyc_required"
                        : apiCode === "destination_cannot_receive"
                          ? "destination_cannot_receive"
                          : apiCode === "payment_rejected"
                            ? "payment_rejected"
                            : "server_error";
    const detail = typeof message === "string" ? message : (apiCode ?? res.statusText);
    throw new CheckoutError(code, res.status, detail, missingFields, details);
  }

  if (res.status === 204) return undefined as T;
  if (init?.raw) return res.blob() as unknown as Promise<T>;
  return res.json() as Promise<T>;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** One anchor-advertised indicative price (issue 3.5). Never a firm quote. */
export interface IndicativePrice {
  targetCurrency: string;
  price: string;
  deliveryMethods: string[];
}

export interface OfframpPreview {
  indicative: true;
  prices: IndicativePrice[];
  sourceAmount: string;
}

export interface CreateLinkInput {
  title: string;
  amount: string;
  assetCode: "USDC" | "XLM";
  expiresInMinutes?: number;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  linkId: string;
  event: string;
  statusCode: number | null;
  ok: boolean;
  error: string | null;
  createdAt: number;
}

export interface Webhook {
  id: string;
  url: string;
  secretLast4: string;
  previousSecretLast4: string | null;
  previousSecretExpiresAt: number | null;
  deletedAt: number | null;
  createdAt: number;
}

export interface AuthChallenge {
  transaction: string;
  network_passphrase: string;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: number | null;
  createdAt: number;
  revokedAt: number | null;
}

export interface ApiKeyCreated {
  id: string;
  name: string;
  key: string;
  scopes: string[];
  env: "live" | "test";
}

export type UsdcTrustlineStatus =
  | { ok: true }
  | { ok: false; reason: string; message: string; trustlineUri?: string };

export interface HealthResponse {
  ok: boolean;
  network: string;
  sellerWallet: string;
  usdcTrustline: UsdcTrustlineStatus;
}

export const api = {
  createLink: (input: CreateLinkInput, idempotencyKey?: string) =>
    http<LinkWithRequest>("/links", { method: "POST", body: JSON.stringify(input), idempotencyKey }),

  listLinks: () => http<{ links: PaymentLink[] }>("/links"),

  getLink: (id: string) => http<LinkWithRequest>(`/links/${id}`),

  submitPayment: (id: string, signedXdr: string) =>
    http<{ txHash: string }>(`/links/${id}/submit`, {
      method: "POST",
      body: JSON.stringify({ signedXdr }),
    }),

  /** Anchor field descriptors + masked saved payout fields for the cash-out form (issue #32). */
  getOfframpRequirements: (id: string) => http<OfframpRequirements>(`/links/${id}/offramp-requirements`),

  getDetail: (id: string) => http<LinkDetail>(`/links/${id}/detail`),

  getReceipt: (reference: string) => http<PublicReceipt>(`/r/${reference}`),

  /** Indicative SEP-38 prices for a paid link — no firm quote is consumed. */
  getOfframpPreview: (id: string, currency?: string) =>
    http<OfframpPreview>(
      `/links/${id}/offramp-preview${currency ? `?currency=${encodeURIComponent(currency)}` : ""}`,
    ),

  health: () => http<HealthResponse>("/health"),

  quoteCashOut: (id: string, targetCurrency: string) =>
    http<{
      quoteId: string;
      sourceAmount: string;
      targetCurrency: string;
      targetAmount: string; // Gross
      rate: string;
      fee: { amount: string; currency: string; source: string };
      netTargetAmount: string; // Net
    }>(`/links/${id}/cash-out/quote?targetCurrency=${targetCurrency}`),

  cashOut: (
    id: string,
    targetCurrency: string,
    payoutFields: Record<string, string> = {},
    idempotencyKey?: string,
  ) =>
    http<{
      job: { jobId: string; status: string; targetAmount: string; targetCurrency: string };
      interactiveUrl?: string;
    }>(
      `/links/${id}/cash-out`,
      { method: "POST", body: JSON.stringify({ targetCurrency, payoutFields }), idempotencyKey },
    ),

  exportCsv: (from?: string, to?: string): Promise<Blob> => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return http<Blob>(`/links/export/csv${qs ? `?${qs}` : ""}`, {
      raw: true,
      headers: { accept: "text/csv" },
    });
  },
  // Wallet-native login (SEP-10): getAuthChallenge() -> sign with the wallet ->
  // submitAuthChallenge() -> setSessionToken(token) on success.
  getAuthChallenge: (account: string) => http<AuthChallenge>(`/auth?account=${encodeURIComponent(account)}`),

  submitAuthChallenge: (transaction: string) =>
    http<{ token: string; expiresAt: number }>("/auth", { method: "POST", body: JSON.stringify({ transaction }) }).then((res) => {
      setSessionToken(res.token);
      return res;
    }),

  logout: () => http<{ ok: true }>("/auth/logout", { method: "POST" }).finally(() => setSessionToken(null)),
  getKyc: () => http<KycView>("/seller/kyc"),

  submitKyc: (fields: Record<string, string>) =>
    http<KycView>("/seller/kyc", { method: "PUT", body: JSON.stringify(fields) }),

  listWebhooks: () => http<{ webhooks: Webhook[] }>("/webhooks"),

  createWebhook: (url: string) =>
    http<Webhook & { secret: string }>("/webhooks", { method: "POST", body: JSON.stringify({ url }) }),

  deleteWebhook: (id: string) => http<void>(`/webhooks/${id}`, { method: "DELETE" }),

  rotateWebhookSecret: (id: string) =>
    http<Webhook & { secret: string }>(`/webhooks/${id}/rotate-secret`, { method: "POST" }),

  listWebhookDeliveries: (id: string, opts: { limit?: number; cursor?: string | null } = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    const qs = params.toString();
    return http<{ deliveries: WebhookDelivery[]; nextCursor: string | null }>(
      `/webhooks/${id}/deliveries${qs ? `?${qs}` : ""}`,
    );
  },

  // ── API Keys (issue #40) ───────────────────────────────────────────────

  listApiKeys: () =>
    http<{
      keys: ApiKeyInfo[];
      availableScopes: string[];
      defaultScopes: string[];
    }>("/api-keys"),

  createApiKey: (input: { name: string; env?: "live" | "test"; scopes?: string }) =>
    http<ApiKeyCreated>("/api-keys", { method: "POST", body: JSON.stringify(input) }),

  revokeApiKey: (id: string) =>
    http<{ id: string; revokedAt: number }>(`/api-keys/${id}`, { method: "DELETE" }),
};
