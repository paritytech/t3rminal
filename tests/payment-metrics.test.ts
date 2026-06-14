import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const fakeSpan = { setStatus: vi.fn(), setAttributes: vi.fn(), end: vi.fn() };
  type SpanOpts = {
    name: string;
    op: string;
    attributes: Record<string, string | number | boolean>;
    startTime?: number;
  };
  return {
    fakeSpan,
    startSpan: vi.fn((_opts: SpanOpts, cb: (span: typeof fakeSpan) => unknown) => cb(fakeSpan)),
    startSpanManual: vi.fn((_opts: SpanOpts, cb: (span: typeof fakeSpan) => unknown) => cb(fakeSpan)),
    setMeasurement: vi.fn(),
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
  };
});

vi.mock("@sentry/nextjs", () => ({
  startSpan: mocks.startSpan,
  startSpanManual: mocks.startSpanManual,
  setMeasurement: mocks.setMeasurement,
  addBreadcrumb: mocks.addBreadcrumb,
  captureException: mocks.captureException,
}));

import { recordCoinageClaim, recordPaymentOutcome } from "@/lib/telemetry/payment-metrics";

beforeEach(() => {
  for (const spy of [mocks.startSpan, mocks.startSpanManual, mocks.setMeasurement, mocks.addBreadcrumb, mocks.captureException]) {
    spy.mockClear();
  }
  mocks.fakeSpan.setStatus.mockClear();
});

describe("recordCoinageClaim", () => {
  it("emits a payment.claim span with rounded duration + attributes on success", () => {
    recordCoinageClaim({ paymentId: "sale-1", coinCount: 2, durationMs: 1234.6, outcome: "claimed" });

    expect(mocks.startSpan).toHaveBeenCalledTimes(1);
    const [opts] = mocks.startSpan.mock.calls[0];
    expect(opts.op).toBe("payment.claim");
    expect(opts.name).toBe("claim:claimed");
    expect(opts.attributes["payment.sale_id"]).toBe("sale-1");
    expect(opts.attributes["payment.coin_count"]).toBe(2);
    expect(mocks.setMeasurement).toHaveBeenCalledWith("claim.duration", 1235, "millisecond", mocks.fakeSpan);
    expect(mocks.fakeSpan.setStatus).toHaveBeenCalledWith({ code: 1, message: "ok" });
  });

  it("emits an error status carrying the reason on failure", () => {
    recordCoinageClaim({ paymentId: "sale-2", coinCount: 1, durationMs: 50, outcome: "failed", reason: "host rejected" });

    const [opts] = mocks.startSpan.mock.calls[0];
    expect(opts.name).toBe("claim:failed");
    expect(opts.attributes["payment.failure_reason"]).toBe("host rejected");
    expect(mocks.fakeSpan.setStatus).toHaveBeenCalledWith({ code: 2, message: "host rejected" });
  });
});

describe("recordPaymentOutcome — coin count + duration", () => {
  it("carries payment.coin_count and a rounded payment.duration when provided", () => {
    recordPaymentOutcome({ outcome: "success", method: "coins", coinCount: 3, durationMs: 4321.4 });

    const [opts] = mocks.startSpan.mock.calls[0];
    expect(opts.attributes["payment.coin_count"]).toBe(3);
    expect(mocks.setMeasurement).toHaveBeenCalledWith("payment.duration", 4321, "millisecond", mocks.fakeSpan);
  });

  it("omits payment.coin_count and never measures payment.duration when neither is supplied", () => {
    recordPaymentOutcome({ outcome: "success", method: "voucher" });

    const [opts] = mocks.startSpan.mock.calls[0];
    expect(opts.attributes["payment.coin_count"]).toBeUndefined();
    expect(mocks.setMeasurement).not.toHaveBeenCalledWith(
      "payment.duration",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});
