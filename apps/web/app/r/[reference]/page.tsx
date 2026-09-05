import { api, type PublicReceipt } from "../../../lib/api";
import { ReceiptClient } from "./ReceiptClient";

function explorerUrl(network: string, hash: string): string {
  const base = network === "public" ? "https://stellar.expert/explorer/public" : "https://stellar.expert/explorer/testnet";
  return `${base}/tx/${hash}`;
}

function addressUrl(network: string, addr: string): string {
  const base = network === "public" ? "https://stellar.expert/explorer/public" : "https://stellar.expert/explorer/testnet";
  return `${base}/account/${addr}`;
}

function contractUrl(network: string, contractId: string): string {
  const base = network === "public" ? "https://stellar.expert/explorer/public" : "https://stellar.expert/explorer/testnet";
  return `${base}/contract/${contractId}`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function ReceiptPage({ params }: { params: Promise<{ reference: string }> }) {
  const { reference } = await params;

  let receipt: PublicReceipt;
  try {
    receipt = await api.getReceipt(reference);
  } catch {
    return (
      <main className="shell shell--narrow" style={{ textAlign: "center", paddingTop: 80 }}>
        <div className="panel">
          <h2 style={{ fontSize: 18, marginBottom: 8, color: "var(--text)" }}>Receipt not found</h2>
          <p className="muted">No payment found for this reference. The link may still be awaiting payment, or the reference is incorrect.</p>
        </div>
      </main>
    );
  }

  const network = (process.env.STELLAR_NETWORK ?? "testnet") === "public" ? "public" : "testnet";

  return (
    <main className="shell shell--receipt">
      {/* Print header */}
      <div className="receipt-print-header">
        <h1>Payment Receipt</h1>
        <p className="muted">Stellar Checkout · {formatDate(receipt.createdAt)}</p>
      </div>

      <section className="panel receipt">
        {/* Merchant title — never KYC or payout details */}
        <div className="receipt-merchant">
          <span className="receipt-icon" aria-hidden>🛒</span>
          <span>{receipt.title}</span>
        </div>

        <div className="receipt-divider" />

        <div className="receipt-row">
          <span className="receipt-label">Amount paid</span>
          <span className="receipt-value mono">{receipt.paidAmount ?? receipt.amount} {receipt.asset.code}</span>
        </div>

        <div className="receipt-row">
          <span className="receipt-label">Status</span>
          <span className={`pill pill--${receipt.status}`}>
            {receipt.status === "paid" ? "Confirmed" : receipt.status.replace("offramp_", "Off-ramp ")}
          </span>
        </div>

        <div className="receipt-row">
          <span className="receipt-label">Reference</span>
          <span className="receipt-value mono">{receipt.reference}</span>
        </div>

        {receipt.txHash && (
          <div className="receipt-row">
            <span className="receipt-label">Transaction</span>
            <a
              href={explorerUrl(network, receipt.txHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="mono explorer-link"
            >
              {receipt.txHash.slice(0, 12)}…{receipt.txHash.slice(-8)}
            </a>
          </div>
        )}

        {receipt.payer && (
          <div className="receipt-row">
            <span className="receipt-label">From</span>
            <a
              href={addressUrl(network, receipt.payer)}
              target="_blank"
              rel="noopener noreferrer"
              className="mono explorer-link"
            >
              {receipt.payer.slice(0, 8)}…{receipt.payer.slice(-6)}
            </a>
          </div>
        )}

        <div className="receipt-divider" />

        {/* On-chain attestation. Stated plainly in both directions: claiming a
            receipt is independently verifiable when it isn't would be worse
            than saying nothing, and the absence is not an error — settlement is
            proven by the payment above either way. */}
        {receipt.attestation ? (
          <>
            <div className="receipt-row">
              <span className="receipt-label">Attested on-chain</span>
              <a
                href={contractUrl(network, receipt.attestation.contractId)}
                target="_blank"
                rel="noopener noreferrer"
                className="mono explorer-link"
              >
                {receipt.attestation.contractId.slice(0, 8)}…{receipt.attestation.contractId.slice(-6)}
              </a>
            </div>
            <div className="receipt-row">
              <span className="receipt-label">Registry key</span>
              <span className="receipt-value mono">
                {receipt.attestation.refHash.slice(0, 16)}…
              </span>
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              This payment is recorded in a Soroban registry that Quay cannot rewrite. Verify it
              yourself with <code className="mono">verify(ref_hash)</code> on the contract above —
              you do not have to take this page&apos;s word for it.
            </p>
            <div className="receipt-divider" />
          </>
        ) : null}

        <div className="receipt-footer-meta">
          <span className="muted">Settled on Stellar {network === "public" ? "Mainnet" : "Testnet"}</span>
          <span className="muted">{formatDate(receipt.updatedAt)}</span>
        </div>
      </section>

      {/* Actions */}
      <ReceiptClient />

      <footer className="receipt-footer">
        <p className="muted">Powered by Quay — Non-custodial stablecoin checkout on Stellar</p>
      </footer>
    </main>
  );
}
