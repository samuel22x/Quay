import { describe, it, expect, beforeEach } from "vitest";

process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = "1".repeat(64);

const { createDb, bootstrap } = await import("../src/db/client");
const { DrizzleWebhookRepository } = await import("../src/repos/index");
const { decryptSecret } = await import("../src/services/secret-crypto");

async function freshRepo() {
  const { db, client } = createDb(":memory:");
  await bootstrap(client);
  return new DrizzleWebhookRepository(db);
}

const SELLER = "slr_test1";
const OTHER_SELLER = "slr_test2";

describe("DrizzleWebhookRepository", () => {
  describe("create / listBySeller", () => {
    it("creates a webhook and never persists the plaintext secret", async () => {
      const repo = await freshRepo();
      const hook = await repo.create({ sellerId: SELLER, url: "https://example.com/hook", secret: "topsecret123456" }); // gitleaks:allow — fixture, not a real credential

      expect(hook.secretEncrypted).not.toContain("topsecret");
      expect(hook.secretLast4).toBe("3456");
      expect(decryptSecret(hook.secretEncrypted)).toBe("topsecret123456");
    });

    it("lists only the requesting seller's webhooks", async () => {
      const repo = await freshRepo();
      await repo.create({ sellerId: SELLER, url: "https://a.example.com", secret: "secret-a-000000" });
      await repo.create({ sellerId: OTHER_SELLER, url: "https://b.example.com", secret: "secret-b-000000" });

      const hooks = await repo.listBySeller(SELLER);
      expect(hooks).toHaveLength(1);
      expect(hooks[0]?.url).toBe("https://a.example.com");
    });
  });

  describe("getById", () => {
    it("returns null for a webhook owned by a different seller (no cross-tenant access)", async () => {
      const repo = await freshRepo();
      const hook = await repo.create({ sellerId: SELLER, url: "https://a.example.com", secret: "secret-a-000000" });

      expect(await repo.getById(hook.id, OTHER_SELLER)).toBeNull();
      expect(await repo.getById(hook.id, SELLER)).not.toBeNull();
    });

    it("returns null for a deleted webhook unless includeDeleted is set", async () => {
      const repo = await freshRepo();
      const hook = await repo.create({ sellerId: SELLER, url: "https://a.example.com", secret: "secret-a-000000" });
      await repo.softDelete(hook.id, SELLER);

      expect(await repo.getById(hook.id, SELLER)).toBeNull();
      expect(await repo.getById(hook.id, SELLER, { includeDeleted: true })).not.toBeNull();
    });
  });

  describe("rotateSecret", () => {
    it("returns null when the webhook doesn't exist or isn't owned by this seller", async () => {
      const repo = await freshRepo();
      expect(await repo.rotateSecret("whk_nope", SELLER, "new-secret-000", 1000)).toBeNull();
    });

    it("moves the current secret to 'previous' with an expiry, and issues a new current secret", async () => {
      const repo = await freshRepo();
      const hook = await repo.create({ sellerId: SELLER, url: "https://a.example.com", secret: "old-secret-0000" });

      const before = Date.now();
      const rotated = await repo.rotateSecret(hook.id, SELLER, "new-secret-0000", 24 * 60 * 60 * 1000);

      expect(rotated).not.toBeNull();
      expect(decryptSecret(rotated!.secretEncrypted)).toBe("new-secret-0000");
      expect(rotated!.secretLast4).toBe("0000".slice(0, 0) + "0000"); // trivially "0000"
      expect(decryptSecret(rotated!.previousSecretEncrypted!)).toBe("old-secret-0000");
      expect(rotated!.previousSecretExpiresAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);

      // The change is actually persisted, not just returned in-memory.
      const reloaded = await repo.getById(hook.id, SELLER);
      expect(decryptSecret(reloaded!.previousSecretEncrypted!)).toBe("old-secret-0000");
    });

    it("a second rotation replaces the previous secret (only one overlap generation is kept)", async () => {
      const repo = await freshRepo();
      const hook = await repo.create({ sellerId: SELLER, url: "https://a.example.com", secret: "secret-v1-00000" });
      await repo.rotateSecret(hook.id, SELLER, "secret-v2-00000", 1000);
      const twice = await repo.rotateSecret(hook.id, SELLER, "secret-v3-00000", 1000);

      expect(decryptSecret(twice!.secretEncrypted)).toBe("secret-v3-00000");
      expect(decryptSecret(twice!.previousSecretEncrypted!)).toBe("secret-v2-00000");
    });
  });

  describe("softDelete", () => {
    it("returns false for a nonexistent or already-deleted webhook", async () => {
      const repo = await freshRepo();
      expect(await repo.softDelete("whk_nope", SELLER)).toBe(false);

      const hook = await repo.create({ sellerId: SELLER, url: "https://a.example.com", secret: "secret-a-000000" });
      expect(await repo.softDelete(hook.id, SELLER)).toBe(true);
      expect(await repo.softDelete(hook.id, SELLER)).toBe(false); // already deleted
    });

    it("excludes deleted webhooks from listBySeller", async () => {
      const repo = await freshRepo();
      const hook = await repo.create({ sellerId: SELLER, url: "https://a.example.com", secret: "secret-a-000000" });
      await repo.softDelete(hook.id, SELLER);

      expect(await repo.listBySeller(SELLER)).toHaveLength(0);
    });
  });

  describe("recordDelivery / listDeliveries", () => {
    it("returns deliveries newest-first and paginates via cursor", async () => {
      const repo = await freshRepo();
      const hook = await repo.create({ sellerId: SELLER, url: "https://a.example.com", secret: "secret-a-000000" });

      for (let i = 0; i < 5; i++) {
        await repo.recordDelivery({ webhookId: hook.id, linkId: `lnk_${i}`, event: "link.paid", attempt: 1, queueEntryId: null, statusCode: 200, ok: true, error: null });
        await new Promise((r) => setTimeout(r, 2)); // ensure distinct createdAt ordering
      }

      const page1 = await repo.listDeliveries(hook.id, SELLER, { limit: 2 });
      expect(page1.deliveries).toHaveLength(2);
      expect(page1.deliveries[0]?.linkId).toBe("lnk_4"); // newest first
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await repo.listDeliveries(hook.id, SELLER, { limit: 2, cursor: page1.nextCursor });
      expect(page2.deliveries.map((d) => d.linkId)).toEqual(["lnk_2", "lnk_1"]);

      const page3 = await repo.listDeliveries(hook.id, SELLER, { limit: 2, cursor: page2.nextCursor });
      expect(page3.deliveries.map((d) => d.linkId)).toEqual(["lnk_0"]);
      expect(page3.nextCursor).toBeNull();
    });

    it("remains visible for a deleted webhook", async () => {
      const repo = await freshRepo();
      const hook = await repo.create({ sellerId: SELLER, url: "https://a.example.com", secret: "secret-a-000000" });
      await repo.recordDelivery({ webhookId: hook.id, linkId: "lnk_1", event: "link.paid", attempt: 1, queueEntryId: null, statusCode: 200, ok: true, error: null });
      await repo.softDelete(hook.id, SELLER);

      const { deliveries } = await repo.listDeliveries(hook.id, SELLER, { limit: 10 });
      expect(deliveries).toHaveLength(1);
    });

    it("returns empty results for a webhook not owned by this seller", async () => {
      const repo = await freshRepo();
      const hook = await repo.create({ sellerId: SELLER, url: "https://a.example.com", secret: "secret-a-000000" });
      await repo.recordDelivery({ webhookId: hook.id, linkId: "lnk_1", event: "link.paid", attempt: 1, queueEntryId: null, statusCode: 200, ok: true, error: null });

      const { deliveries } = await repo.listDeliveries(hook.id, OTHER_SELLER, { limit: 10 });
      expect(deliveries).toHaveLength(0);
    });
  });
});
