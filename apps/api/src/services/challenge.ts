import { Keypair, StrKey, WebAuth } from "@stellar/stellar-sdk";
import type { UsedChallengeStore } from "@checkout/core";

export class AuthError extends Error {}

/**
 * Default single-process implementation of {@link UsedChallengeStore}. Only
 * enforces "used once per process" — see the port's own doc comment for why
 * that's not enough once more than one instance is running. Select
 * `RedisUsedChallengeStore` (services/redis-used-challenge-store.ts) instead
 * when `REDIS_URL` is set, the same way the rate limiter does.
 */
export class MemoryUsedChallengeStore implements UsedChallengeStore {
  // tx hash -> epoch-seconds it stops mattering (== the challenge's own maxTime).
  private readonly used = new Map<string, number>();

  async claim(hash: string, expiresAt: number): Promise<boolean> {
    this.sweepExpired();
    if (this.used.has(hash)) return false;
    // Synchronous Map.set — no await between the `has` check above and this,
    // so no other call can interleave. Safe within a single process; a
    // multi-process deployment needs RedisUsedChallengeStore instead.
    this.used.set(hash, expiresAt);
    return true;
  }

  private sweepExpired(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [hash, exp] of this.used) {
      if (exp < now) this.used.delete(hash);
    }
  }
}

/** An account's ed25519 signers and its medium threshold, as reported by Horizon.
 *  `null` means the account does not exist on-chain yet (unfunded); SEP-10 then
 *  falls back to treating the account id itself as the sole signer. */
export type AccountSigners = { signers: Record<string, number>; medThreshold: number } | null;

export type FetchAccountSigners = (accountId: string) => Promise<AccountSigners>;

export interface ChallengeOptions {
  serverKeypair: Keypair;
  homeDomain: string;
  webAuthDomain: string;
  networkPassphrase: string;
  fetchAccountSigners: FetchAccountSigners;
  /** Challenge validity window in seconds. Default 900 (15 minutes). */
  timeoutSeconds?: number;
  /** Defaults to a per-process `MemoryUsedChallengeStore`. Pass a
   *  `RedisUsedChallengeStore` to share the single-use claim across instances. */
  usedChallengeStore?: UsedChallengeStore;
}

/**
 * Server-side SEP-10 web authentication: issues challenge transactions and
 * verifies signed ones back. https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md
 *
 * Signature + timebounds + domain checks are delegated to @stellar/stellar-sdk's
 * `WebAuth` (the same primitives the JS SDK uses client-side in
 * packages/offramp/src/sep10.ts); this class adds the single-use nonce store and
 * the M-of-N threshold lookup via Horizon.
 */
export class ChallengeService {
  private readonly usedChallengeStore: UsedChallengeStore;

  constructor(private readonly opts: ChallengeOptions) {
    this.usedChallengeStore = opts.usedChallengeStore ?? new MemoryUsedChallengeStore();
  }

  build(account: string): { transaction: string; network_passphrase: string } {
    if (!StrKey.isValidEd25519PublicKey(account)) {
      throw new AuthError("account must be a valid Stellar G-address");
    }
    const transaction = WebAuth.buildChallengeTx(
      this.opts.serverKeypair,
      account,
      this.opts.homeDomain,
      this.opts.timeoutSeconds ?? 900,
      this.opts.networkPassphrase,
      this.opts.webAuthDomain,
    );
    return { transaction, network_passphrase: this.opts.networkPassphrase };
  }

  /** Verifies a client-signed challenge and returns the authenticated account id. */
  async verify(transactionXdr: string): Promise<string> {
    let clientAccountID: string;
    let hash: string;
    try {
      const read = WebAuth.readChallengeTx(
        transactionXdr,
        this.opts.serverKeypair.publicKey(),
        this.opts.networkPassphrase,
        [this.opts.homeDomain],
        this.opts.webAuthDomain,
      );
      clientAccountID = read.clientAccountID;
      hash = read.tx.hash().toString("hex");
    } catch (err) {
      throw new AuthError(`invalid challenge transaction: ${errMessage(err)}`);
    }

    const account = await this.opts.fetchAccountSigners(clientAccountID);
    try {
      if (account) {
        WebAuth.verifyChallengeTxThreshold(
          transactionXdr,
          this.opts.serverKeypair.publicKey(),
          this.opts.networkPassphrase,
          account.medThreshold,
          // `horizonSignerFetcher` only collects ed25519 signers, so the type is known.
          Object.entries(account.signers).map(([key, weight]) => ({
            key,
            weight,
            type: "ed25519_public_key",
          })),
          [this.opts.homeDomain],
          this.opts.webAuthDomain,
        );
      } else {
        // Unfunded account: SEP-10 falls back to the account id as its own sole signer.
        WebAuth.verifyChallengeTxSigners(
          transactionXdr,
          this.opts.serverKeypair.publicKey(),
          this.opts.networkPassphrase,
          [clientAccountID],
          [this.opts.homeDomain],
          this.opts.webAuthDomain,
        );
      }
    } catch (err) {
      throw new AuthError(`signature verification failed: ${errMessage(err)}`);
    }

    // Single-use: once verified, this exact challenge can never be redeemed again.
    // Kept only until its own timebounds lapse, since it would be rejected anyway.
    // This is the atomic claim, not a check-then-set — with RedisUsedChallengeStore
    // it's a `SET NX`, so two instances racing the same signed challenge cannot
    // both win even though both independently pass signature verification above.
    const expiresAt = Math.floor(Date.now() / 1000) + (this.opts.timeoutSeconds ?? 900);
    const claimed = await this.usedChallengeStore.claim(hash, expiresAt);
    if (!claimed) {
      throw new AuthError("challenge has already been used");
    }

    return clientAccountID;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
