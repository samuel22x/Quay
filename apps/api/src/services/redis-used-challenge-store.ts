import { createClient, type RedisClientType } from "redis";
import type { UsedChallengeStore } from "@checkout/core";

/**
 * Shared single-use claim for SEP-10 challenges across instances (issue 6.7).
 * `SET NX` is atomic in Redis, so two instances racing the same already-signed
 * challenge cannot both win: only the first `claim()` call gets "OK" back.
 */
export class RedisUsedChallengeStore implements UsedChallengeStore {
  private client: RedisClientType;
  private connecting: Promise<void>;

  constructor(url: string) {
    this.client = createClient({ url });
    this.client.on("error", (err) => console.error("[sep10-challenge] redis error", err));
    this.connecting = this.client.connect().then(() => undefined);
  }

  async claim(hash: string, expiresAt: number): Promise<boolean> {
    await this.connecting;
    // TTL mirrors the challenge's own timebound so a claim never outlives it.
    // Floored at 1ms: expiresAt is already in the past only if the caller races
    // its own timeout, which PX would otherwise reject with a negative value.
    const ttlMs = Math.max(1, expiresAt * 1000 - Date.now());
    const result = await this.client.set(`sep10-used:${hash}`, "1", { NX: true, PX: ttlMs });
    return result === "OK";
  }
}
