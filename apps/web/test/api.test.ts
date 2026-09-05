import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { api, apiBase, setSessionToken } from "../lib/api";

/**
 * Regression for issue 5.8: `exportCsv` used to call `fetch()` directly, so it
 * carried neither the bearer token nor `credentials: "include"`. On the
 * split-origin topology `docs/MAINNET.md` prescribes, every click 401'd.
 */
describe("api.exportCsv", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    setSessionToken(null);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    setSessionToken(null);
    vi.restoreAllMocks();
  });

  function stubFetch(): ReturnType<typeof vi.fn> {
    const csv = new Blob(["reference,amount\n"], { type: "text/csv" });
    const fetchMock = vi.fn(async () => new Response(csv, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it("sends the bearer token and credentials, and resolves to a Blob", async () => {
    const fetchMock = stubFetch();
    setSessionToken("tok-123");

    const blob = await api.exportCsv();

    expect(blob).toBeInstanceOf(Blob);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${apiBase()}/links/export/csv`);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
    expect((init.headers as Record<string, string>).accept).toBe("text/csv");
    expect(init.credentials).toBe("include");
  });

  it("still sends credentials when there is no in-memory token (cookie-only session)", async () => {
    const fetchMock = stubFetch();

    await api.exportCsv();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(init.credentials).toBe("include");
  });

  it("passes the from/to range through as query params", async () => {
    const fetchMock = stubFetch();

    await api.exportCsv("2026-01-01", "2026-02-01");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${apiBase()}/links/export/csv?from=2026-01-01&to=2026-02-01`);
  });

  it("surfaces a non-2xx export as a CheckoutError instead of a Blob", async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"not_found"}', { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(api.exportCsv()).rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});
