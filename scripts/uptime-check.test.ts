import { describe, expect, it } from "vitest";
import { activeEnvironments, buildEnvironments, buildTargets, checkSyntheticLink, recordResult, renderStatusMd, uptimePct } from "./uptime-check.mjs";

describe("buildEnvironments", () => {
  it("testnet always defaults to the public testnet deploy, unprefixed", () => {
    const [testnet] = buildEnvironments({});
    expect(testnet.id).toBe("testnet");
    expect(testnet.apiUrl).toBe("https://quay-api.onrender.com");
    expect(testnet.webUrl).toBe("https://quay-web.vercel.app");
    expect(testnet.syntheticLink).toBe(true);
    expect(testnet.prefixIds).toBe(false);
  });

  it("testnet honors the original UPTIME_API_URL / UPTIME_WEB_URL var names", () => {
    const [testnet] = buildEnvironments({
      UPTIME_API_URL: "https://custom-api.example",
      UPTIME_WEB_URL: "https://custom-web.example",
    });
    expect(testnet.apiUrl).toBe("https://custom-api.example");
    expect(testnet.webUrl).toBe("https://custom-web.example");
  });

  it("mainnet has no URL default of any kind — unset means unconfigured, not guessed", () => {
    const [, mainnet] = buildEnvironments({});
    expect(mainnet.id).toBe("mainnet");
    expect(mainnet.apiUrl).toBeNull();
    expect(mainnet.webUrl).toBeNull();
  });

  it("mainnet picks up its URLs once configured, and prefixes its target ids", () => {
    const [, mainnet] = buildEnvironments({
      UPTIME_MAINNET_API_URL: "https://quay-api-mainnet.onrender.com",
      UPTIME_MAINNET_WEB_URL: "https://quay-web-mainnet.example",
    });
    expect(mainnet.apiUrl).toBe("https://quay-api-mainnet.onrender.com");
    expect(mainnet.webUrl).toBe("https://quay-web-mainnet.example");
    expect(mainnet.prefixIds).toBe(true);
  });

  it("mainnet's synthetic-link check stays off unless explicitly opted into", () => {
    const [, withoutOptIn] = buildEnvironments({ UPTIME_MAINNET_API_URL: "https://mainnet.example" });
    expect(withoutOptIn.syntheticLink).toBe(false);

    const [, withOptIn] = buildEnvironments({
      UPTIME_MAINNET_API_URL: "https://mainnet.example",
      UPTIME_MAINNET_SYNTHETIC_CHECK: "1",
    });
    expect(withOptIn.syntheticLink).toBe(true);
  });
});

describe("activeEnvironments", () => {
  it("drops any environment with no API URL configured", () => {
    const environments = buildEnvironments({});
    expect(activeEnvironments(environments).map((e) => e.id)).toEqual(["testnet"]);
  });

  it("includes mainnet once its API URL is set", () => {
    const environments = buildEnvironments({ UPTIME_MAINNET_API_URL: "https://mainnet.example" });
    expect(activeEnvironments(environments).map((e) => e.id)).toEqual(["testnet", "mainnet"]);
  });
});

describe("buildTargets", () => {
  it("testnet keeps its original, unprefixed target ids (back-compat with existing history/badges)", () => {
    const environments = buildEnvironments({});
    const ids = buildTargets(environments).map((t) => t.id);
    expect(ids).toEqual(["api", "web", "synthetic"]);
  });

  it("mainnet's target ids are prefixed and never collide with testnet's", () => {
    const environments = buildEnvironments({
      UPTIME_MAINNET_API_URL: "https://mainnet.example",
      UPTIME_MAINNET_WEB_URL: "https://mainnet-web.example",
      UPTIME_MAINNET_SYNTHETIC_CHECK: "1",
    });
    const ids = buildTargets(environments).map((t) => t.id);
    expect(ids).toEqual(["api", "web", "synthetic", "mainnet-api", "mainnet-web", "mainnet-synthetic"]);
  });

  it("omits the web target for an environment with no web URL, and the synthetic target when disabled", () => {
    const environments = buildEnvironments({ UPTIME_MAINNET_API_URL: "https://mainnet.example" });
    const mainnetIds = buildTargets(environments)
      .filter((t) => t.env.id === "mainnet")
      .map((t) => t.id);
    expect(mainnetIds).toEqual(["mainnet-api"]);
  });

  it("labels every target with its environment, so an issue title can never be ambiguous about which one", () => {
    const environments = buildEnvironments({ UPTIME_MAINNET_API_URL: "https://mainnet.example" });
    const targets = buildTargets(environments);
    expect(targets.find((t) => t.id === "api")?.label).toBe("Testnet — API");
    expect(targets.find((t) => t.id === "mainnet-api")?.label).toBe("Mainnet — API");
  });
});

describe("recordResult / uptimePct", () => {
  it("tracks consecutive failures per target id independently", () => {
    const state = { targets: {} };
    recordResult(state, "testnet-api", false, "boom");
    const { justFailed } = recordResult(state, "testnet-api", false, "boom");
    expect(justFailed).toBe(true);
    // A different id (e.g. mainnet's own "api") must not share this counter.
    expect(state.targets["mainnet-api"]).toBeUndefined();
  });

  it("uptimePct is 100 with no data, and reflects a mixed today", () => {
    expect(uptimePct([], null)).toBe(100);
    expect(uptimePct([], { up: 3, down: 1 })).toBe(75);
  });
});

describe("renderStatusMd", () => {
  it("only reports environments that have actually been checked", () => {
    const environments = buildEnvironments({ UPTIME_MAINNET_API_URL: "https://mainnet.example" });
    const state = { targets: {} };
    recordResult(state, "api", true, null);

    const md = renderStatusMd(state, environments);
    expect(md).toContain("## Testnet");
    expect(md).not.toContain("## Mainnet");
  });

  it("gives each environment its own section, with per-kind subsections underneath", () => {
    const environments = buildEnvironments({ UPTIME_MAINNET_API_URL: "https://mainnet.example" });
    const state = { targets: {} };
    recordResult(state, "api", true, null);
    recordResult(state, "mainnet-api", false, "connection refused");

    const md = renderStatusMd(state, environments);
    const testnetIdx = md.indexOf("## Testnet");
    const mainnetIdx = md.indexOf("## Mainnet");
    expect(testnetIdx).toBeGreaterThanOrEqual(0);
    expect(mainnetIdx).toBeGreaterThan(testnetIdx);
    expect(md.indexOf("### API", testnetIdx)).toBeLessThan(mainnetIdx);
    expect(md).toContain("🔴 down");
    expect(md).toContain("connection refused");
  });
});

// ---------------------------------------------------------------------------
//  Synthetic create-link check (issue 8.9)
//
//  POST /links has required a seller session or a scoped API key since 6.x, so
//  this check 401'd on every run — a permanent false negative sitting beside
//  two real checks. These exercise the function the CLI actually calls, with
//  fetch injected, rather than a parallel copy that could drift from it.
// ---------------------------------------------------------------------------

// Placeholder credentials. Deliberately not shaped like a real key (which is
// `ak_live_` + 32 base62 chars) so a secret scanner has nothing to match on.
const FAKE_KEY = "not-a-real-key";
const FAKE_REVOKED_KEY = "not-a-real-revoked-key";
const FAKE_MAINNET_KEY = "not-a-real-mainnet-key";

function jsonResponse(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body ?? {},
  } as unknown as Response;
}

describe("checkSyntheticLink", () => {
  const API = "https://api.example.com";

  it("sends the key as a bearer token and cancels the link it created", async () => {
    const calls: Array<[string, any]> = [];
    const fakeFetch = async (url: string, opts: any) => {
      calls.push([url, opts]);
      return calls.length === 1
        ? jsonResponse(201, { link: { id: "lnk_uptime_1" } })
        : jsonResponse(200, { link: { id: "lnk_uptime_1", status: "cancelled" } });
    };

    await checkSyntheticLink(API, FAKE_KEY, fakeFetch);

    expect(calls).toHaveLength(2);
    const [createUrl, createOpts] = calls[0]!;
    expect(createUrl).toBe(`${API}/links`);
    expect(createOpts.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(JSON.parse(createOpts.body)).toEqual({
      title: "uptime-check",
      amount: "0.0000001",
      assetCode: "XLM",
    });

    // Cleanup: the throwaway row must not accumulate.
    const [cancelUrl, cancelOpts] = calls[1]!;
    expect(cancelUrl).toBe(`${API}/links/lnk_uptime_1/cancel`);
    expect(cancelOpts.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it("sends no Authorization header when no key is configured", async () => {
    const calls: Array<[string, any]> = [];
    const fakeFetch = async (url: string, opts: any) => {
      calls.push([url, opts]);
      return jsonResponse(401);
    };

    await expect(checkSyntheticLink(API, null, fakeFetch)).rejects.toThrow(/no API key is configured/);
    expect(calls[0]![1].headers.authorization).toBeUndefined();
  });

  it("names the missing secret on a 401, instead of reporting a bare HTTP 401", async () => {
    const fakeFetch = async () => jsonResponse(401);
    await expect(checkSyntheticLink(API, null, fakeFetch)).rejects.toThrow(/UPTIME_API_KEY/);
  });

  it("still reports a genuine 401 as a failure when a key IS configured", async () => {
    // A configured-but-rejected key is a real problem — a revoked or
    // wrong-scope key must not be reported as a missing-secret misconfiguration.
    const fakeFetch = async () => jsonResponse(401);
    await expect(checkSyntheticLink(API, FAKE_REVOKED_KEY, fakeFetch)).rejects.toThrow(/expected 201/);
  });

  it("fails when the write path is genuinely broken", async () => {
    const fakeFetch = async () => jsonResponse(500);
    await expect(checkSyntheticLink(API, FAKE_KEY, fakeFetch)).rejects.toThrow(/HTTP 500 \(expected 201\)/);
  });

  it("does not fail the probe when only cleanup fails", async () => {
    // The write path — the thing being measured — already succeeded. Reporting
    // an outage because cancellation 500'd would be a false positive.
    let n = 0;
    const fakeFetch = async () => {
      n += 1;
      return n === 1 ? jsonResponse(201, { link: { id: "lnk_1" } }) : jsonResponse(500);
    };
    await expect(checkSyntheticLink(API, FAKE_KEY, fakeFetch)).resolves.toBeUndefined();
  });

  it("tolerates a 201 body with no link id", async () => {
    let n = 0;
    const fakeFetch = async () => {
      n += 1;
      return n === 1 ? jsonResponse(201, {}) : jsonResponse(200);
    };
    await expect(checkSyntheticLink(API, FAKE_KEY, fakeFetch)).resolves.toBeUndefined();
    expect(n).toBe(1); // no cancel attempted
  });
});

describe("uptime API keys", () => {
  it("reads a per-environment key, never sharing testnet's with mainnet", () => {
    const [testnet, mainnet] = buildEnvironments({
      UPTIME_API_KEY: FAKE_KEY,
      UPTIME_MAINNET_API_KEY: FAKE_MAINNET_KEY,
    });
    expect(testnet.apiKey).toBe(FAKE_KEY);
    expect(mainnet.apiKey).toBe(FAKE_MAINNET_KEY);

    const [onlyTestnetKey] = buildEnvironments({ UPTIME_API_KEY: FAKE_KEY });
    expect(onlyTestnetKey.apiKey).toBe(FAKE_KEY);
    expect(buildEnvironments({ UPTIME_API_KEY: FAKE_KEY })[1]!.apiKey).toBeFalsy();
  });
});

describe("renderStatusMd staleness", () => {
  it("stamps when it was last regenerated, so a stale page reads as stale", () => {
    const md = renderStatusMd({ targets: {} }, buildEnvironments({}));
    expect(md).toMatch(/> \*\*Last regenerated:\*\* \d{4}-\d{2}-\d{2}T[\d:.]+Z/);
  });
});
