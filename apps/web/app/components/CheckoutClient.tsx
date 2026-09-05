"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api, type LinkWithRequest, type PaymentLink } from "../../lib/api";

const WalletPayButton = dynamic(() => import("./WalletPayButton"), {
  ssr: false,
  loading: () => <div className="status-rail">Loading wallet payment…</div>,
});

const WALLET_PAY_ENABLED = process.env.NEXT_PUBLIC_ENABLE_WALLET_PAY === "true";

// ── Constants ───────────────────────────────────────────────────────────────

/** Link statuses where the payment journey is over (buyer needn't wait). */
const TERMINAL = new Set([
  "paid",
  "expired",
  "cancelled",
  "offramp_pending",
  "offramp_settled",
  "offramp_failed",
]);

/** Terminal statuses that represent a successful payment. */
const SETTLED = new Set(["paid", "offramp_pending", "offramp_settled", "offramp_failed"]);

const BASE_INTERVAL_MS = 4_000;
const BACKOFF_MULTIPLIER = 2;
const MAX_FAILURES_BEFORE_BACKOFF = 3;

// ── Human copy per non-settled terminal state ───────────────────────────────

function terminalCopy(status: string): { heading: string; detail: string } {
  switch (status) {
    case "expired":
      return {
        heading: "This payment link has expired",
        detail: "The time window to pay has passed. Please ask the seller for a new link.",
      };
    case "cancelled":
      return {
        heading: "This payment link has been cancelled",
        detail: "The seller cancelled this request. Please contact them if you have questions.",
      };
    default:
      return { heading: "Unavailable", detail: "This link is no longer active." };
  }
}

// ── Component ───────────────────────────────────────────────────────────────

export default function CheckoutClient({
  initial,
  embed = false,
}: {
  initial: LinkWithRequest;
  /** Rendered inside the widget's 440x680 iframe (issue 5.10) - drives tighter spacing/QR sizing via `.checkout--embed` (globals.css) and a smaller QR that CSS alone can't produce (the `size` prop is a real pixel value, not stylable). */
  embed?: boolean;
}) {
  const { request } = initial;
  const [link, setLink] = useState(initial.link);
  const [submittedTxHash, setSubmittedTxHash] = useState<string | null>(null);

  const markSubmitted = useCallback((txHash: string) => {
    setSubmittedTxHash(txHash);
  }, []);
  const walletPayment = { link, request };

  // Polling state
  const [consecutiveFails, setConsecutiveFails] = useState(0);
  const [stopped, setStopped] = useState(false);
  const intervalMsRef = useRef(BASE_INTERVAL_MS);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pollingRef = useRef(false);

  const isTerminal = TERMINAL.has(link.status);
  const isSettled = SETTLED.has(link.status);
  const connectionLost = consecutiveFails >= MAX_FAILURES_BEFORE_BACKOFF;

  // ── Poll ──────────────────────────────────────────────────────────────────

  /** Returns the newly fetched link on success, or null on failure. */
  const poll = useCallback(async (): Promise<PaymentLink | null> => {
    if (pollingRef.current) return null; // prevent concurrent calls
    pollingRef.current = true;
    try {
      const next = await api.getLink(link.id);
      setConsecutiveFails(0);
      setStopped(false);
      intervalMsRef.current = BASE_INTERVAL_MS;
      setLink(next.link);
      return next.link;
    } catch {
      setConsecutiveFails((c) => c + 1);
      return null;
    } finally {
      pollingRef.current = false;
    }
  }, [link.id]);

  // Sync backoff interval when consecutiveFails changes.
  useEffect(() => {
    if (consecutiveFails >= MAX_FAILURES_BEFORE_BACKOFF) {
      intervalMsRef.current = BASE_INTERVAL_MS * BACKOFF_MULTIPLIER;
      setStopped(true);
    }
  }, [consecutiveFails]);

  // ── Retry (manual, from "lost contact" screen) ────────────────────────────

  const retry = useCallback(() => {
    setConsecutiveFails(0);
    setStopped(false);
    intervalMsRef.current = BASE_INTERVAL_MS;
    // The interval loop will restart via the effect below when stopped flips to false.
  }, []);

  // ── Polling interval ─────────────────────────────────────────────────────

  useEffect(() => {
    if (isTerminal || stopped) return;

    // Fire immediately, then schedule the next.
    poll();

    const scheduleNext = () => {
      timerRef.current = setTimeout(() => {
        poll().then((newLink) => {
          // Use the freshly returned link for the terminal check, not the
          // stale closure value.
          if (newLink && !TERMINAL.has(newLink.status)) {
            scheduleNext();
          }
        });
      }, intervalMsRef.current);
    };

    scheduleNext();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [link.id, link.status, isTerminal, stopped, poll]);

  // ── RENDER: Settled (paid / offramp) ─────────────────────────────────────

  if (isSettled) {
    return (
      <div className={embed ? "checkout checkout--embed" : "checkout"}>
        <div className="settled-check" aria-hidden>
          ✓
        </div>
        <div className="settled">Payment received</div>
        <p className="muted" style={{ marginTop: 8 }}>
          {link.paidAmount ?? link.amount} {link.asset.code} settled to the merchant.
        </p>
        <div className="memo-note" style={{ marginTop: 24 }}>
          <div className="k">Transaction</div>
          <div className="v">{link.txHash ?? "confirmed on-chain"}</div>
        </div>
      </div>
    );
  }

  // ── RENDER: Optimistic submission -----------------------------------------

  if (submittedTxHash) {
    return (
      <div className={embed ? "checkout checkout--embed" : "checkout"}>
        <div className="status-icon" aria-hidden>
          ✓
        </div>
        <div className="error-heading">Payment submitted</div>
        <p className="muted" style={{ marginTop: 8 }}>
          Your wallet signed the payment. Waiting for the Stellar network to confirm it.
        </p>
        <div className="memo-note" style={{ marginTop: 24 }}>
          <div className="k">Submission</div>
          <div className="v">{submittedTxHash}</div>
        </div>
        <div className="status-rail">
          <span className="spinner" aria-hidden />
          Waiting for confirmation…
        </div>
      </div>
    );
  }

  // ── RENDER: Underpaid ────────────────────────────────────────────────────

  if (link.status === "underpaid") {
    return (
      <div className={embed ? "checkout checkout--embed" : "checkout"}>
        <div className="error-icon" aria-hidden>
          ⚠
        </div>
        <div className="error-heading">Payment too low</div>
        <p className="muted" style={{ marginTop: 8 }}>
          A payment was detected for {link.paidAmount ?? "?"} {link.asset.code} but the requested
          amount is {link.amount} {link.asset.code}. Please send the remaining amount to complete the
          payment, or contact the seller.
        </p>
        <div className="memo-note" style={{ marginTop: 24 }}>
          <div className="k">Transaction</div>
          <div className="v">{link.txHash ?? "confirmed on-chain"}</div>
        </div>
        {WALLET_PAY_ENABLED && (
          <WalletPayButton initial={walletPayment} onSubmitted={markSubmitted} />
        )}
      </div>
    );
  }

  // ── RENDER: Other terminal (expired / cancelled) ─────────────────────────

  if (link.status === "expired" || link.status === "cancelled") {
    const copy = terminalCopy(link.status);
    return (
      <div className={embed ? "checkout checkout--embed" : "checkout"}>
        <div className="error-icon" aria-hidden>
          {link.status === "expired" ? "⏰" : "✕"}
        </div>
        <div className="error-heading">{copy.heading}</div>
        <p className="muted" style={{ marginTop: 8 }}>
          {copy.detail}
        </p>
        <div className="memo-note" style={{ marginTop: 24 }}>
          <div className="k">Reference</div>
          <div className="v">{link.reference}</div>
        </div>
      </div>
    );
  }

  // ── RENDER: Connection lost ──────────────────────────────────────────────

  if (connectionLost) {
    return (
      <div className={embed ? "checkout checkout--embed" : "checkout"}>
        <div className="error-icon" aria-hidden>
          ⚡
        </div>
        <div className="error-heading">We&apos;ve lost contact with the payment service</div>
        <p className="muted" style={{ marginTop: 8 }}>
          Don&apos;t worry — if you already sent a payment it will still be matched. Check back in a
          moment.
        </p>
        <button className="btn btn--primary" style={{ marginTop: 20 }} onClick={retry}>
          Try again
        </button>
      </div>
    );
  }

  // ── RENDER: Active — waiting for payment ─────────────────────────────────

  return (
    <div className={embed ? "checkout checkout--embed" : "checkout"}>
      <div className="merchant">Pay merchant</div>
      <p className="title">{link.title}</p>

      <div className="amount-hero">
        {link.amount}
        <span className="asset">{link.asset.code}</span>
      </div>

      <div className="qr-wrap">
        <QRCodeSVG value={request.uri} size={embed ? 140 : 180} fgColor="#0b0f14" bgColor="#ffffff" level="M" />
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        Scan with a Stellar wallet, or
      </p>

      {WALLET_PAY_ENABLED && (
        <WalletPayButton initial={walletPayment} disabled={Boolean(submittedTxHash)} onSubmitted={markSubmitted} />
      )}

      <a
        className="btn btn--primary btn--block"
        href={request.uri}
        style={{ marginTop: 12 }}
      >
        Open in wallet
      </a>

      {request.memo && (
        <div className="memo-note">
          <div className="k">Memo — must be included</div>
          <div className="v">{request.memo}</div>
          <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
            Your wallet must send this memo so the payment can be matched. The link above sets it for
            you.
          </p>
        </div>
      )}

      <div className="status-rail">
        <span className="spinner" aria-hidden />
        Waiting for payment…
      </div>

      {consecutiveFails > 0 && (
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Having trouble reaching the payment service. Attempt {consecutiveFails}.
        </p>
      )}
    </div>
  );
}
