/**
 * Sentry server-side init. With `output: 'export'` we don't ship a Node
 * server, but the file is required by `@sentry/nextjs` so the dev build
 * pipeline doesn't warn. Production deploys never execute this.
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
