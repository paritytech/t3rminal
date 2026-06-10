/**
 * Browser-side Sentry init. Next.js loads this automatically before any app
 * code runs (no manual import needed), so errors thrown during the very first
 * render are captured.
 *
 * Don't move this into a React component — `Sentry.init()` inside a
 * `useEffect` would miss early-render errors and race-condition with other
 * hooks.
 */

import * as Sentry from "@sentry/nextjs";

// ── Suppress Next.js dev-only `missingSlots` Set warning ────────────
//
// Next 16.2.6 always allocates a `Set` for `InitialRSCPayload.m`
// (a.k.a. `missingSlots`) when `process.env.__NEXT_DEV_SERVER` is true —
// see `node_modules/next/dist/esm/server/app-render/app-render.js`
// (`missingSlots = new Set()` ~L919, then `m: missingSlots` ~L1002).
// React 19's stricter RSC serializer then console.errors on every
// navigation:
//
//   "Only plain objects can be passed to Client Components from Server
//    Components. Set objects are not supported."
//
// The Set is empty in this app (we don't use parallel routes / @slots),
// so the warning is pure framework noise. We filter exactly that one
// message — never anything else — and only in dev. Production payloads
// don't include the Set at all, so this code is a no-op there.
//
// IMPORTANT: if you ever introduce parallel routes / named slots, drop
// this filter so you can see real missing-slot warnings again.
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  const FILTER_FLAG = "__t3rminalNextSetFilter" as const;

  const isNextSetWarning = (args: readonly unknown[]): boolean => {
    const first = args[0];
    if (typeof first !== "string") return false;
    if (!first.includes("Only plain objects can be passed to Client Components")) {
      return false;
    }
    // The offending type name may be inlined in the format string OR
    // passed as a separate `%s` substitution argument — accept either.
    if (first.includes("Set objects are not supported")) return true;
    return args.slice(1).some((a) => a === "Set");
  };

  // Install on top of whatever `console.error` exists right now. We may
  // run before Next's `patchConsoleError` (in which case our wrap is
  // first and Next will wrap us); we may run after it (in which case
  // we sit on top of theirs). Re-install across a few task boundaries
  // so we end up on top regardless of timing.
  const install = (): void => {
    const upstream = window.console.error as typeof console.error & {
      [FILTER_FLAG]?: true;
    };
    if (upstream[FILTER_FLAG]) return;
    const filter = ((...args: unknown[]) => {
      if (isNextSetWarning(args)) return;
      return upstream.apply(window.console, args as Parameters<typeof console.error>);
    }) as typeof console.error & { [FILTER_FLAG]?: true };
    filter[FILTER_FLAG] = true;
    window.console.error = filter;
  };

  install();
  queueMicrotask(install);
  setTimeout(install, 0);
  setTimeout(install, 100);
  setTimeout(install, 500);
}

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN ?? "";
const tracesSampleRate = Number(
  process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.0",
);

Sentry.init({
  dsn,
  // Skip network requests entirely when no DSN is configured (e.g. local dev
  // without Sentry credentials). Keeps console clean instead of spamming
  // "no DSN" warnings.
  enabled: dsn.length > 0,
  tracesSampleRate,
  // Drop the browser-tracing and replay integrations. @sentry/nextjs adds
  // browserTracingIntegration via its DEFAULT integrations, so omitting it
  // from an explicit array isn't enough — we filter the merged defaults by
  // name. Manual spans (`Sentry.startSpan`) still work; we just don't
  // auto-instrument pageloads/navigations, and session replay is off entirely.
  integrations: (defaults) =>
    defaults.filter(
      (integration) =>
        integration.name !== "BrowserTracing" && integration.name !== "Replay",
    ),
});

// Required for Next.js App Router navigation instrumentation
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
