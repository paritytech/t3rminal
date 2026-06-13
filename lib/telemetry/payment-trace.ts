"use client";

/**
 * Cross-system payment correlation. A coinage payment id is 32 lowercase hex
 * chars = exactly a Sentry trace_id (16 bytes). By forcing the active trace_id
 * to equal the payment id, every app that handles this payment (terminal,
 * processor, payer) emits spans into ONE Sentry trace — no header propagation
 * (the chain / statement-store is the async channel). See the W3S
 * e2e-payment-correlation design.
 *
 * No-op fallback (a fresh normal trace) when the id isn't a valid 32-hex
 * trace id, so a malformed id never breaks the flow.
 */

import * as Sentry from "@sentry/nextjs";

const HEX32 = /^[0-9a-f]{32}$/;

function randomSpanId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function withPaymentTrace<T>(paymentId: string, fn: () => T): T {
  if (!HEX32.test(paymentId)) return fn();
  return Sentry.continueTrace(
    { sentryTrace: `${paymentId}-${randomSpanId()}-1`, baggage: undefined },
    fn,
  );
}
