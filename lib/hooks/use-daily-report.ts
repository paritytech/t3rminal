"use client";

import { useState, useCallback } from "react";
import { useBulletin, type DailyReport } from "./use-bulletin";
import { activeNetwork } from "@/lib/contracts/config";
import { addDailyReport, getSalesForMerchantByDate } from "@/lib/storage/database";
import type { SaleRecord } from "@/lib/storage/types";
import { isInHost } from "@/lib/host/detect";
import { getHostAccounts } from "@/lib/host/accounts";
import {
  storeDailyReportViaRevive,
  getMerchantTerminal,
  getMetadataViaRevive,
} from "@/lib/contracts/revive-bulletin-index";
import { useAccount } from "@/lib/web3";
import { calculateCID } from "@/lib/bulletin/cid";
import { loadManualKey, manualKeyFingerprint } from "@/lib/crypto/manual-key";
import { encryptReportSymmetric } from "@/lib/crypto/symmetric-report";
import { journeyTracker, captureError, isExpectedError } from "@/lib/telemetry";
import { loadAdminQrPayload } from "@/lib/config/admin-qr";
import { isOnchainIndexingEnabled } from "@/lib/config/onchain-indexing";
import type { T3rminalConfigQrPayloadV2 } from "@/lib/config/t3rminal-config-qr";

/**
 * Hard ceiling on a whole save/finalize run so the UI never spins forever — if
 * the bulletin upload or the on-chain submit hangs past this, the run rejects
 * with a clear timeout and the spinner clears. (The on-chain submit also has its
 * own 120s inclusion watchdog; this is the outer backstop across all steps.)
 */
const REPORT_TIMEOUT_MS = 180_000;

function withReportTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${Math.round(REPORT_TIMEOUT_MS / 1000)}s — please try again.`)),
        REPORT_TIMEOUT_MS,
      ),
    ),
  ]);
}

/** Cap for the finalized pre-check read — a host-bridge read can hang, and a
 *  hung ADVISORY check must not stall the pipeline (it is skipped on timeout,
 *  matching the existing skip-on-read-failure behavior). */
const PRECHECK_TIMEOUT_MS = 8_000;

function raceTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export interface FinalizeDayResult {
  report: DailyReport;
  cid: string;
  gatewayUrl: string;
  bulletinBlockHash: string;
  signedBy: string;
  onChainIndexed: boolean;
  /** Whether this write locked the day on-chain (finalize) or left it open. */
  finalized: boolean;
}

export type FinalizePhase =
  | "idle"
  | "generating"
  | "encrypting"
  | "uploading"
  | "submitting-onchain"
  | "saving-local"
  | "done";

// User-facing copy stays generic per Parity Product Tenet 10 — no chain
// jargon, no "on-chain", no "sign on phone". Detailed phase information is
// still emitted to console.log for developers.
const PHASE_LABELS: Record<FinalizePhase, string> = {
  idle: "",
  generating: "Finalizing…",
  encrypting: "Finalizing…",
  uploading: "Saving…",
  "submitting-onchain": "Saving…",
  "saving-local": "Saving…",
  done: "Done",
};

export interface UseDailyReportReturn {
  isGenerating: boolean;
  isUploading: boolean;
  isFinalizing: boolean;
  phase: FinalizePhase;
  phaseLabel: string;
  error: string | null;
  generateReport: (date: string, merchantAddress: string, finalize?: boolean) => Promise<DailyReport>;
  generateReportForSales: (args: PeriodReportArgs) => Promise<DailyReport>;
  uploadReport: (report: DailyReport) => Promise<{
    cid: string;
    cidHash: string;
    gatewayUrl: string;
    blockHash: string;
  }>;
  /**
   * Build + upload a report for `date` and mirror its CID locally and on-chain,
   * leaving the day OPEN (repeatable — overwrites the prior CID).
   */
  saveDailyReport: (date: string, merchantAddress: string) => Promise<FinalizeDayResult>;
  savePeriodReport: (args: PeriodReportArgs) => Promise<FinalizeDayResult>;
  /**
   * Same pipeline as `saveDailyReport`, but LOCKS the day on-chain. After this
   * the contract rejects any further write to (merchantId, terminalId, date).
   */
  finalizeDailyReport: (date: string, merchantAddress: string) => Promise<FinalizeDayResult>;
  finalizePeriodReport: (args: PeriodReportArgs) => Promise<FinalizeDayResult>;
}

export interface PeriodReportArgs {
  date: string;
  periodKey: string;
  merchantAddress: string;
  sales: SaleRecord[];
  periodStart?: Date;
  periodLabel?: string;
}

/**
 * Get sales from host storage for a specific date and merchant
 */
async function getSalesForDate(date: string, merchantAddressNormalized: string): Promise<SaleRecord[]> {
  const dayStart = new Date(date + "T00:00:00");
  const dayEnd = new Date(date + "T23:59:59.999");
  return getSalesForMerchantByDate(merchantAddressNormalized, dayStart, dayEnd);
}

function buildDailyReportFromSales(args: {
  date: string;
  periodKey?: string;
  sales: SaleRecord[];
  merchantAddress: string;
  finalize: boolean;
  adminPayload: T3rminalConfigQrPayloadV2 | null;
  periodStart?: Date;
  periodLabel?: string;
}): DailyReport {
  const terminalId = args.adminPayload?.terminalId ?? "T3RMINAL";
  const sortedSales = [...args.sales].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  return {
    exportDate: new Date().toISOString(),
    selectedDate: args.date,
    periodKey: args.periodKey,
    periodLabel: args.periodLabel,
    periodStart: args.periodStart?.toISOString(),
    periodEnd: sortedSales.at(-1)
      ? new Date(sortedSales.at(-1)!.timestamp).toISOString()
      : undefined,
    merchantId: args.adminPayload?.merchantId,
    merchantName: args.adminPayload?.profile?.name ?? args.adminPayload?.displayName,
    terminalId,
    network: activeNetwork.name,
    rpcUrl: activeNetwork.rpcUrl,
    totalTransactions: sortedSales.length,
    dayFinalized: args.finalize,
    transactions: sortedSales.map((sale: SaleRecord) => ({
      saleId: sale.saleId,
      status: "Finished" as const,
      amount: sale.amountPlanck || "0",
      amountFormatted: sale.amount,
      asset: sale.asset,
      evmMerchant: sale.merchantAddress,
      evmCustomer: sale.customerAddress,
      txHash: sale.transactionHash || "",
      blockNumber: sale.blockNumber?.toString() || "0",
      timestamp: new Date(sale.timestamp).getTime().toString(),
      timestampFormatted: new Date(sale.timestamp).toISOString(),
      terminalId,
      refundOf: null,
      originalCustomer: sale.customerAddress,
      originalMerchant: sale.merchantAddress,
      originalBlockNumber: sale.blockNumber?.toString() || "0",
      originalBlockHash: sale.blockHash || "",
      items: sale.items,
      tip: sale.tip,
    })),
  };
}

/**
 * Hook for generating and uploading daily reports to Bulletin Chain
 * CID is stored locally in IndexedDB instead of on-chain BulletinIndex contract
 */
// Dev-facing labels — only console.log, never shown in UI.
const PHASE_DEV_LABELS: Record<FinalizePhase, string> = {
  idle: "idle",
  generating: "generating report",
  encrypting: "encrypting for recipients",
  uploading: "uploading to bulletin",
  "submitting-onchain": "submitting on-chain",
  "saving-local": "saving locally",
  done: "done",
};

export function useDailyReport(): UseDailyReportReturn {
  const [isGenerating, setIsGenerating] = useState(false);
  const [phase, setPhaseRaw] = useState<FinalizePhase>("idle");
  const [error, setError] = useState<string | null>(null);

  // Wrap setPhase so the developer-facing step name still appears in console
  // (useful for support / debugging) while the UI shows only a generic label.
  const setPhase = (next: FinalizePhase) => {
    console.log(`[DailyReport] phase → ${PHASE_DEV_LABELS[next]}`);
    setPhaseRaw(next);
  };

  const { uploadDailyReport, isUploading } = useBulletin();
  const { account } = useAccount();

  /**
   * Generate daily report from localStorage data
   */
  const generateReport = useCallback(
    async (date: string, merchantAddress: string, finalize = false): Promise<DailyReport> => {
      setIsGenerating(true);
      setError(null);

      try {
        const [sales, adminPayload] = await Promise.all([
          getSalesForDate(date, merchantAddress),
          loadAdminQrPayload(),
        ]);
        const report = buildDailyReportFromSales({
          date,
          periodKey: date,
          sales,
          merchantAddress,
          finalize,
          adminPayload,
        });

        return report;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to generate report";
        setError(message);
        throw err;
      } finally {
        setIsGenerating(false);
      }
    },
    []
  );

  const generateReportForSales = useCallback(
    async (args: PeriodReportArgs): Promise<DailyReport> => {
      setIsGenerating(true);
      setError(null);

      try {
        const adminPayload = await loadAdminQrPayload();
        return buildDailyReportFromSales({
          date: args.date,
          periodKey: args.periodKey,
          sales: args.sales,
          merchantAddress: args.merchantAddress,
          finalize: false,
          adminPayload,
          periodStart: args.periodStart,
          periodLabel: args.periodLabel,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to generate report";
        setError(message);
        throw err;
      } finally {
        setIsGenerating(false);
      }
    },
    [],
  );

  /**
   * Upload report to Bulletin Chain
   */
  const uploadReport = useCallback(
    async (report: DailyReport) => {
      setError(null);
      try {
        return await uploadDailyReport(report);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to upload report";
        setError(message);
        throw err;
      }
    },
    [uploadDailyReport]
  );

  /**
   * Shared report pipeline:
   * 1. Generate report from localStorage data
   * 2. Encrypt (if a manual key is set)
   * 3. Upload to Bulletin Chain
   * 4. Mirror CID on-chain via contract (gated by the on-chain toggle), with
   *    `finalize` deciding whether the day is locked
   * 5. Store CID locally in IndexedDB
   *
   * `saveDailyReport` (finalize=false) is repeatable and overwrites the day's
   * CID; `finalizeDailyReport` (finalize=true) locks it.
   */
  const runReport = useCallback(
    async (
      date: string,
      merchantAddress: string,
      finalize: boolean,
      period?: Omit<PeriodReportArgs, "date" | "merchantAddress">,
    ): Promise<FinalizeDayResult> => {
      setError(null);
      setPhase("generating");
      const reportKey = period?.periodKey ?? date;

      const journey = finalize ? "daily-report-finalize" : "daily-report-save";
      journeyTracker.start(journey, {
        "journey.date": reportKey,
        "journey.terminal": merchantAddress.slice(0, 12),
      });

      try {
        const result = await withReportTimeout((async (): Promise<FinalizeDayResult> => {
        // Identity that scopes the on-chain slot + tags the local record.
        const adminPayload = await loadAdminQrPayload();
        const terminalId = adminPayload?.terminalId ?? "T3RMINAL";
        const merchantId = adminPayload?.merchantId ?? "";

        // On-chain indexing gate — resolved once, reused for the pre-check and
        // the mirror step below.
        const onchainEnabled = await isOnchainIndexingEnabled();

        // Pre-flight: a finalized slot is immutable. The contract rejects any
        // further write, which makes the on-chain submit revert and the watcher
        // hang. Detect it up front and fail fast with a clear message — covers
        // both "save X over a closed day" and "re-run Z".
        //
        // Started here but awaited only AFTER generate/encrypt, so the read
        // round-trip overlaps the local work instead of preceding it. Capped at
        // PRECHECK_TIMEOUT_MS — on timeout/read failure the check is skipped
        // (advisory), exactly like the previous skip-on-read-failure behavior.
        const finalizedPreCheck: Promise<void> = (async () => {
          if (!(onchainEnabled && isInHost() && merchantId)) return;
          try {
            const meta = await raceTimeout(
              getMetadataViaRevive(merchantId, terminalId, reportKey),
              PRECHECK_TIMEOUT_MS,
              "finalized pre-check",
            );
            if (meta.exists && meta.finalized) {
              throw new Error(
                finalize
                  ? "This report is already finalized — it can't be closed again."
                  : "This report is already finalized and can no longer be updated.",
              );
            }
          } catch (err) {
            // Re-throw our own guard; a read failure must not block saving.
            if (err instanceof Error && /already finalized/.test(err.message)) throw err;
            console.warn("[DailyReport] finalized pre-check skipped (read failed):", err);
          }
        })();
        // The real rejection is consumed at the `await` below; this no-op
        // handler only prevents an "unhandled rejection" if generate/encrypt
        // throws first and the await is never reached.
        finalizedPreCheck.catch(() => {});

        // 1. Generate report from localStorage or an explicit period slice.
        const report = period
          ? buildDailyReportFromSales({
              date,
              periodKey: reportKey,
              sales: period.sales,
              merchantAddress,
              finalize,
              adminPayload,
              periodStart: period.periodStart,
              periodLabel: period.periodLabel,
            })
          : await generateReport(date, merchantAddress, finalize);
        journeyTracker.milestone(journey, "report-generated");
        journeyTracker.addAttributes(journey, {
          "journey.tx_count": report.totalTransactions,
        });

        if (report.totalTransactions === 0) {
          throw new Error("Cannot build a report for a day with no transactions");
        }

        // 2. Encrypt with the manually configured passphrase, if set
        let reportToUpload: DailyReport | object = report;
        const manualKey = loadManualKey();
        if (manualKey) {
          setPhase("encrypting");
          const fp = manualKeyFingerprint() ?? "";
          reportToUpload = encryptReportSymmetric(
            JSON.stringify(report),
            manualKey,
            {
              date: reportKey,
              txCount: report.totalTransactions,
              terminal: merchantAddress.slice(0, 12),
              keyFingerprint: fp,
            },
          );
          manualKey.fill(0);
          journeyTracker.milestone(journey, "encrypted");
          console.log(`[DailyReport] Encrypted with manual key (fp=${fp})`);
        } else {
          console.log("[DailyReport] No manual key set — uploading plaintext");
        }

        // Fail fast on a finalized slot before spending any chain time (the
        // read has been overlapping generate/encrypt since the start).
        await finalizedPreCheck;

        // 3+4. Upload to Bulletin AND mirror the CID on-chain.
        //
        // The CID is content-derived (blake2b of the exact upload bytes — see
        // lib/bulletin/cid.ts), so it is known BEFORE the upload completes and
        // the two legs are independent:
        //
        //  - save (finalize=false): run them in PARALLEL — wall time becomes
        //    max(upload, on-chain) instead of the sum. Failure matrix:
        //      upload ok  + revive ok   → fully indexed (as before)
        //      upload ok  + revive fail → non-critical, onChainIndexed=false
        //                                 (identical to the sequential path)
        //      upload fail + revive ok  → job throws, local record NOT saved;
        //                                 the slot is NOT finalized, so the
        //                                 next successful save overwrites the
        //                                 dangling CID (content-addressed and
        //                                 repeatable — no data loss)
        //      both fail                → job throws with the upload error
        //
        //  - finalize (Z): SEQUENTIAL, upload first. Reports embed exportDate,
        //    so a re-run produces different bytes → a different CID. If we
        //    locked the slot before Bulletin confirmed the content and the
        //    upload then failed permanently, the locked CID could become
        //    unresolvable forever. Never lock ahead of confirmed content.
        setPhase("uploading");
        const uploadBytes = new TextEncoder().encode(JSON.stringify(reportToUpload, null, 2));
        const expectedCid = calculateCID(uploadBytes);

        // On-chain mirror leg (step 4). Gated by Settings → On-chain indexing
        // (on by default) and a merchant+terminal identity. Never rejects —
        // on-chain indexing is non-critical by design and every failure is
        // contained here (warn + Sentry), exactly like the previous
        // sequential implementation.
        const runReviveMirror = async (): Promise<boolean> => {
          if (!(onchainEnabled && isInHost() && account?.address)) return false;
          try {
            if (!merchantId) {
              throw new Error("No merchantId in config — scan an admin QR to enable on-chain indexing.");
            }
            const hostAccounts = await getHostAccounts();
            const hostAccount = hostAccounts.find((ha) => ha.address === account.address);
            if (!hostAccount) return false;

            await storeDailyReportViaRevive(
              hostAccount.address,
              hostAccount.polkadotSigner,
              {
                merchantId,
                terminalId,
                date: reportKey,
                cid: expectedCid,
                entryCount: report.totalTransactions,
                finalize,
              },
              setPhase
            );
            journeyTracker.milestone(journey, "on-chain-indexed");
            return true;
          } catch (err) {
            console.warn("[DailyReport] On-chain indexing failed (non-critical):", err);
            captureError(err, {
              component: "daily-report",
              phase: "on-chain-index",
              severity: "non-critical",
            });
            return false;
          }
        };

        let uploadResult: Awaited<ReturnType<typeof uploadDailyReport>>;
        let onChainIndexed = false;

        if (finalize) {
          // Z report: the upload must confirm before the slot is locked.
          uploadResult = await uploadDailyReport(reportToUpload as DailyReport, uploadBytes);
          journeyTracker.milestone(journey, "ipfs-uploaded");
          onChainIndexed = await runReviveMirror();
        } else {
          // X report: both legs in flight at once. allSettled so neither
          // leg's rejection can mask the other's outcome (runReviveMirror
          // never rejects by construction, but defend against surprises).
          const [uploadOutcome, mirrorOutcome] = await Promise.allSettled([
            uploadDailyReport(reportToUpload as DailyReport, uploadBytes),
            runReviveMirror(),
          ]);
          onChainIndexed = mirrorOutcome.status === "fulfilled" ? mirrorOutcome.value : false;
          if (uploadOutcome.status === "rejected") throw uploadOutcome.reason;
          uploadResult = uploadOutcome.value;
          journeyTracker.milestone(journey, "ipfs-uploaded");
        }

        // Invariant: the uploaded CID must equal the one mirrored on-chain —
        // guaranteed by handing the same bytes to both legs. If this ever
        // fires, something fundamental drifted (encoder/CID codec change).
        if (uploadResult.cid !== expectedCid) {
          captureError(
            new Error(`CID mismatch: uploaded ${uploadResult.cid} vs indexed ${expectedCid}`),
            { component: "daily-report", phase: "cid-invariant" },
          );
          console.error(`[DailyReport] CID mismatch — uploaded ${uploadResult.cid}, indexed ${expectedCid}`);
        }

        // 5. Store CID locally in IndexedDB
        setPhase("saving-local");
        await addDailyReport({
          date: reportKey,
          cid: uploadResult.cid,
          gatewayUrl: uploadResult.gatewayUrl,
          bulletinBlockHash: uploadResult.blockHash,
          entryCount: report.totalTransactions,
          merchantAddress,
          terminalId,
          finalized: finalize,
          signedBy: uploadResult.signedBy,
          publishedAt: new Date(),
          periodClosedAt: finalize ? report.periodEnd ?? new Date().toISOString() : undefined,
        });
        journeyTracker.milestone(journey, "saved-local");

        console.log(`[DailyReport] ${finalize ? "Finalized" : "Saved"} ${reportKey}: ${report.totalTransactions} tx, CID: ${uploadResult.cid.slice(0, 20)}..., on-chain: ${onChainIndexed}`);
        setPhase("done");
        journeyTracker.complete(journey);

        return {
          report,
          cid: uploadResult.cid,
          gatewayUrl: uploadResult.gatewayUrl,
          bulletinBlockHash: uploadResult.blockHash,
          signedBy: uploadResult.signedBy,
          onChainIndexed,
          finalized: finalize,
        };
        })(), finalize ? "Closing report" : "Saving report");
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to save report";
        console.error("[DailyReport] Report pipeline failed:", message);
        setError(message);
        setPhase("idle");
        journeyTracker.fail(journey, message);
        captureError(
          err,
          { component: "daily-report", phase: finalize ? "finalize" : "save",
            expected: isExpectedError(message) },
          { date }
        );
        throw err;
      }
    },
    [generateReport, uploadDailyReport, account?.address]
  );

  const saveDailyReport = useCallback(
    (date: string, merchantAddress: string) => runReport(date, merchantAddress, false),
    [runReport]
  );

  const savePeriodReport = useCallback(
    (args: PeriodReportArgs) =>
      runReport(args.date, args.merchantAddress, false, {
        periodKey: args.periodKey,
        sales: args.sales,
        periodStart: args.periodStart,
        periodLabel: args.periodLabel,
      }),
    [runReport],
  );

  const finalizeDailyReport = useCallback(
    (date: string, merchantAddress: string) => runReport(date, merchantAddress, true),
    [runReport]
  );

  const finalizePeriodReport = useCallback(
    (args: PeriodReportArgs) =>
      runReport(args.date, args.merchantAddress, true, {
        periodKey: args.periodKey,
        sales: args.sales,
        periodStart: args.periodStart,
        periodLabel: args.periodLabel,
      }),
    [runReport],
  );

  const isActive = phase !== "idle" && phase !== "done";

  return {
    isGenerating,
    isUploading,
    isFinalizing: isGenerating || isUploading || isActive,
    phase,
    phaseLabel: PHASE_LABELS[phase],
    error,
    generateReport,
    generateReportForSales,
    uploadReport,
    saveDailyReport,
    savePeriodReport,
    finalizeDailyReport,
    finalizePeriodReport,
  };
}
