/**
 * Sentry edge-runtime init. Same story as the server config — kept so the
 * Next.js + Sentry build plugin doesn't complain. We don't ship edge routes.
 */

import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN ?? "";
const tracesSampleRate = Number(
  process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.0",
);

Sentry.init({
  dsn,
  enabled: dsn.length > 0,
  tracesSampleRate,
});
