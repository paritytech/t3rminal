/**
 * Report-path warmup — pulls the slow, once-per-session host work OFF the
 * report critical path.
 *
 * The first report of a session used to pay all of this inline, while the
 * merchant watched a spinner:
 *  - `claimDefaultAllowances()` — host allowance modal + on-chain claim tx(s).
 *    On Android the host treats an explicit request as INCREASE and submits a
 *    claim every session; the Bulletin grant additionally propagates
 *    cross-chain (People → Bulletin, up to ~30–60s on mobile hosts).
 *  - `ensurePreimageSubmitPermission()` — host permission prompt; without it
 *    the preimage submit is silently dropped and the upload hangs.
 *  - `getAPI()` — cold Asset Hub connection through the host bridge.
 *
 * Calling `warmUpReportPath()` when the merchant ENTERS the reports screen
 * runs all of that during think-time instead. Everything here is:
 *  - fire-and-forget: never throws, never blocks the caller;
 *  - idempotent: the underlying calls memoize per page lifetime, and the
 *    report pipeline still awaits the same (by then settled) promises as its
 *    safety net — a failed or skipped warmup degrades to exactly the old
 *    inline behavior, never to a broken report;
 *  - retryable: a failed warmup clears its guard so the next screen entry
 *    tries again.
 */

"use client";

import { isInHost } from "@/lib/host/detect";

let allowancesWarmStarted = false;
let chainWarmStarted = false;

export function warmUpReportPath(): void {
  if (!isInHost()) return;

  // Allowances + preimage permission (may surface host prompts — hosts
  // serialize their own prompt queue, so firing both is safe).
  if (!allowancesWarmStarted) {
    allowancesWarmStarted = true;
    void (async () => {
      try {
        const { claimDefaultAllowances, ensurePreimageSubmitPermission } = await import(
          "@/lib/host/allowances"
        );
        await claimDefaultAllowances();
        await ensurePreimageSubmitPermission();
        console.log("[warmup] allowances + preimage permission ready");
      } catch (err) {
        // Non-fatal by design: the report pipeline re-awaits the same memoized
        // calls (whose caches self-clear on failure), so it prompts again
        // inline exactly as before this warmup existed.
        allowancesWarmStarted = false;
        console.warn("[warmup] allowance warmup failed (report flow will retry inline):", err);
      }
    })();
  }

  // Asset Hub client — pre-open the host-bridge chain connection so the
  // report job's first read doesn't pay the cold connect.
  if (!chainWarmStarted) {
    chainWarmStarted = true;
    void (async () => {
      try {
        const { getAPI } = await import("@/lib/contracts/chain");
        await getAPI();
        console.log("[warmup] Asset Hub client connected");
      } catch (err) {
        chainWarmStarted = false;
        console.warn("[warmup] chain client warmup failed (report flow will connect inline):", err);
      }
    })();
  }
}
