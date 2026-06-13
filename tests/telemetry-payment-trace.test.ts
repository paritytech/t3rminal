import { describe, expect, it, vi } from "vitest";

const continueTraceCalls: Array<{ sentryTrace: string }> = [];
vi.mock("@sentry/nextjs", () => ({
  continueTrace: (opts: { sentryTrace: string }, fn: () => unknown) => {
    continueTraceCalls.push(opts);
    return fn();
  },
}));

import { withPaymentTrace } from "@/lib/telemetry/payment-trace";

describe("withPaymentTrace", () => {
  it("forces trace_id to the 32-hex payment id and runs fn", () => {
    const id = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
    const r = withPaymentTrace(id, () => "done");
    expect(r).toBe("done");
    const last = continueTraceCalls.at(-1)!;
    expect(last.sentryTrace.startsWith(`${id}-`)).toBe(true);
  });

  it("runs fn directly (no continueTrace) for a non-32-hex id", () => {
    const before = continueTraceCalls.length;
    const r = withPaymentTrace("not-hex", () => 42);
    expect(r).toBe(42);
    expect(continueTraceCalls.length).toBe(before);
  });
});
