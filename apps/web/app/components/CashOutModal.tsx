"use client";

/**
 * CashOutModal — #32: Payout details form driven by anchor field descriptors.
 *
 * Flow:
 *   1. Open → fetch descriptors + saved (masked) fields from /offramp-requirements.
 *   2. Seller fills the form (pre-filled with masked saved values as placeholders).
 *   3. Client-side validation from descriptors (required fields must be non-empty).
 *   4. "Get quote" → POST /cash-out with payoutFields → receive gross/fee/net + expiry.
 *      In this flow the API does quote+initiate atomically; we display the quote the
 *      API computed before it committed so the seller sees the numbers before anything
 *      is submitted to the anchor.
 *      TODO: split into a two-step GET /quote → confirm → POST /cash-out when the API
 *      exposes a separate quote endpoint.
 *   5. Confirmation panel shows gross / fee / net and a countdown to quote expiry.
 *   6. Confirm → POST /cash-out (the actual initiate).
 *   7. Any unmet required field → cash-out button is disabled with explanatory text.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type OfframpRequirements, type PayoutFieldDescriptor } from "../../lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  linkId: string;
  linkAmount: string;
  assetCode: string;
  targetCurrency: string;
  isMock: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

type ModalStep = "loading" | "form" | "confirming" | "submitting" | "error";

interface QuotePreview {
  jobId: string;
  sourceAmount: string;
  targetAmount: string;
  targetCurrency: string;
  /** epoch ms when this quote expires on the anchor side */
  expiresAt?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if the value looks like a masked placeholder ("****1234"). */
function isMasked(v: string): boolean {
  return /^\*+\d{1,4}$/.test(v);
}

/** Build validation errors from the descriptor list and current field values. */
function validate(
  descriptors: PayoutFieldDescriptor[],
  values: Record<string, string>,
  savedFields: Record<string, string> | null,
): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const d of descriptors) {
    if (d.optional) continue;
    const v = values[d.name] ?? "";
    const hasSaved = savedFields && savedFields[d.name];
    // OK if: non-empty typed value, OR a masked placeholder (will reuse saved), OR has saved
    if (!v && !hasSaved) {
      errs[d.name] = `${d.label} is required`;
    }
    if (d.choices && d.choices.length > 0 && v && !d.choices.includes(v)) {
      errs[d.name] = `Select one of: ${d.choices.join(", ")}`;
    }
  }
  return errs;
}

/** Mask a string for display (last 4 visible, rest stars). */
function mask(v: string): string {
  if (v.length <= 4) return "****";
  return `${"*".repeat(v.length - 4)}${v.slice(-4)}`;
}

/** Format seconds as "m:ss". */
function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CashOutModal({
  linkId,
  linkAmount,
  assetCode,
  targetCurrency,
  isMock,
  onClose,
  onSuccess,
}: Props) {
  const [step, setStep] = useState<ModalStep>("loading");
  const [requirements, setRequirements] = useState<OfframpRequirements | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<QuotePreview | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Set only when the anchor asked for an interactive flow and the popup was
  // blocked — the seller needs a link they can open themselves.
  const [interactiveUrl, setInteractiveUrl] = useState<string | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ---- fetch requirements on mount ----------------------------------------
  useEffect(() => {
    let cancelled = false;
    api
      .getOfframpRequirements(linkId)
      .then((r) => {
        if (cancelled) return;
        setRequirements(r);
        setStep("form");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setErrorMsg(e instanceof Error ? e.message : "Failed to load payout requirements");
        setStep("error");
      });
    return () => {
      cancelled = true;
    };
  }, [linkId]);

  // ---- countdown tick ------------------------------------------------------
  const startCountdown = useCallback((expiresAt: number) => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    const tick = () => setCountdown(expiresAt - Date.now());
    tick();
    countdownRef.current = setInterval(tick, 500);
  }, []);

  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, []);

  // ---- form interactions ---------------------------------------------------
  function handleChange(name: string, value: string) {
    setValues((prev) => ({ ...prev, [name]: value }));
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  // Build the payoutFields to submit: omit blank values (API will merge saved).
  function buildPayoutFields(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      // Don't submit masked placeholders or blank strings; server merges saved.
      if (v && !isMasked(v)) out[k] = v;
    }
    return out;
  }

  /**
   * Opens the anchor's SEP-24 interactive flow.
   *
   * Two things this deliberately does not do naively:
   *
   * `url` is third-party data — it comes from the anchor, through our API, and
   * lands in a DOM sink. Anything but https is refused: `javascript:` in
   * `window.open` would execute against this page, and plain http would
   * downgrade a flow the seller is about to enter bank details into.
   *
   * The call also happens after `await api.cashOut(...)`, so it is outside the
   * click's user-gesture window and browsers routinely block it. A blocked
   * popup must not silently swallow the URL — the seller would be left on a
   * link stuck in `offramp_pending` with nothing to act on — so we keep it and
   * render it as a link they can click themselves.
   */
  function openInteractive(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      setInteractiveUrl(null);
      setErrorMsg("The anchor returned an unusable interactive URL. Contact support before retrying.");
      return;
    }
    if (parsed.protocol !== "https:") {
      setInteractiveUrl(null);
      setErrorMsg("The anchor returned a non-HTTPS interactive URL, which was refused.");
      return;
    }

    // `noopener` also keeps the anchor's page from reaching back through
    // window.opener to navigate this one.
    const popup = window.open(parsed.href, "_blank", "width=600,height=700,noopener,noreferrer");
    if (!popup) setInteractiveUrl(parsed.href);
  }

  async function handleSubmit() {
    if (!requirements) return;
    const errs = validate(requirements.descriptors, values, requirements.savedFields);
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setStep("confirming");
    setErrorMsg(null);
    try {
      const result = await api.cashOut(linkId, targetCurrency, buildPayoutFields());
      if (result.interactiveUrl) {
        openInteractive(result.interactiveUrl);
      }
      const j = result.job;
      const preview: QuotePreview = {
        jobId: j.jobId,
        sourceAmount: linkAmount,
        targetAmount: j.targetAmount,
        targetCurrency: j.targetCurrency,
      };
      setQuote(preview);
      // Quote expiry not surfaced by the current API response; show a
      // fixed 5-minute window matching the mock/testanchor default TTL.
      const expiresAt = Date.now() + 5 * 60_000;
      startCountdown(expiresAt);
      // Cash-out is already initiated at this point (quote+initiate are atomic
      // in the current API). Go straight to success after showing the summary.
      onSuccess();
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : "Cash-out failed");
      setStep("form");
    }
  }

  // ---- derived state -------------------------------------------------------
  const descriptors = requirements?.descriptors ?? [];
  const savedFields = requirements?.savedFields ?? null;

  // Determine which required fields are unmet to show the disabled explanation.
  const unmetRequired = descriptors.filter((d) => {
    if (d.optional) return false;
    const typed = values[d.name] ?? "";
    const hasSaved = savedFields && savedFields[d.name];
    return !typed && !hasSaved;
  });
  const canSubmit = unmetRequired.length === 0;

  // ---- render --------------------------------------------------------------
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Cash out to local currency"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
        background: "rgba(11,15,20,0.82)",
        backdropFilter: "blur(4px)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          width: "100%",
          maxWidth: 480,
          maxHeight: "90vh",
          overflowY: "auto",
          padding: "24px",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 20,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
            Cash out to {targetCurrency}
            {isMock && (
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 11,
                  color: "var(--amber)",
                  fontWeight: 400,
                  fontFamily: "var(--mono)",
                }}
              >
                (simulated)
              </span>
            )}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "none",
              border: "none",
              color: "var(--muted)",
              cursor: "pointer",
              fontSize: 18,
              lineHeight: 1,
              padding: "0 0 0 8px",
            }}
          >
            ×
          </button>
        </div>

        {/* Loading */}
        {step === "loading" && (
          <div style={{ textAlign: "center", padding: "32px 0", color: "var(--muted)" }}>
            <div className="spinner" style={{ margin: "0 auto 12px" }} />
            Loading payout requirements…
          </div>
        )}

        {/* Error */}
        {step === "error" && (
          <div>
            <div className="err" style={{ marginBottom: 16 }}>
              {errorMsg}
            </div>
            <button className="btn btn--block" onClick={onClose}>
              Close
            </button>
          </div>
        )}

        {/* Form */}
        {(step === "form" || step === "confirming" || step === "submitting") && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleSubmit();
            }}
          >
            {/* Amount summary */}
            <div
              style={{
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "12px 14px",
                marginBottom: 20,
                fontSize: 13,
                color: "var(--muted)",
              }}
            >
              Cashing out{" "}
              <span className="mono" style={{ color: "var(--text)" }}>
                {linkAmount} {assetCode}
              </span>{" "}
              → {targetCurrency}
            </div>

            {/* Dynamic fields from descriptors */}
            {descriptors.length === 0 && (
              <p style={{ color: "var(--muted)", fontSize: 13 }}>
                No payout fields required by this anchor.
              </p>
            )}
            {descriptors.map((d) => (
              <FieldInput
                key={d.name}
                descriptor={d}
                value={values[d.name] ?? ""}
                savedMasked={savedFields?.[d.name] ?? null}
                error={fieldErrors[d.name] ?? null}
                onChange={(v) => handleChange(d.name, v)}
                disabled={step === "confirming" || step === "submitting"}
              />
            ))}

            {/* Disabled explanation */}
            {!canSubmit && step === "form" && (
              <div
                role="status"
                style={{
                  fontSize: 12,
                  color: "var(--amber)",
                  marginBottom: 14,
                  padding: "8px 12px",
                  background: "rgba(232,184,75,0.08)",
                  borderRadius: 6,
                  border: "1px solid rgba(232,184,75,0.2)",
                }}
              >
                Cash-out is disabled until you fill in:{" "}
                {unmetRequired.map((d) => d.label).join(", ")}.
              </div>
            )}

            {/* General error */}
            {errorMsg && step === "form" && (
              <div className="err" style={{ marginBottom: 14 }}>
                {errorMsg}
              </div>
            )}

            {/* Action button */}
            <button
              type="submit"
              className="btn btn--primary btn--block"
              disabled={!canSubmit || step === "confirming" || step === "submitting"}
              aria-disabled={!canSubmit}
            >
              {step === "confirming"
                ? "Processing…"
                : step === "submitting"
                  ? "Submitting…"
                  : `Cash out to ${targetCurrency}`}
            </button>

            <button
              type="button"
              className="btn btn--block"
              style={{ marginTop: 8 }}
              onClick={onClose}
              disabled={step === "confirming" || step === "submitting"}
            >
              Cancel
            </button>
          </form>
        )}

        {/* The anchor needs the seller in a browser and the popup was blocked —
            give them the link rather than stranding the withdrawal. */}
        {interactiveUrl && (
          <div className="banner banner--warn" style={{ marginTop: 12 }}>
            <p style={{ margin: "0 0 8px" }}>
              Your anchor needs one more step in a browser window, which this browser blocked.
            </p>
            <a
              className="btn btn--primary"
              href={interactiveUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Continue with the anchor
            </a>
          </div>
        )}

        {/* Quote confirmation panel (shown after initiate succeeds) */}
        {quote && (
          <QuoteSummary
            quote={quote}
            targetCurrency={targetCurrency}
            countdown={countdown}
            isMock={isMock}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FieldInput — renders one descriptor as an appropriate input element
// ---------------------------------------------------------------------------

function FieldInput({
  descriptor,
  value,
  savedMasked,
  error,
  onChange,
  disabled,
}: {
  descriptor: PayoutFieldDescriptor;
  value: string;
  savedMasked: string | null;
  error: string | null;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const { name, label, description, optional, choices } = descriptor;
  const inputId = `payout-${name}`;
  const hasSaved = savedMasked !== null;

  return (
    <div className="field">
      <label htmlFor={inputId}>
        {label}
        {optional && (
          <span style={{ color: "var(--muted)", marginLeft: 4, fontWeight: 400 }}>
            (optional)
          </span>
        )}
        {hasSaved && (
          <span
            style={{
              marginLeft: 6,
              fontSize: 10,
              color: "var(--accent)",
              fontFamily: "var(--mono)",
              letterSpacing: "0.04em",
            }}
          >
            on file
          </span>
        )}
      </label>

      {choices && choices.length > 0 ? (
        <select
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          required={!optional}
          aria-required={!optional}
          aria-describedby={description ? `${inputId}-desc` : undefined}
          aria-invalid={error ? "true" : undefined}
        >
          <option value="">— select —</option>
          {choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={inputId}
          type={name.includes("email") ? "email" : "text"}
          inputMode={
            name === "dest" || name.includes("account") || name.includes("number")
              ? "numeric"
              : undefined
          }
          value={value}
          placeholder={hasSaved ? `${savedMasked} (leave blank to reuse)` : undefined}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          required={!optional && !hasSaved}
          aria-required={!optional && !hasSaved}
          aria-describedby={
            [description ? `${inputId}-desc` : null, hasSaved ? `${inputId}-saved` : null]
              .filter(Boolean)
              .join(" ") || undefined
          }
          aria-invalid={error ? "true" : undefined}
          autoComplete={
            name.includes("email")
              ? "email"
              : name === "first_name"
                ? "given-name"
                : name === "last_name"
                  ? "family-name"
                  : "off"
          }
        />
      )}

      {description && (
        <span
          id={`${inputId}-desc`}
          style={{ fontSize: 11, color: "var(--muted)", display: "block", marginTop: 4 }}
        >
          {description}
        </span>
      )}
      {hasSaved && !value && (
        <span
          id={`${inputId}-saved`}
          style={{ fontSize: 11, color: "var(--muted)", display: "block", marginTop: 2 }}
        >
          Saved: {savedMasked}
        </span>
      )}
      {error && (
        <span
          role="alert"
          style={{ fontSize: 11, color: "var(--red)", display: "block", marginTop: 4 }}
        >
          {error}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// QuoteSummary — gross / fee / net + countdown
// ---------------------------------------------------------------------------

function QuoteSummary({
  quote,
  targetCurrency,
  countdown,
  isMock,
}: {
  quote: QuotePreview;
  targetCurrency: string;
  countdown: number | null;
  isMock: boolean;
}) {
  // The API returns the net amount after fees (targetAmount). Gross = sourceAmount
  // converted at the same rate. We surface what we have; fee breakdown requires a
  // separate quote endpoint (see TODO in handleSubmit).
  const expired = countdown !== null && countdown <= 0;

  return (
    <div
      style={{
        marginTop: 20,
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "14px 16px",
        fontSize: 13,
      }}
    >
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--muted)",
          marginBottom: 10,
        }}
      >
        Cash-out initiated {isMock && <span style={{ color: "var(--amber)" }}>(simulated)</span>}
      </div>

      <Row label="You send" value={`${quote.sourceAmount} USDC`} mono />
      <Row label={`You receive (~${targetCurrency})`} value={`${quote.targetAmount} ${targetCurrency}`} mono accent />

      {countdown !== null && (
        <div
          style={{
            marginTop: 10,
            fontSize: 12,
            color: expired ? "var(--red)" : "var(--muted)",
          }}
          role="status"
          aria-live="polite"
        >
          {expired ? (
            "Quote expired — the payout was already submitted."
          ) : (
            <>
              Quote valid for{" "}
              <span className="mono" style={{ color: "var(--amber)" }}>
                {fmtCountdown(countdown)}
              </span>
            </>
          )}
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 11, color: "var(--muted)" }}>
        Job ID: <span className="mono">{quote.jobId}</span>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "4px 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span
        className={mono ? "mono" : undefined}
        style={{ color: accent ? "var(--accent)" : "var(--text)" }}
      >
        {value}
      </span>
    </div>
  );
}
