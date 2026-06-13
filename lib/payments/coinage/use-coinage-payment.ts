/**
 * W3S Coinage payment — terminal side (Appendix F of "Merchant Payments W3S -
 * Host & Terminal").
 *
 * Per active sale this hook:
 *   1. mints a fresh ephemeral P-256 keypair + payment id,
 *   2. derives topic = blake2b256("pay-w3s:" || id) and exposes the
 *      `polkadotapp://w3spay.dot/pay-w3s` deeplink as `qrValue`,
 *   3. subscribes to the statement store on that topic,
 *   4. on a matching statement: decrypts the "cheque" envelope (ECIES),
 *      validates id + amount, then claims the
 *      bearer coins into the merchant coin set through the host
 *      `paymentTopUp(Coins)` (host-api-wrapper `coins` source).
 *
 * The terminal itself does no on-chain work — the host moves the coins.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import {
  createPaymentManager,
  createStatementStore,
} from "@novasamatech/host-api-wrapper";
import { decryptStatementData } from "./ecies";

import { detectHostEnvironment } from "@/lib/host";
import { generateEphemeralKeypair, generatePaymentId } from "./keys";
import { deriveTopic } from "./topic";
import { buildPayW3sDeeplink, normalizeAmount } from "./deeplink";
import { withSpan, captureWarning, withPaymentTrace } from "@/lib/telemetry";
import { classifyTopupError } from "./topup-error";

function log(message: string): void {
  // Trace the full coinage detection flow in the host devtools console.
  console.log(`[coinage] ${message}`);
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Host errors come back in several shapes: a JS `Error`, a SCALE `CodecError`,
 * or a structured `PaymentTopUpErr` enum (`{ tag, value: { reason } }`). The
 * naive `.message` reads "unknown error" for the enum form, hiding the real
 * cause — so dig out whatever's actually there.
 */
function describeError(err: unknown): string {
  if (err == null) return "null/undefined error";
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    const tag = typeof o.tag === "string" ? o.tag : undefined;
    const value = o.value as Record<string, unknown> | undefined;
    const reason =
      (value && typeof value.reason === "string" && value.reason) ||
      (typeof o.reason === "string" && o.reason) ||
      (typeof o.message === "string" && o.message) ||
      undefined;
    if (tag || reason) return `${tag ?? "Error"}${reason ? `: ${reason}` : ""}`;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

export type CoinageStatus =
  | "idle"
  | "preparing"
  | "waiting"
  | "claiming"
  | "paid"
  | "error";

export interface CoinagePaymentResult {
  /** The payment id minted for this sale. */
  paymentId: string;
  /** Decimal amount (2dp) as carried in the decrypted payload. */
  amount: string;
  /** How many coins were claimed. */
  coinCount: number;
  /** Sender timestamp (ms) from the payload. */
  timestamp: number;
}

export interface UseCoinagePaymentOptions {
  /** Arm the flow (mint keys, show QR, listen) only while true. */
  active: boolean;
  /** Decimal amount from the calculator (normalized internally). */
  amount: string;
  onPaid: (result: CoinagePaymentResult) => void;
}

export interface UseCoinagePayment {
  status: CoinageStatus;
  qrValue: string | null;
  paymentId: string | null;
  error: string | null;
}

export function useCoinagePayment(
  opts: UseCoinagePaymentOptions | null,
): UseCoinagePayment {
  const active = opts?.active ?? false;
  const amount = opts?.amount ?? "";

  const onPaidRef = useRef<UseCoinagePaymentOptions["onPaid"] | undefined>(
    opts?.onPaid,
  );
  onPaidRef.current = opts?.onPaid;

  const [status, setStatus] = useState<CoinageStatus>("idle");
  const [qrValue, setQrValue] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !amount) {
      setStatus("idle");
      setQrValue(null);
      setPaymentId(null);
      setError(null);
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let processed = false;
    let topupAttempts = 0;

    void (async () => {
      try {
        setError(null);
        setStatus("preparing");
        const expectedAmount = normalizeAmount(amount);
        const { privateKey, publicKeyCompressed } =
          await generateEphemeralKeypair();
        const id = generatePaymentId();
        const topic = deriveTopic(id);
        if (cancelled) return;

        setPaymentId(id);
        setQrValue(
          buildPayW3sDeeplink({ id, amount: expectedAmount, publicKeyCompressed }),
        );
        setStatus("waiting");

        const store = createStatementStore();
        const manager = createPaymentManager();

        const env = detectHostEnvironment();
        log(`armed: id=${id} amount=${expectedAmount} topic=0x${toHex(topic)} host=${env}`);
        if (env === "standalone") {
          // The host statement store + paymentTopUp(Coins) are host bridge calls.
          // A standalone browser/PWA (no Polkadot App container) can't reach
          // them, so the subscription below will never fire. Surface it instead
          // of spinning forever. (Detection would need a chain-direct statement
          // source + a self-custody claim path.)
          log(
            "WARNING: not running inside a Polkadot App host — the host statement " +
              "store is unavailable, so incoming W3S payments cannot be detected here.",
          );
          captureWarning("no Polkadot host — coins undetectable", { paymentId: id });
        }

        // The wrapper's subscription can be interrupted by the host (e.g. a
        // reconnect). If that happens we must re-establish it, otherwise the
        // terminal would silently stop listening and spin forever.
        const subscribeOnce = () => {
          const sub = store.subscribe({ matchAny: [topic] }, (page) => {
            if (cancelled || processed) return;
            log(
              `page: ${page.statements.length} statement(s), isComplete=${page.isComplete}`,
            );

            for (const statement of page.statements) {
              const data = statement.data;
              if (!data || data.length === 0) {
                log("  statement has no data — skip");
                continue;
              }

              let payload;
              try {
                ({ payload } = decryptStatementData(privateKey, data));
              } catch (err) {
                // Not ours, or malformed — skip, but say why (a decrypt error
                // here on our own topic usually means a wire-format drift).
                log(
                  `  decrypt failed (len=${data.length}): ${err instanceof Error ? err.message : String(err)}`,
                );
                continue;
              }

              if (payload.id !== id) {
                log(`  id mismatch: got "${payload.id}", want "${id}" — skip`);
                continue;
              }
              if (normalizeAmount(payload.amount) !== expectedAmount) {
                log(
                  `  amount mismatch: got "${payload.amount}", want "${expectedAmount}" — skip`,
                );
                continue;
              }

              processed = true;
              setStatus("claiming");
              const claimed = payload;
              const coinLens = claimed.coins.map((c) => c.length).join(",");
              log(
                `  match! claiming ${claimed.coins.length} coin(s) [byte lengths: ${coinLens}] via paymentTopUp(Coins)`,
              );

              void (async () => {
                topupAttempts += 1;
                if (topupAttempts > 1) {
                  captureWarning("topUp retry — possible duplicate", {
                    paymentId: id, attempt: topupAttempts,
                  });
                }
                try {
                  // trace_id = payment id ⇒ this claim correlates cross-system
                  // (payer / processor) in one Sentry trace. See e2e-correlation design.
                  await withPaymentTrace(id, () =>
                    withSpan(
                      "coinage topUp",
                      "payment.coinage.topup",
                      () => manager.topUp(0n, { type: "coins", keys: claimed.coins }),
                      {
                        "topup.attempt": String(topupAttempts),
                        "payment.id": id,
                        "payment.topic": toHex(topic),
                        "pay.role": "terminal",
                        "pay.phase": "claimed",
                      },
                    ),
                  );
                  if (cancelled) return;
                  log("  claim ok — paid");
                  setStatus("paid");
                  onPaidRef.current?.({
                    paymentId: id, amount: claimed.amount,
                    coinCount: claimed.coins.length, timestamp: Number(claimed.timestamp),
                  });
                } catch (err) {
                  if (cancelled) return;
                  processed = false;
                  const detail = describeError(err);
                  log(`  claim FAILED: ${detail}`);
                  console.error("[coinage] raw topUp error:", err);
                  captureWarning(`topUp failed: ${classifyTopupError(err)}`, { paymentId: id, attempt: topupAttempts });
                  setStatus("error");
                  setError(detail);
                }
              })();

              break;
            }
          });

          // Re-arm if the host drops the subscription before we're done.
          sub.onInterrupt?.(() => {
            if (cancelled || processed) return;
            log("subscription interrupted by host — re-subscribing");
            captureWarning("statement subscription interrupted — host drop", { paymentId: id });
            unsubscribe = subscribeOnce();
          });

          return () => sub.unsubscribe();
        };

        unsubscribe = subscribeOnce();
        log("listening on statement store…");
      } catch (err) {
        if (cancelled) return;
        const detail = describeError(err);
        log(`setup FAILED: ${detail}`);
        console.error("[coinage] raw setup error:", err);
        setStatus("error");
        setError(detail);
      }
    })();

    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
  }, [active, amount]);

  return { status, qrValue, paymentId, error };
}
