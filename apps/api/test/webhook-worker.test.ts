import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

// The worker's deliveries point at loopback-ish stub URLs, which the real SSRF
// guard correctly rejects. ssrf-guard.test.ts covers the guard itself.
const PERMISSIVE_GUARD = async () => ({ ok: true }) as const;

process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = "2".repeat(64);

const { WebhookWorker } = await import("../src/worker/webhook-worker");
const { WebhookSender } = await import("../src/services/webhook-sender");
const { FakeWebhookRepository } = await import("./fakes");

const SECRET = "current-secret-value";

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

async function seed() {
  const repo = new FakeWebhookRepository();
  const hook = await repo.create({ sellerId: "slr_1", url: "https://receiver.example.com/hook", secret: SECRET });
  const sender = new WebhookSender(repo, { maxAttempts: 1, guard: PERMISSIVE_GUARD });
  return { repo, hook, sender };
}

/** Build a worker with retry delays short enough to step through in real time. */
function makeWorker(repo: any, sender: any, opts: Record<string, unknown> = {}) {
  return new WebhookWorker(repo, sender, { maxAttempts: 3, baseDelayMs: 1, ...opts });
}

describe("WebhookWorker", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("delivers a queued event and marks the row delivered", async () => {
    const { repo, hook, sender } = await seed();
    await sender.enqueue([hook], "lnk_1", { event: "link.paid", data: { foo: "bar" } });

    await makeWorker(repo, sender).runOnce();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(repo.queue[0]!.status).toBe("delivered");
    expect(repo.queue[0]!.attempts).toBe(1);

    // Every attempt is recorded, not just the last.
    expect(repo.deliveries).toHaveLength(1);
    expect(repo.deliveries[0]).toMatchObject({ ok: true, attempt: 1, statusCode: 200, queueEntryId: repo.queue[0]!.id });
  });

  it("preserves the signing scheme and headers receivers already verify", async () => {
    const { repo, hook, sender } = await seed();
    await sender.enqueue([hook], "lnk_1", { event: "link.paid", data: { foo: "bar" } });

    await makeWorker(repo, sender).runOnce();

    const [url, init] = fetchMock.mock.calls[0]!;
    const body = init.body as string;
    expect(url).toBe(hook.url);
    expect(init.headers["x-checkout-event"]).toBe("link.paid");
    expect(init.headers["x-checkout-signature"]).toBe(`sha256=${sign(SECRET, body)}`);
    expect(init.redirect).toBe("manual");
    // sentAt lives inside the signed body — the receiver's replay protection.
    expect(JSON.parse(body)).toMatchObject({ event: "link.paid", id: "lnk_1" });
    expect(typeof JSON.parse(body).sentAt).toBe("string");
  });

  it("re-sends the byte-identical payload on a retry, so the signature never moves", async () => {
    const { repo, hook, sender } = await seed();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await sender.enqueue([hook], "lnk_1", { event: "link.paid", data: {} });

    const worker = makeWorker(repo, sender);
    await worker.runOnce();
    await waitUntilDue(repo);
    await worker.runOnce();

    const first = fetchMock.mock.calls[0]![1].body;
    const second = fetchMock.mock.calls[1]![1].body;
    expect(second).toBe(first);
    expect(fetchMock.mock.calls[1]![1].headers["x-checkout-signature"]).toBe(
      fetchMock.mock.calls[0]![1].headers["x-checkout-signature"],
    );
  });

  // This is the issue's acceptance criterion: retry state lives in the table,
  // so a process that dies mid-backoff still delivers after a restart.
  it("survives a worker dying mid-backoff — a fresh worker delivers the event", async () => {
    const { repo, hook, sender } = await seed();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await sender.enqueue([hook], "lnk_1", { event: "link.paid", data: {} });

    // First process: one failed attempt, then it is killed mid-backoff.
    const dying = makeWorker(repo, sender);
    dying.start();
    await vi.waitFor(() => expect(repo.queue[0]!.attempts).toBe(1));
    dying.stop();
    expect(repo.queue[0]!.status).toBe("pending");

    // Restart: nothing was carried over in memory, only the row.
    await waitUntilDue(repo);
    const restarted = makeWorker(repo, sender);
    await restarted.runOnce();

    expect(repo.queue[0]!.status).toBe("delivered");
    expect(repo.deliveries.map((d: any) => d.ok)).toEqual([false, true]);
    expect(repo.deliveries.map((d: any) => d.attempt)).toEqual([1, 2]);
  });

  it("releases a claim left behind by a worker that died mid-delivery", async () => {
    const { repo, hook, sender } = await seed();
    await sender.enqueue([hook], "lnk_1", { event: "link.paid", data: {} });

    // Simulate the crash: the row is claimed and the claimant never came back.
    repo.queue[0]!.status = "claimed";
    repo.queue[0]!.updatedAt = Date.now() - 10 * 60_000;

    await makeWorker(repo, sender, { claimTimeoutMs: 60_000 }).runOnce();

    expect(repo.queue[0]!.status).toBe("delivered");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not hand the same entry to two concurrent workers", async () => {
    const { repo, hook, sender } = await seed();
    await sender.enqueue([hook], "lnk_1", { event: "link.paid", data: {} });

    const a = makeWorker(repo, sender);
    const b = makeWorker(repo, sender);
    await Promise.all([a.runOnce(), b.runOnce()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(repo.deliveries).toHaveLength(1);
  });

  it("dead-letters after maxAttempts and records every attempt", async () => {
    const { repo, hook, sender } = await seed();
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    await sender.enqueue([hook], "lnk_1", { event: "link.paid", data: {} });

    const worker = makeWorker(repo, sender, { maxAttempts: 3 });
    for (let i = 0; i < 3; i++) {
      await waitUntilDue(repo);
      await worker.runOnce();
    }

    expect(repo.queue[0]!.status).toBe("dead");
    expect(repo.queue[0]!.attempts).toBe(3);
    expect(repo.queue[0]!.lastStatusCode).toBe(500);
    expect(repo.deliveries).toHaveLength(3);
    expect(repo.deliveries.every((d: any) => d.ok === false)).toBe(true);
  });

  it("dead-letters a 4xx immediately instead of burning retries", async () => {
    const { repo, hook, sender } = await seed();
    fetchMock.mockResolvedValue(new Response(null, { status: 400 }));
    await sender.enqueue([hook], "lnk_1", { event: "link.paid", data: {} });

    await makeWorker(repo, sender).runOnce();

    expect(repo.queue[0]!.status).toBe("dead");
    expect(repo.queue[0]!.attempts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 rather than dead-lettering it", async () => {
    const { repo, hook, sender } = await seed();
    fetchMock.mockResolvedValue(new Response(null, { status: 429 }));
    await sender.enqueue([hook], "lnk_1", { event: "link.paid", data: {} });

    await makeWorker(repo, sender).runOnce();

    expect(repo.queue[0]!.status).toBe("pending");
    expect(repo.queue[0]!.attempts).toBe(1);
  });

  it("dead-letters when the SSRF guard rejects the URL at delivery time", async () => {
    const repo = new FakeWebhookRepository();
    const hook = await repo.create({ sellerId: "slr_1", url: "https://rebound.example.com/hook", secret: SECRET });
    const sender = new WebhookSender(repo, {
      maxAttempts: 1,
      guard: async () => ({ ok: false, reason: "resolves to a private address" }) as const,
    });
    await sender.enqueue([hook], "lnk_1", { event: "link.paid", data: {} });

    await makeWorker(repo, sender).runOnce();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(repo.queue[0]!.status).toBe("dead");
    expect(repo.queue[0]!.lastError).toContain("SSRF guard rejected URL at delivery");
  });

  it("dead-letters an entry whose webhook has since been deleted", async () => {
    const { repo, hook, sender } = await seed();
    await sender.enqueue([hook], "lnk_1", { event: "link.paid", data: {} });
    // Hard-delete: the worker's lookup finds nothing at all.
    (repo as any).hooks.length = 0;

    await makeWorker(repo, sender).runOnce();

    expect(repo.queue[0]!.status).toBe("dead");
    expect(repo.queue[0]!.lastError).toBe("webhook not found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts undelivered rows for the queue-depth gauge", async () => {
    const { repo, hook, sender } = await seed();
    await sender.enqueue([hook, hook], "lnk_1", { event: "link.paid", data: {} });
    expect(await repo.countPending()).toBe(2);

    await makeWorker(repo, sender).runOnce();
    expect(await repo.countPending()).toBe(0);
  });
});

/** Wait until the head row's backoff has elapsed (baseDelayMs is 1ms in tests). */
async function waitUntilDue(repo: any): Promise<void> {
  const due = repo.queue[0]?.nextAttemptAt ?? 0;
  const wait = due - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait + 1));
}
