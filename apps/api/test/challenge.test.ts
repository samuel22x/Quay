import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import type { UsedChallengeStore } from "@checkout/core";
import {
  AuthError,
  ChallengeService,
  MemoryUsedChallengeStore,
  type FetchAccountSigners,
} from "../src/services/challenge";

const HOME_DOMAIN = "quay.test";
const WEB_AUTH_DOMAIN = "quay.test";
const NETWORK_PASSPHRASE = Networks.TESTNET;

// No account in these tests is ever funded on-chain, so every lookup falls back
// to the "account id is its own sole signer" SEP-10 path — no network call.
const noAccountsExist: FetchAccountSigners = async () => null;

function makeService(
  fetchAccountSigners: FetchAccountSigners = noAccountsExist,
  usedChallengeStore?: UsedChallengeStore,
) {
  return new ChallengeService({
    serverKeypair: Keypair.random(),
    homeDomain: HOME_DOMAIN,
    webAuthDomain: WEB_AUTH_DOMAIN,
    networkPassphrase: NETWORK_PASSPHRASE,
    fetchAccountSigners,
    usedChallengeStore,
  });
}

describe("ChallengeService", () => {
  it("build() issues a challenge the client can sign and the server can verify", async () => {
    const service = makeService();
    const client = Keypair.random();

    const { transaction, network_passphrase } = service.build(client.publicKey());
    expect(network_passphrase).toBe(NETWORK_PASSPHRASE);

    const tx = TransactionBuilder.fromXDR(transaction, network_passphrase);
    tx.sign(client);

    const account = await service.verify(tx.toXDR());
    expect(account).toBe(client.publicKey());
  });

  it("rejects an unsigned challenge", async () => {
    const service = makeService();
    const client = Keypair.random();

    const { transaction, network_passphrase } = service.build(client.publicKey());
    // Never signed by the client — only the server's own signature is present.
    await expect(service.verify(TransactionBuilder.fromXDR(transaction, network_passphrase).toXDR())).rejects.toThrow(
      AuthError,
    );
  });

  it("rejects a replayed challenge — the same signed transaction can't be redeemed twice", async () => {
    const service = makeService();
    const client = Keypair.random();

    const { transaction, network_passphrase } = service.build(client.publicKey());
    const tx = TransactionBuilder.fromXDR(transaction, network_passphrase);
    tx.sign(client);
    const signedXdr = tx.toXDR();

    await expect(service.verify(signedXdr)).resolves.toBe(client.publicKey());
    await expect(service.verify(signedXdr)).rejects.toThrow(/already been used/);
  });

  // Issue 6.7: with more than one API instance and no shared store, the same
  // signed challenge could be redeemed once per instance. Two ChallengeService
  // instances sharing one UsedChallengeStore models that deployment — the
  // second instance to redeem the same signed challenge must still lose.
  it("rejects a challenge already redeemed on another instance sharing the same store", async () => {
    const serverKeypair = Keypair.random();
    const sharedStore = new MemoryUsedChallengeStore();
    const instanceA = new ChallengeService({
      serverKeypair,
      homeDomain: HOME_DOMAIN,
      webAuthDomain: WEB_AUTH_DOMAIN,
      networkPassphrase: NETWORK_PASSPHRASE,
      fetchAccountSigners: noAccountsExist,
      usedChallengeStore: sharedStore,
    });
    const instanceB = new ChallengeService({
      serverKeypair,
      homeDomain: HOME_DOMAIN,
      webAuthDomain: WEB_AUTH_DOMAIN,
      networkPassphrase: NETWORK_PASSPHRASE,
      fetchAccountSigners: noAccountsExist,
      usedChallengeStore: sharedStore,
    });
    const client = Keypair.random();

    const { transaction, network_passphrase } = instanceA.build(client.publicKey());
    const tx = TransactionBuilder.fromXDR(transaction, network_passphrase);
    tx.sign(client);
    const signedXdr = tx.toXDR();

    await expect(instanceA.verify(signedXdr)).resolves.toBe(client.publicKey());
    await expect(instanceB.verify(signedXdr)).rejects.toThrow(/already been used/);
  });

  // The sequential test above proves the store is shared. This one proves the
  // claim is atomic: both instances verify the same signature concurrently, and
  // `fetchAccountSigners` awaits a real tick, so the two verify() calls are
  // guaranteed to interleave between signature check and claim. Exactly one may
  // win. A check-then-set store would let both through here.
  it("lets exactly one of two concurrent redemptions of the same challenge win", async () => {
    const serverKeypair = Keypair.random();
    const sharedStore = new MemoryUsedChallengeStore();
    const slowFetch: FetchAccountSigners = async () => {
      await new Promise((r) => setTimeout(r, 5));
      return null;
    };
    const build = () =>
      new ChallengeService({
        serverKeypair,
        homeDomain: HOME_DOMAIN,
        webAuthDomain: WEB_AUTH_DOMAIN,
        networkPassphrase: NETWORK_PASSPHRASE,
        fetchAccountSigners: slowFetch,
        usedChallengeStore: sharedStore,
      });
    const instanceA = build();
    const instanceB = build();
    const client = Keypair.random();

    const { transaction, network_passphrase } = instanceA.build(client.publicKey());
    const tx = TransactionBuilder.fromXDR(transaction, network_passphrase);
    tx.sign(client);
    const signedXdr = tx.toXDR();

    const results = await Promise.allSettled([
      instanceA.verify(signedXdr),
      instanceB.verify(signedXdr),
    ]);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((won[0] as PromiseFulfilledResult<string>).value).toBe(client.publicKey());
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(AuthError);
    expect(String((lost[0] as PromiseRejectedResult).reason)).toMatch(/already been used/);
  });

  it("rejects a challenge signed by the wrong account", async () => {
    const service = makeService();
    const claimedAccount = Keypair.random();
    const impostor = Keypair.random();

    const { transaction, network_passphrase } = service.build(claimedAccount.publicKey());
    const tx = TransactionBuilder.fromXDR(transaction, network_passphrase);
    tx.sign(impostor); // signs with a different key than the one named in the challenge

    await expect(service.verify(tx.toXDR())).rejects.toThrow(AuthError);
  });

  it("rejects a challenge whose server signature was tampered with", async () => {
    const service = makeService();
    const otherServer = new ChallengeService({
      serverKeypair: Keypair.random(),
      homeDomain: HOME_DOMAIN,
      webAuthDomain: WEB_AUTH_DOMAIN,
      networkPassphrase: NETWORK_PASSPHRASE,
      fetchAccountSigners: noAccountsExist,
    });
    const client = Keypair.random();

    // A challenge minted by a different server key must never verify against ours.
    const { transaction, network_passphrase } = otherServer.build(client.publicKey());
    const tx = TransactionBuilder.fromXDR(transaction, network_passphrase);
    tx.sign(client);

    await expect(service.verify(tx.toXDR())).rejects.toThrow(AuthError);
  });

  it("enforces M-of-N thresholds when the client account exists on-chain", async () => {
    const signerA = Keypair.random();
    const signerB = Keypair.random();
    const client = Keypair.random();

    const service = makeService(async (accountId) => {
      if (accountId !== client.publicKey()) return null;
      // Medium threshold 20, two signers of weight 10 each — neither alone suffices.
      return { signers: { [signerA.publicKey()]: 10, [signerB.publicKey()]: 10 }, medThreshold: 20 };
    });

    const { transaction, network_passphrase } = service.build(client.publicKey());
    const tx = TransactionBuilder.fromXDR(transaction, network_passphrase);
    tx.sign(signerA); // one signer, weight 10 < threshold 20

    await expect(service.verify(tx.toXDR())).rejects.toThrow(AuthError);

    const tx2 = TransactionBuilder.fromXDR(transaction, network_passphrase);
    tx2.sign(signerA);
    tx2.sign(signerB); // now 20 >= threshold 20

    await expect(service.verify(tx2.toXDR())).resolves.toBe(client.publicKey());
  });
});
