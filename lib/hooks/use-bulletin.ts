"use client";

import { useState, useCallback } from "react";
import {
  uploadToBulletinChain,
  fetchJsonFromBulletin,
  gatewayUrlForCid,
} from "@/lib/bulletin/client";
import { isSymmetricEncryptedReport, decryptReportSymmetric } from "@/lib/crypto/symmetric-report";
import { loadManualKey } from "@/lib/crypto/manual-key";
import { journeyTracker, captureError, isExpectedError, withSpan, SpanOp } from "@/lib/telemetry";

export interface DailyReportItem {
  name: string;
  quantity: number;
  unitPrice: string;
}

export interface DailyReportTransaction {
  saleId: string;
  status: "Finished" | "Refunded";
  amount: string;
  amountFormatted: string;
  asset: string;
  evmMerchant: string;
  evmCustomer: string;
  txHash: string;
  blockNumber: string;
  timestamp: string;
  timestampFormatted: string;
  terminalId: string;
  refundOf: string | null;
  originalCustomer: string;
  originalMerchant: string;
  originalBlockNumber: string;
  originalBlockHash: string;
  /** Itemized lines when the sale came from /items. */
  items?: DailyReportItem[];
  /** Tip portion of this sale (decimal string). Summed across the report. */
  tip?: string;
}

export interface DailyReport {
  exportDate: string;
  selectedDate: string;
  periodKey?: string;
  periodLabel?: string;
  periodStart?: string;
  periodEnd?: string;
  merchantId?: string;
  merchantName?: string;
  terminalId?: string;
  network: string;
  rpcUrl: string;
  totalTransactions: number;
  dayFinalized: boolean;
  transactions: DailyReportTransaction[];
}

export interface UseBulletinReturn {
  isUploading: boolean;
  isReading: boolean;
  error: string | null;
  uploadDailyReport: (report: DailyReport, precomputedBytes?: Uint8Array) => Promise<{
    cid: string;
    cidHash: string;
    gatewayUrl: string;
    blockHash: string;
    signedBy: string;
  }>;
  readDailyReport: (cid: string) => Promise<DailyReport>;
}

/**
 * Hook for interacting with Bulletin Chain for daily report storage.
 * Uses our custom client (lib/bulletin/client.ts) which auto-resolves:
 * - Uploads: host preimageManager in container, direct WS upload standalone
 * - Reads: host preimage lookup in container, IPFS gateway standalone
 */
export function useBulletin(): UseBulletinReturn {
  const [isUploading, setIsUploading] = useState(false);
  const [isReading, setIsReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uploadDailyReport = useCallback(
    async (report: DailyReport, precomputedBytes?: Uint8Array) => {
      setIsUploading(true);
      setError(null);

      try {
        // When the caller pre-encodes the payload (to derive the CID before the
        // upload completes — see use-daily-report's parallel save path), reuse
        // those exact bytes so the uploaded CID cannot diverge from the one
        // already mirrored on-chain.
        const jsonBytes = precomputedBytes ?? new TextEncoder().encode(JSON.stringify(report, null, 2));

        console.log(`[Bulletin] Uploading daily report for ${report.selectedDate}`);

        const result = await withSpan(
          "bulletin.upload-report",
          SpanOp.IPFS_UPLOAD,
          () => uploadToBulletinChain(jsonBytes),
          { "report.size_bytes": jsonBytes.byteLength },
        );

        console.log("[Bulletin] Upload complete. CID:", result.cid);

        return {
          cid: result.cid,
          cidHash: result.cid,
          gatewayUrl: result.gatewayUrl ?? gatewayUrlForCid(result.cid),
          blockHash: "via-preimage",
          // Real merchant SS58 that signed the extrinsic, not a placeholder.
          signedBy: result.signedBy,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to upload report";
        console.error("[Bulletin] Upload failed:", message);
        setError(message);
        captureError(err, {
          component: "bulletin", phase: "upload-report",
          expected: isExpectedError(message),
        });
        throw err;
      } finally {
        setIsUploading(false);
      }
    },
    []
  );

  const readDailyReport = useCallback(
    async (cid: string): Promise<DailyReport> => {
      setIsReading(true);
      setError(null);
      journeyTracker.start("report-decrypt", { "journey.cid": cid });

      try {
        console.log("[Bulletin] Reading report CID:", cid);
        // IPFS fetch is the slowest step here — track it as its own span so
        // we can see whether gateway latency or decryption is the bottleneck.
        const data = await withSpan(
          "bulletin.fetch-report",
          SpanOp.IPFS_FETCH,
          () => fetchJsonFromBulletin<DailyReport | Record<string, unknown>>(cid),
          { cid },
        );
        journeyTracker.milestone("report-decrypt", "ipfs-fetched");

        // If encrypted with manual passphrase, attempt symmetric decryption
        if (isSymmetricEncryptedReport(data)) {
          console.log("[Bulletin] Report is encrypted, attempting decryption...");
          const key = loadManualKey();
          if (!key) {
            throw new Error(
              "This report is encrypted. Set your decryption key in Settings → Report Encryption.",
            );
          }
          const reportJson = withSpan(
            "bulletin.decrypt-report",
            SpanOp.CRYPTO_DECRYPT,
            () => decryptReportSymmetric(data, key),
          );
          key.fill(0);
          const report = JSON.parse(reportJson) as DailyReport;
          journeyTracker.milestone("report-decrypt", "decrypted");
          journeyTracker.complete("report-decrypt");
          console.log("[Bulletin] Decrypted successfully, date:", report.selectedDate);
          return report;
        }

        const report = data as DailyReport;
        journeyTracker.complete("report-decrypt");
        console.log("[Bulletin] Read successful, date:", report.selectedDate);
        return report;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to read report";
        console.error("[Bulletin] Read failed:", message);
        setError(message);
        journeyTracker.fail("report-decrypt", message);
        captureError(err, { component: "bulletin", phase: "read-report" }, { cid });
        throw err;
      } finally {
        setIsReading(false);
      }
    },
    []
  );

  return {
    isUploading,
    isReading,
    error,
    uploadDailyReport,
    readDailyReport,
  };
}
