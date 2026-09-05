// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Quay } from "../src/index";

describe("Quay Widget SDK", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Quay.close();
  });

  it("exposes expected Quay SDK API methods", () => {
    expect(typeof Quay.open).toBe("function");
    expect(typeof Quay.close).toBe("function");
    expect(typeof Quay.init).toBe("function");
    expect(typeof Quay.on).toBe("function");
  });

  const TEST_HOST = "https://test.example.com";

  it("opens modal and appends overlay element to body", () => {
    Quay.open({ linkId: "lnk_test_123", host: TEST_HOST });

    const modal = document.getElementById("quay-checkout-modal");
    expect(modal).not.toBeNull();
    expect(modal?.getAttribute("role")).toBe("dialog");

    const iframe = document.getElementById("quay-checkout-iframe") as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    expect(iframe.src).toContain("/pay/lnk_test_123?embed=true");
    expect(iframe.src).toContain(TEST_HOST);
  });

  it("closes modal on Quay.close() call", () => {
    Quay.open({ linkId: "lnk_test_123", host: TEST_HOST });
    expect(document.getElementById("quay-checkout-modal")).not.toBeNull();

    Quay.close();
    expect(document.getElementById("quay-checkout-modal")).toBeNull();
  });

  it("binds click listener to [data-quay-link] button, inferring the host from the widget's own script tag", () => {
    document.body.innerHTML = `
      <script src="${TEST_HOST}/widget.js"></script>
      <button id="pay-btn" data-quay-link="lnk_btn_456" data-quay-label="Pay $10">Pay</button>
    `;

    Quay.init();

    const btn = document.getElementById("pay-btn")!;
    expect(btn.textContent).toBe("Pay $10");

    btn.click();

    const modal = document.getElementById("quay-checkout-modal");
    expect(modal).not.toBeNull();
    const iframe = document.getElementById("quay-checkout-iframe") as HTMLIFrameElement;
    expect(iframe.src).toContain("/pay/lnk_btn_456?embed=true");
    expect(iframe.src).toContain(TEST_HOST);
  });

  it("subscribes to events with Quay.on()", () => {
    const onPaid = vi.fn();
    const unsubscribe = Quay.on("quay:paid", onPaid);

    Quay.open({ linkId: "lnk_test_123", host: TEST_HOST });

    const event = new MessageEvent("message", {
      data: { type: "quay:paid", linkId: "lnk_test_123", link: { id: "lnk_test_123" } },
      origin: window.location.origin,
    });
    window.dispatchEvent(event);

    expect(onPaid).toHaveBeenCalledWith({
      type: "quay:paid",
      linkId: "lnk_test_123",
      link: { id: "lnk_test_123" },
    });

    unsubscribe();
  });

  // ---------------------------------------------------------------------------
  // Host resolution (issue 5.10) - no silent fallback to someone else's deployment.
  // ---------------------------------------------------------------------------

  describe("host resolution", () => {
    it("throws a clear error when no host can be determined - no explicit host and no widget.js script tag", () => {
      expect(() => Quay.open("lnk_test_123")).toThrow(/could not determine which Quay deployment/i);
      // A failed open() must be a true no-op - nothing left in the DOM.
      expect(document.getElementById("quay-checkout-modal")).toBeNull();
    });

    it("does not fall back to https://quay-web.vercel.app or any other hardcoded host", () => {
      try {
        Quay.open("lnk_test_123");
      } catch {
        /* expected */
      }
      expect(document.getElementById("quay-checkout-iframe")).toBeNull();
    });

    it("uses the explicit host option when given, even with no script tag present", () => {
      Quay.open({ linkId: "lnk_test_123", host: TEST_HOST });
      const iframe = document.getElementById("quay-checkout-iframe") as HTMLIFrameElement;
      expect(iframe.src.startsWith(TEST_HOST)).toBe(true);
    });

    it("infers the host from the widget's own script tag when no explicit host is given", () => {
      document.body.innerHTML = `<script src="${TEST_HOST}/widget.js"></script>`;
      Quay.open("lnk_test_123");
      const iframe = document.getElementById("quay-checkout-iframe") as HTMLIFrameElement;
      expect(iframe.src.startsWith(TEST_HOST)).toBe(true);
    });

    it("an explicit host option takes precedence over a detected script tag", () => {
      document.body.innerHTML = `<script src="https://wrong-host.example.com/widget.js"></script>`;
      Quay.open({ linkId: "lnk_test_123", host: TEST_HOST });
      const iframe = document.getElementById("quay-checkout-iframe") as HTMLIFrameElement;
      expect(iframe.src.startsWith(TEST_HOST)).toBe(true);
    });

    it("a failed open() does not disturb a modal that was already open", () => {
      Quay.open({ linkId: "lnk_already_open", host: TEST_HOST });
      expect(document.getElementById("quay-checkout-modal")).not.toBeNull();

      expect(() => Quay.open("lnk_no_host")).toThrow();

      // The original modal, for the original link, is untouched.
      const iframe = document.getElementById("quay-checkout-iframe") as HTMLIFrameElement;
      expect(iframe.src).toContain("lnk_already_open");
    });
  });
});
