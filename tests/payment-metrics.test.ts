import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { recordCoinagePaymentPhase, recordPaymentOutcome } from "@/lib/telemetry/payment-metrics";

const NOW = 5_000;

beforeEach(() => {
  for (const spy of [mocks.startSpan, mocks.startSpanManual, mocks.setMeasurement, mocks.addBreadcrumb, mocks.captureException]) {
    spy.mockClear();
  }
  mocks.fakeSpan.setStatus.mockClear();
  mocks.fakeSpan.end.mockClear();
  vi.spyOn(performance, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordCoinagePaymentPhase", () => {
  it("emits a payment.coinage.<phase> span with rounded phase latency + attributes on success", () => {
    recordCoinagePaymentPhase({
      phase: "host_topup",
      startedAt: NOW - 1234.6,
      paymentId: "sale-1",
      coinCount: 2,
    });

    expect(mocks.startSpanManual).toHaveBeenCalledTimes(1);
    const [opts] = mocks.startSpanManual.mock.calls[0];
    expect(opts.op).toBe("payment.coinage.host_topup");
    expect(opts.name).toBe("coinage:host_topup");
    expect(opts.attributes["coinage.payment_id"]).toBe("sale-1");
    expect(opts.attributes["coinage.coin_count"]).toBe(2);
    expect(opts.attributes["coinage.phase_ms"]).toBe(1235);
    expect(mocks.setMeasurement).toHaveBeenCalledWith("coinage.host_topup_ms", 1235, "millisecond", mocks.fakeSpan);
    expect(mocks.fakeSpan.setStatus).toHaveBeenCalledWith({ code: 1, message: "ok" });
    expect(mocks.fakeSpan.end).toHaveBeenCalledTimes(1);
  });

  it("emits an error status carrying the reason on failure", () => {
    recordCoinagePaymentPhase({
      phase: "statement_wait",
      startedAt: NOW - 50,
      paymentId: "sale-2",
      outcome: "failure",
      reason: "host rejected",
    });

    const [opts] = mocks.startSpanManual.mock.calls[0];
    expect(opts.name).toBe("coinage:statement_wait");
    expect(opts.attributes["coinage.failure_reason"]).toBe("host rejected");
    expect(mocks.fakeSpan.setStatus).toHaveBeenCalledWith({ code: 2, message: "host rejected" });
  });
});

describe("recordPaymentOutcome", () => {
  it("emits a payment.outcome span with a payment.success measurement on success", () => {
    recordPaymentOutcome({ outcome: "success", method: "coins", saleId: "sale-3", amount: "5" });

    expect(mocks.startSpan).toHaveBeenCalledTimes(1);
    const [opts] = mocks.startSpan.mock.calls[0];
    expect(opts.op).toBe("payment.outcome");
    expect(opts.name).toBe("payment:success");
    expect(opts.attributes["payment.method"]).toBe("coins");
    expect(opts.attributes["payment.sale_id"]).toBe("sale-3");
    expect(opts.attributes["payment.amount"]).toBe("5");
    expect(mocks.setMeasurement).toHaveBeenCalledWith("payment.success", 1, "none", mocks.fakeSpan);
    expect(mocks.fakeSpan.setStatus).toHaveBeenCalledWith({ code: 1, message: "ok" });
  });

  it("records payment.success 0 and the failure reason on failure", () => {
    recordPaymentOutcome({ outcome: "failure", method: "voucher", reason: "insufficient funds" });

    const [opts] = mocks.startSpan.mock.calls[0];
    expect(opts.name).toBe("payment:failure");
    expect(opts.attributes["payment.failure_reason"]).toBe("insufficient funds");
    expect(opts.attributes["payment.sad"]).toBe("true");
    expect(mocks.setMeasurement).toHaveBeenCalledWith("payment.success", 0, "none", mocks.fakeSpan);
    expect(mocks.fakeSpan.setStatus).toHaveBeenCalledWith({ code: 2, message: "insufficient funds" });
  });
});
