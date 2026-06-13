/**
 * Telemetry barrel — consume from `@/lib/telemetry`, not from the internal
 * files. Keeps Sentry imports centralized so swapping providers later is
 * a one-file change.
 */

export { journeyTracker, JourneyTracker } from "./journey-tracker";
export type { AppJourneyType } from "./journey-tracker";
export { withSpan, breadcrumb, captureError, captureWarning, isExpectedError } from "./sentry-helpers";
export { withPaymentTrace } from "./payment-trace";
export {
  recordPaymentOutcome,
  recordFinalizationLatency,
} from "./payment-metrics";
export type {
  PaymentMethodKind,
  PaymentOutcomeParams,
  FinalizationLatencyParams,
} from "./payment-metrics";
export { SpanOp } from "./span-ops";
export type { SpanOpValue } from "./span-ops";
