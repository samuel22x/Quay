import type { QuayEventData, QuayEventHandler, QuayEventType, QuayOpenOptions } from "./types";

const listeners = new Map<QuayEventType, Set<QuayEventHandler>>();

let activeOverlay: HTMLElement | null = null;
let activeIframe: HTMLIFrameElement | null = null;
let activeLinkId: string | null = null;
// Always overwritten before use in openModal() - resolveHost() throws rather
// than letting a call proceed with no host resolved (issue 5.10).
let activeHost = "";
let focusTrapHandler: ((e: KeyboardEvent) => void) | null = null;
let postMessageHandler: ((e: MessageEvent) => void) | null = null;
let lastFocusedElement: HTMLElement | null = null;

/**
 * Resolves which Quay deployment the checkout iframe should point at.
 *
 * Previously this fell back to `https://quay-web.vercel.app` (the
 * maintainer's own deployment) when it couldn't be detected any other way -
 * silently pointing a self-hoster's integration at someone else's backend
 * is worse than failing loudly, since the failure mode there is a checkout
 * that mysteriously doesn't match the merchant's own links, not an obvious
 * error. There is deliberately no fallback host anymore: either the
 * integrator passes `host` explicitly, or it's inferred from the actual
 * `<script src="...widget.js">` tag that loaded this code - both are
 * genuinely correct answers. Anything else throws.
 */
function resolveHost(explicitHost: string | undefined): string {
  if (explicitHost) return explicitHost;

  const scriptTag = document.querySelector<HTMLScriptElement>("script[src*='widget.js']");
  if (scriptTag) return new URL(scriptTag.src, window.location.href).origin;

  throw new Error(
    "Quay widget: could not determine which Quay deployment to use. Pass `host` explicitly " +
      '(e.g. Quay.open({ linkId, host: "https://your-quay-deployment.example.com" })), or make ' +
      "sure the widget script tag's own src is reachable (script[src*='widget.js']) so it can be " +
      "inferred automatically.",
  );
}

function emit(type: QuayEventType, data: QuayEventData): void {
  const handlers = listeners.get(type);
  if (handlers) {
    handlers.forEach((fn) => fn(data));
  }
}

export function addEventListener(event: QuayEventType, handler: QuayEventHandler): () => void {
  if (!listeners.has(event)) {
    listeners.set(event, new Set());
  }
  listeners.get(event)!.add(handler);
  return () => {
    listeners.get(event)?.delete(handler);
  };
}

export function closeModal(): void {
  if (!activeOverlay) return;

  if (activeLinkId) {
    emit("quay:closed", { type: "quay:closed", linkId: activeLinkId });
  }

  if (focusTrapHandler) {
    document.removeEventListener("keydown", focusTrapHandler);
    focusTrapHandler = null;
  }

  if (postMessageHandler) {
    window.removeEventListener("message", postMessageHandler);
    postMessageHandler = null;
  }

  if (activeOverlay.parentNode) {
    activeOverlay.parentNode.removeChild(activeOverlay);
  }

  activeOverlay = null;
  activeIframe = null;
  activeLinkId = null;

  if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
    lastFocusedElement.focus();
    lastFocusedElement = null;
  }
}

export function openModal(linkIdOrOpts: string | QuayOpenOptions, opts?: Partial<QuayOpenOptions>): void {
  let linkId: string;
  let options: QuayOpenOptions;

  if (typeof linkIdOrOpts === "string") {
    linkId = linkIdOrOpts;
    options = { linkId, ...opts };
  } else {
    linkId = linkIdOrOpts.linkId;
    options = linkIdOrOpts;
  }

  // Resolved (and allowed to throw) before any state changes - a failed
  // open() call because the host can't be determined should be a true
  // no-op, not one that closes whatever modal was already open and leaves
  // nothing in its place.
  const resolvedHost = resolveHost(options.host);

  closeModal();

  lastFocusedElement = document.activeElement as HTMLElement | null;

  if (options.onPaid) addEventListener("quay:paid", options.onPaid);
  if (options.onClosed) addEventListener("quay:closed", options.onClosed);
  if (options.onError) addEventListener("quay:error", options.onError);

  activeHost = resolvedHost;
  activeLinkId = linkId;

  // Create Modal Overlay
  const overlay = document.createElement("div");
  overlay.id = "quay-checkout-modal";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Stellar Checkout Modal");

  const isReducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  overlay.style.cssText = [
    "position: fixed",
    "top: 0",
    "left: 0",
    "width: 100vw",
    "height: 100vh",
    "background: rgba(0, 0, 0, 0.75)",
    "z-index: 999999",
    "display: flex",
    "align-items: center",
    "justify-content: center",
    "box-sizing: border-box",
    "padding: 16px",
    isReducedMotion ? "" : "backdrop-filter: blur(4px); transition: opacity 0.2s ease",
  ].join("; ");

  // Modal Container
  const container = document.createElement("div");
  container.className = "quay-modal-container";
  container.style.cssText = [
    "position: relative",
    "width: 100%",
    "max-width: 440px",
    "height: 90vh",
    "max-height: 680px",
    "background: #0d1117",
    "border-radius: 16px",
    "overflow: hidden",
    "box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5), 0 8px 10px -6px rgba(0,0,0,0.5)",
    "border: 1px solid #30363d",
    "display: flex",
    "flex-direction: column",
  ].join("; ");

  // Close Button
  const closeBtn = document.createElement("button");
  closeBtn.className = "quay-modal-close";
  closeBtn.innerHTML = "&times;";
  closeBtn.setAttribute("aria-label", "Close checkout modal");
  closeBtn.setAttribute("type", "button");
  closeBtn.style.cssText = [
    "position: absolute",
    "top: 12px",
    "right: 16px",
    "background: none",
    "border: none",
    "color: #8b949e",
    "font-size: 24px",
    "line-height: 1",
    "cursor: pointer",
    "z-index: 10",
    "padding: 4px 8px",
    "border-radius: 4px",
  ].join("; ");

  closeBtn.onclick = () => closeModal();

  // Iframe
  const iframe = document.createElement("iframe");
  iframe.id = "quay-checkout-iframe";
  iframe.setAttribute("title", "Stellar Checkout Interface");
  iframe.style.cssText = "width: 100%; height: 100%; border: none; background: #0d1117;";

  const iframeUrl = `${activeHost}/pay/${encodeURIComponent(linkId)}?embed=true`;
  iframe.src = iframeUrl;

  container.appendChild(closeBtn);
  container.appendChild(iframe);
  overlay.appendChild(container);

  // Add styles for mobile responsiveness & animation
  const styleTag = document.createElement("style");
  styleTag.textContent = `
    @media (max-width: 640px) {
      #quay-checkout-modal { padding: 0 !important; }
      .quay-modal-container { max-width: 100% !important; height: 100vh !important; max-height: 100vh !important; border-radius: 0 !important; border: none !important; }
    }
  `;
  container.appendChild(styleTag);

  document.body.appendChild(overlay);

  activeOverlay = overlay;
  activeIframe = iframe;

  // Backdrop click to close
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      closeModal();
    }
  });

  // Focus Trap & ESC key listener
  focusTrapHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      closeModal();
      return;
    }
    if (e.key === "Tab") {
      const focusables = [closeBtn, iframe];
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    }
  };
  document.addEventListener("keydown", focusTrapHandler);

  // Strict postMessage Origin Listener
  postMessageHandler = (e: MessageEvent) => {
    if (!e.data || typeof e.data !== "object") return;
    
    // Strict origin validation
    const expectedOrigin = new URL(activeHost).origin;
    if (e.origin !== expectedOrigin && e.origin !== window.location.origin) {
      return;
    }

    const { type, linkId: eventLinkId, link, error } = e.data;
    if (type === "quay:paid") {
      emit("quay:paid", { type: "quay:paid", linkId: eventLinkId || activeLinkId || undefined, link });
    } else if (type === "quay:error") {
      emit("quay:error", { type: "quay:error", linkId: eventLinkId || activeLinkId || undefined, error });
    } else if (type === "quay:closed") {
      closeModal();
    }
  };

  window.addEventListener("message", postMessageHandler);

  closeBtn.focus();
}

export function bindButtons(): void {
  if (typeof document === "undefined") return;

  const selector = "[data-quay-link], [data-stellar-checkout]";
  const buttons = document.querySelectorAll<HTMLElement>(selector);

  buttons.forEach((btn) => {
    if (btn.dataset.quayBound) return;
    btn.dataset.quayBound = "true";

    const linkId = btn.getAttribute("data-quay-link") || btn.getAttribute("data-stellar-checkout");
    const label = btn.getAttribute("data-quay-label");

    if (label) {
      btn.textContent = label;
    }

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      if (linkId) {
        openModal(linkId);
      }
    });
  });
}
