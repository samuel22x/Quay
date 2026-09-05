import { Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";

export interface Sep10LoginResult {
  token: string;
  publicKey: string;
}

/**
 * SEP-10 web-auth login against this repo's own API: fetch the challenge from
 * `GET /auth?account=G…`, sign it with the seller keypair, and mint a session
 * via `POST /auth`. Returns the bearer token the rest of the demo scripts must
 * send as `Authorization: Bearer …`.
 *
 * Since #79, POST /links, GET /links and POST /links/:id/cash-out are all
 * behind requireSeller, so a seed/reset run needs a real session — not a
 * fabricated identity, and not a public endpoint.
 */
export async function loginAsSeller(apiUrl: string, secret: string): Promise<Sep10LoginResult> {
  const keypair = Keypair.fromSecret(secret);

  const challengeUrl = new URL("/auth", apiUrl);
  challengeUrl.searchParams.set("account", keypair.publicKey());

  const challengeRes = await fetch(challengeUrl);
  if (!challengeRes.ok) {
    throw new Error(`GET /auth → ${challengeRes.status}: ${await challengeRes.text()}`);
  }
  const { transaction, network_passphrase } = (await challengeRes.json()) as {
    transaction: string;
    network_passphrase: string;
  };

  const tx = TransactionBuilder.fromXDR(transaction, network_passphrase);
  if (!(tx instanceof Transaction)) {
    throw new Error("SEP-10 challenge was not a signable Transaction");
  }
  tx.sign(keypair);

  const authRes = await fetch(new URL("/auth", apiUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction: tx.toXDR() }),
  });
  if (!authRes.ok) {
    throw new Error(`POST /auth → ${authRes.status}: ${await authRes.text()}`);
  }
  const { token } = (await authRes.json()) as { token: string };
  return { token, publicKey: keypair.publicKey() };
}
