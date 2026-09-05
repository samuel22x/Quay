import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * Regression for issue 5.9 / BUG-1.4 (2026-07-14).
 *
 * A Vercel build ran with NEXT_PUBLIC_API_URL unset, so the `http://localhost:8787`
 * local-dev fallback was baked into the client bundle and every visitor's browser
 * silently tried to reach localhost on their own machine. The fix that shipped at
 * the time was a deploy-checklist reminder, not code — so nothing stopped it from
 * recurring. These pin the four branches of `BROWSER_BASE`.
 *
 * `BROWSER_BASE` is resolved at module load, so each case re-imports the module
 * under a fresh environment rather than calling a function.
 */
const DEV_FALLBACK = "http://localhost:8787";

async function loadApiBase(): Promise<string> {
  vi.resetModules();
  const mod = await import("../lib/api");
  return mod.apiBase();
}

function withBrowser(present: boolean): void {
  if (present) {
    (globalThis as { window?: unknown }).window = globalThis;
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
}

describe("BROWSER_BASE — a production build must not ship the localhost fallback", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    withBrowser(false);
    vi.resetModules();
  });

  it("uses NEXT_PUBLIC_API_URL when it is set, in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.com");
    withBrowser(true);

    await expect(loadApiBase()).resolves.toBe("https://api.example.com");
  });

  it("keeps the localhost fallback outside production — local dev is unaffected", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    withBrowser(true);

    await expect(loadApiBase()).resolves.toBe(DEV_FALLBACK);
  });

  it("throws at module load in a production browser bundle with the variable unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    withBrowser(true);

    await expect(loadApiBase()).rejects.toThrow(/NEXT_PUBLIC_API_URL is not set/);
  });

  it("names the variable and says to rebuild, not just redeploy", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    withBrowser(true);

    await expect(loadApiBase()).rejects.toThrow(/REBUILD/);
  });

  // The server bundle reaches the API via API_URL and never needs the
  // NEXT_PUBLIC_ one, so it must not be punished for a client-only variable.
  // Throwing here would take down prerendering during `next build`.
  it("does not throw in the production server bundle — API_URL is that path's variable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    vi.stubEnv("API_URL", "https://api.example.com");
    withBrowser(false);

    await expect(loadApiBase()).resolves.toBe("https://api.example.com");
  });
});

// ---------------------------------------------------------------------------
//  SEP-24 interactive cash-out (issue 1.1)
//
//  `interactiveUrl` is third-party data: the anchor supplies it, our API
//  forwards it, and the dashboard hands it to `window.open`. These pin the
//  shape the client relies on — the guard against a non-https URL lives in
//  CashOutModal and is asserted there by construction, but the response
//  contract itself is what a SEP-24 adapter will code against.
// ---------------------------------------------------------------------------

describe("api.cashOut — interactive initiation", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function stub(body: unknown) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  const job = {
    jobId: "ofr_1",
    status: "pending",
    targetAmount: "17325.00",
    targetCurrency: "NGN",
  };

  it("passes interactiveUrl through when the anchor needs a browser", async () => {
    stub({ job, interactiveUrl: "https://anchor.example.com/sep24?id=ofr_1" });
    const { api } = await import("../lib/api");

    const res = await api.cashOut("lnk_1", "NGN", {});
    expect(res.interactiveUrl).toBe("https://anchor.example.com/sep24?id=ofr_1");
    expect(res.job.jobId).toBe("ofr_1");
  });

  // Every adapter shipped today is field-driven, so this is the common path:
  // the field must be absent, not null or empty string, so `if (interactiveUrl)`
  // in the modal stays correct.
  it("leaves interactiveUrl undefined for a field-driven anchor", async () => {
    stub({ job });
    const { api } = await import("../lib/api");

    const res = await api.cashOut("lnk_1", "NGN", {});
    expect(res.interactiveUrl).toBeUndefined();
    expect(res.job.jobId).toBe("ofr_1");
  });
});
