"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Loader2,
  FileText,
  ExternalLink,
  Calendar,
  Clock,
  X,
  Download,
  Save,
  Lock,
  Printer,
} from "lucide-react";
import { BottomNav } from "@/components/bottom-nav";
import {
  getAllDailyReports,
  getSalesForMerchantByDate,
} from "@/lib/storage/database";
import { normalizeToAssetHubAddress } from "@/lib/utils/address";
import type { SaleRecord } from "@/lib/storage/types";
import { onStorageChange } from "@/lib/storage/host-storage";
import { useBulletin, type DailyReport, type DailyReportTransaction } from "@/lib/hooks/use-bulletin";
import { type PeriodReportArgs } from "@/lib/hooks/use-daily-report";
import { useReportJob } from "@/lib/components/report-job-provider";
import { useReceiptGenerator } from "@/lib/hooks/use-receipt-generator";
import { useAccount } from "@/lib/web3";
import { useAdminQrPayload } from "@/lib/config/admin-qr";
import { useAssetSymbol } from "@/lib/utils/asset-metadata";
import type { DailyReportRecord } from "@/lib/storage/types";
import { isHostPrinterAvailable, printHostDocument, type PrintDocumentKind } from "@/lib/host/printing";
import { buildReportPrintDocument } from "@/lib/receipts/thermal-print";
import { warmUpReportPath } from "@/lib/host/warmup";

export default function DailyReportsPage() {
  const symbol = useAssetSymbol();
  const { readDailyReport } = useBulletin();
  const { generateSvgReceipt } = useReceiptGenerator();
  // Report jobs run in the root-level provider so save/finalize keeps going in
  // the background — leaving this page no longer interrupts an in-flight report.
  const {
    runSavePeriod,
    runFinalizePeriod,
    generateReportForSales,
    activeJob,
    isRunning,
    phaseLabel,
    error: reportActionError,
  } = useReportJob();
  const { account } = useAccount();
  const adminPayload = useAdminQrPayload();
  // Match `useSalesHistory` — admin-configured payout address wins so reports
  // use the sales saved by the terminal under that identity.
  const merchantIdentity = adminPayload?.receivingAddress ?? account?.address;

  // Pre-warm the slow host paths (allowance claims, preimage permission, cold
  // Asset Hub connection) while the merchant is still browsing — so the first
  // save/finalize of the session doesn't pay them inline. Fire-and-forget and
  // idempotent; the report pipeline keeps its own inline awaits as the safety
  // net, so a failed warmup can't break anything.
  useEffect(() => {
    warmUpReportPath();
  }, []);

  // Open report (from a past day) pending finalize confirmation.
  const [confirmFinalizeEntry, setConfirmFinalizeEntry] = useState<DailyReportRecord | null>(null);
  const [confirmFinalizeTarget, setConfirmFinalizeTarget] = useState<PeriodReportArgs | null>(null);

  // Finalize (lock) an open report saved on a previous day. The top panel only
  // handles today's current period, so this reconstructs the period's sale
  // slice — that day's sales after the last finalized period of the same day —
  // and locks the matching on-chain slot, so a "#" period (or a plain day) left
  // open when the day rolled over can still be closed. Re-deriving the slice
  // (rather than re-reading the whole day) keeps earlier finalized periods from
  // being double-counted. The actual finalize runs in the background provider.
  const runFinalizePastEntry = async (entry: DailyReportRecord) => {
    if (!merchantIdentity || isRunning) return;
    const merchant = normalizeToAssetHubAddress(merchantIdentity);
    const day = entry.date.split("#")[0] ?? entry.date;
    const dayStart = new Date(day + "T00:00:00");
    const dayEnd = new Date(day + "T23:59:59.999");
    const daySales = await getSalesForMerchantByDate(merchant, dayStart, dayEnd);
    const priorClose = reports
      .filter((r) => r.finalized && (r.date.split("#")[0] ?? r.date) === day)
      .map((r) => new Date(r.periodClosedAt ?? r.publishedAt).getTime())
      .reduce((max, t) => (Number.isFinite(t) ? Math.max(max, t) : max), 0);
    const sales = priorClose > 0
      ? daySales.filter((s) => new Date(s.timestamp).getTime() > priorClose)
      : daySales;
    void runFinalizePeriod({
      date: day,
      periodKey: entry.date,
      merchantAddress: merchant,
      sales,
      periodStart: priorClose > 0 ? new Date(priorClose) : dayStart,
      periodLabel: reportPeriodLabel(entry.date) ?? "Period 1",
    });
  };

  const runPeriodAction = (args: PeriodReportArgs, finalize: boolean) => {
    if (finalize) void runFinalizePeriod(args);
    else void runSavePeriod(args);
  };

  const handlePrintCurrentPeriod = async (args: PeriodReportArgs) => {
    if (printingReportKind) return;
    setPrintingReportKind("XReport");
    setPrintMessage(null);
    try {
      const report = await generateReportForSales(args);
      await printHostDocument(buildReportPrintDocument(report, "XReport"));
      setPrintMessage({ tone: "success", text: "Sent to printer." });
    } catch (err) {
      console.error("[Printer] Failed to print current period:", err);
      setPrintMessage({ tone: "error", text: "Printing failed. Check the printer and try again." });
    } finally {
      setPrintingReportKind(null);
    }
  };

  const [selectedReport, setSelectedReport] = useState<DailyReport | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedCid, setSelectedCid] = useState<string | null>(null);

  // Receipt modal state
  const [selectedTransaction, setSelectedTransaction] = useState<DailyReportTransaction | null>(null);
  const [svgReceipt, setSvgReceipt] = useState<string | null>(null);
  const [isGeneratingReceipt, setIsGeneratingReceipt] = useState(false);
  const [loadingReport, setLoadingReport] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [printerAvailable, setPrinterAvailable] = useState(false);
  const [printingReportKind, setPrintingReportKind] = useState<Extract<PrintDocumentKind, "XReport" | "ZReport"> | null>(null);
  const [printMessage, setPrintMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  // Load reports from host storage - auto-updates on changes
  const [reports, setReports] = useState<DailyReportRecord[]>([]);
  const [todaySales, setTodaySales] = useState<SaleRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const load = () => getAllDailyReports().then((r) => { setReports(r); setIsLoading(false); });
    load();
    return onStorageChange("dailyReports", load);
  }, []);

  useEffect(() => {
    if (!merchantIdentity) {
      setTodaySales([]);
      return;
    }

    const merchant = normalizeToAssetHubAddress(merchantIdentity);
    const load = () => {
      const today = todayString();
      const dayStart = new Date(today + "T00:00:00");
      const dayEnd = new Date(today + "T23:59:59.999");
      void getSalesForMerchantByDate(merchant, dayStart, dayEnd).then(setTodaySales);
    };

    load();
    return onStorageChange("sales", load);
  }, [merchantIdentity]);

  useEffect(() => {
    let mounted = true;
    isHostPrinterAvailable().then((available) => {
      if (mounted) setPrinterAvailable(available);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // View report from IPFS
  const handleViewReport = async (entry: DailyReportRecord) => {
    setLoadingReport(true);
    setReportError(null);
    setSelectedDate(entry.date);
    setSelectedCid(entry.cid);
    setSelectedReport(null);

    try {
      const report = await readDailyReport(entry.cid);
      setSelectedReport(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load report";
      setReportError(message);
    } finally {
      setLoadingReport(false);
    }
  };

  const closeReportModal = () => {
    setSelectedReport(null);
    setSelectedDate(null);
    setSelectedCid(null);
    setReportError(null);
  };

  // Generate receipt for a transaction from the report
  const handleGenerateReceipt = async (tx: DailyReportTransaction) => {
    setIsGeneratingReceipt(true);
    setSelectedTransaction(tx);
    try {
      const svg = await generateSvgReceipt({
        amount: tx.amountFormatted,
        asset: tx.asset,
        assetId: "native",
        merchantAddress: tx.originalMerchant || tx.evmMerchant,
        customerAddress: tx.originalCustomer || tx.evmCustomer,
        transactionId: tx.txHash,
        blockNumber: parseInt(tx.blockNumber),
        saleId: tx.saleId,
        items: tx.items,
      });
      setSvgReceipt(svg);
    } catch (err) {
      console.error("Failed to generate receipt:", err);
    } finally {
      setIsGeneratingReceipt(false);
    }
  };

  const closeReceiptModal = () => {
    setSelectedTransaction(null);
    setSvgReceipt(null);
  };

  // Download report as JSON file
  const handleDownloadReport = () => {
    if (!selectedReport || !selectedDate) return;
    const jsonString = JSON.stringify(selectedReport, null, 2);
    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `daily-report-${selectedDate}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handlePrintReport = async () => {
    if (!selectedReport || printingReportKind) return;

    const kind = selectedReport.dayFinalized ? "ZReport" : "XReport";
    setPrintingReportKind(kind);
    setPrintMessage(null);
    try {
      await printHostDocument(buildReportPrintDocument(selectedReport, kind));
      setPrintMessage({ tone: "success", text: "Sent to printer." });
    } catch (err) {
      console.error("[Printer] Failed to print report:", err);
      setPrintMessage({ tone: "error", text: "Printing failed. Check the printer and try again." });
    } finally {
      setPrintingReportKind(null);
    }
  };

  const today = todayString();
  const todayReports = reports.filter((r) => r.date === today || r.date.startsWith(`${today}#`));
  const latestFinalizedReport = todayReports
    .filter((r) => r.finalized)
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())[0];
  const openPeriodReport = todayReports
    .filter((r) => !r.finalized && r.date.includes("#"))
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())[0];
  const finalizedAtSource = latestFinalizedReport?.periodClosedAt ?? latestFinalizedReport?.publishedAt;
  const finalizedAt = finalizedAtSource ? new Date(finalizedAtSource).getTime() : 0;
  const currentPeriodSales = finalizedAt > 0
    ? todaySales.filter((sale) => new Date(sale.timestamp).getTime() > finalizedAt)
    : todaySales;
  // Derive the next period number from the highest existing suffix (period 1 is
  // the bare-date record with no "#"), not the array length — so a deleted or
  // out-of-order-restored report can never make a new key collide with an
  // existing on-chain slot.
  const nextPeriodNumber = todayReports
    .map((r) => {
      const suffix = r.date.split("#")[1];
      return suffix ? Number(suffix) : 1;
    })
    .filter((n) => Number.isFinite(n) && n > 0)
    .reduce((max, n) => Math.max(max, n), 0) + 1;
  const periodKey = openPeriodReport?.date ?? (latestFinalizedReport ? `${today}#${String(nextPeriodNumber).padStart(2, "0")}` : today);
  const periodNumber = periodKey.includes("#") ? Number(periodKey.split("#")[1]) : 1;
  const currentPeriod = merchantIdentity
    ? {
        date: today,
        periodKey,
        merchantAddress: normalizeToAssetHubAddress(merchantIdentity),
        sales: currentPeriodSales,
        periodStart: finalizedAt > 0 ? new Date(finalizedAt) : new Date(today + "T00:00:00"),
        periodLabel: Number.isFinite(periodNumber) ? `Period ${periodNumber}` : "Current period",
      } satisfies PeriodReportArgs
    : null;
  const currentPeriodTotal = currentPeriodSales.reduce((sum, sale) => {
    const value = Number(sale.amount);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
  const currentPeriodAsset = currentPeriodSales[0]?.asset ?? symbol;
  const hasCurrentPeriodRecords = currentPeriodSales.length > 0;

  // Download report as CSV file
  const handleDownloadCsv = () => {
    if (!selectedReport || !selectedDate) return;

    const headers = [
      "Sale ID", "Status", "Amount", "Amount Formatted", "Asset",
      "Merchant", "Customer", "Tx Hash", "Block Number",
      "Timestamp", "Timestamp Formatted", "Terminal ID", "Refund Of",
    ];

    const escCsv = (val: string | null) => {
      if (val === null) return "";
      if (val.includes(",") || val.includes('"') || val.includes("\n")) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    };

    const rows = selectedReport.transactions.map(tx => [
      tx.saleId, tx.status, tx.amount, tx.amountFormatted, tx.asset,
      tx.originalMerchant || tx.evmMerchant, tx.originalCustomer || tx.evmCustomer,
      tx.txHash, tx.blockNumber, tx.timestamp, tx.timestampFormatted,
      tx.terminalId, tx.refundOf ?? "",
    ].map(escCsv).join(","));

    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `daily-report-${selectedDate}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };


  return (
    <div className="min-h-dvh bg-black flex flex-col">
      <div className="flex-1 flex flex-col max-w-md mx-auto w-full pb-24">
        {/* Header */}
        <header className="flex items-center justify-between px-4 py-4">
          <Link href="/settings/backup" className="p-2">
            <ArrowLeft className="w-6 h-6 text-white" />
          </Link>
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-white" />
            <span data-testid="reports-header" className="text-white font-medium">Reports</span>
          </div>
          <div className="w-10" />
        </header>

        <div className="px-6 py-3 space-y-4">
          <section className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-neutral-400 text-xs mb-1">Current period</p>
                <h2 className="text-white text-lg font-semibold">{currentPeriod?.periodLabel ?? "Not configured"}</h2>
              </div>
              <span className={`text-xs px-2 py-1 rounded ${hasCurrentPeriodRecords ? "bg-amber-500/20 text-amber-300" : "bg-neutral-800 text-neutral-400"}`}>
                {hasCurrentPeriodRecords ? "Open" : "Empty"}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-neutral-500 text-xs">Records</p>
                <p className="text-white text-2xl font-semibold">{currentPeriodSales.length}</p>
              </div>
              <div className="text-right">
                <p className="text-neutral-500 text-xs">Total</p>
                <p className="text-white text-2xl font-semibold">
                  {currentPeriodTotal.toFixed(2)} <span className="text-sm text-neutral-400">{currentPeriodAsset}</span>
                </p>
              </div>
            </div>

            <div className={`grid gap-2 ${printerAvailable ? "grid-cols-2" : "grid-cols-1"}`}>
              {printerAvailable && (
                <button
                  type="button"
                  onClick={() => currentPeriod && handlePrintCurrentPeriod(currentPeriod)}
                  disabled={!currentPeriod || !hasCurrentPeriodRecords || isRunning || printingReportKind !== null}
                  className="w-full bg-neutral-800 hover:bg-neutral-700 text-white py-3 px-3 rounded-xl flex items-center justify-center gap-2 transition border border-neutral-700 disabled:opacity-40"
                >
                  {printingReportKind === "XReport" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
                  <span>Print X</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => currentPeriod && runPeriodAction(currentPeriod, false)}
                disabled={!currentPeriod || !hasCurrentPeriodRecords || isRunning}
                className="w-full bg-neutral-800 hover:bg-neutral-700 text-white py-3 px-3 rounded-xl flex items-center justify-center gap-2 transition border border-neutral-700 disabled:opacity-40"
              >
                {currentPeriod && activeJob?.key === currentPeriod.periodKey ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                <span>Save X</span>
              </button>
            </div>
          </section>

          <section className="bg-neutral-950 border border-neutral-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-neutral-400 text-xs mb-1">Z report</p>
                <p className="text-white font-medium">Close current period</p>
              </div>
              <Lock className="w-5 h-5 text-amber-300" />
            </div>
            <button
              type="button"
              onClick={() => currentPeriod && setConfirmFinalizeTarget(currentPeriod)}
              disabled={!currentPeriod || !hasCurrentPeriodRecords || isRunning}
              className="w-full bg-amber-500 hover:bg-amber-400 text-black py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition disabled:bg-neutral-700 disabled:text-neutral-500"
            >
              <Lock className="w-4 h-4" />
              <span>Run Z</span>
            </button>
          </section>

          <section className="space-y-2">
              {reportActionError && (
                <div className="bg-red-900/30 border border-red-800 rounded-lg p-3 text-red-400 text-sm">
                  {reportActionError}
                </div>
              )}
              {printMessage && (
                <div className={`rounded-lg border p-3 text-sm ${
                  printMessage.tone === "success"
                    ? "bg-green-900/30 border-green-800 text-green-400"
                    : "bg-red-900/30 border-red-800 text-red-400"
                }`}>
                  {printMessage.text}
                </div>
              )}
          </section>
        </div>

        {/* Reports List */}
        <main className="px-6 py-4">
          <h3 className="text-white font-medium mb-4">Report history</h3>

          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 className="w-8 h-8 text-neutral-400 animate-spin mb-4" />
              <p className="text-neutral-500 text-sm">Loading reports...</p>
            </div>
          ) : reports.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <FileText className="w-12 h-12 text-neutral-700 mb-4" />
              <p data-testid="reports-empty" className="text-neutral-500 text-sm">No reports yet</p>
              <p className="text-neutral-600 text-xs mt-1">
                Save an X report or run a Z report to create one
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {reports.map((entry, index) => (
                <div
                  key={`${entry.date}-${index}`}
                  className="bg-neutral-900 border border-neutral-800 rounded-xl p-4"
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-neutral-400" />
                      <div>
                        <span className="text-white font-medium">{reportDisplayDate(entry.date)}</span>
                        {reportPeriodLabel(entry.date) ? (
                          <p className="text-xs text-neutral-500">{reportPeriodLabel(entry.date)}</p>
                        ) : null}
                      </div>
                    </div>
                    {entry.finalized ? (
                      <span className="text-xs px-2 py-1 rounded bg-green-500/20 text-green-400 flex items-center gap-1">
                        <Lock className="w-3 h-3" />
                        Z report
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-1 rounded bg-yellow-500/20 text-yellow-400">
                        X report
                      </span>
                    )}
                  </div>

                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Transactions</span>
                      <span className="text-neutral-300">{entry.entryCount}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-neutral-500 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {entry.finalized ? "Closed" : "Saved"}
                      </span>
                      <span className="text-neutral-300">
                        {new Date(entry.publishedAt).toLocaleString("en-US", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                  </div>

                  <button
                    data-testid={`report-view-${index}`}
                    onClick={() => handleViewReport(entry)}
                    disabled={loadingReport}
                    className="mt-4 w-full bg-neutral-800 hover:bg-neutral-700 text-white py-2 px-4 rounded-lg flex items-center justify-center gap-2 transition"
                  >
                    <ExternalLink className="w-4 h-4" />
                    <span>Open report</span>
                  </button>

                  {!entry.finalized && (entry.date.split("#")[0] ?? entry.date) !== todayString() && (
                    <button
                      data-testid={`report-finalize-${index}`}
                      onClick={() => setConfirmFinalizeEntry(entry)}
                      disabled={!merchantIdentity || isRunning}
                      className="mt-2 w-full bg-amber-500 hover:bg-amber-400 text-black py-2 px-4 rounded-lg flex items-center justify-center gap-2 transition disabled:bg-neutral-700 disabled:text-neutral-500"
                    >
                      {activeJob?.key === entry.date ? (
                        <><Loader2 className="w-4 h-4 animate-spin" /><span>{phaseLabel || "Finalizing…"}</span></>
                      ) : (
                        <><Lock className="w-4 h-4" /><span>Run Z report</span></>
                      )}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </main>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40">
        <BottomNav />
      </div>

      {/* Period finalize confirmation modal */}
      {confirmFinalizeTarget && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-neutral-900 rounded-2xl max-w-sm w-full p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Lock className="w-5 h-5 text-amber-300" />
              <h3 className="text-white font-medium">Run Z report?</h3>
            </div>
            <p className="text-neutral-400 text-sm">
              This saves a final Z report and closes <span className="text-white">{confirmFinalizeTarget.periodLabel ?? confirmFinalizeTarget.periodKey}</span>.
              This period can no longer be updated. New sales will start another period.
            </p>
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmFinalizeTarget(null)}
                disabled={isRunning}
                className="flex-1 bg-neutral-800 hover:bg-neutral-700 text-white py-3 px-4 rounded-xl transition disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="btn-finalize-period-confirm"
                onClick={() => {
                  const target = confirmFinalizeTarget;
                  setConfirmFinalizeTarget(null);
                  void runPeriodAction(target, true);
                }}
                disabled={isRunning}
                className="flex-1 bg-amber-500 hover:bg-amber-400 text-black py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition disabled:bg-neutral-700 disabled:text-neutral-500"
              >
                <Lock className="w-4 h-4" />
                <span>Close period</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Finalize confirmation modal — open report from a previous day */}
      {confirmFinalizeEntry && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-neutral-900 rounded-2xl max-w-sm w-full p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Lock className="w-5 h-5 text-amber-300" />
              <h3 className="text-white font-medium">Run Z report?</h3>
            </div>
            <p className="text-neutral-400 text-sm">
              This saves a final Z report and closes{" "}
              <span className="text-white">
                {reportDisplayDate(confirmFinalizeEntry.date)}
                {reportPeriodLabel(confirmFinalizeEntry.date) ? ` · ${reportPeriodLabel(confirmFinalizeEntry.date)}` : ""}
              </span>.
              This period can no longer be updated.
            </p>
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmFinalizeEntry(null)}
                disabled={isRunning}
                className="flex-1 bg-neutral-800 hover:bg-neutral-700 text-white py-3 px-4 rounded-xl transition disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="btn-finalize-confirm"
                onClick={() => {
                  const entry = confirmFinalizeEntry;
                  setConfirmFinalizeEntry(null);
                  void runFinalizePastEntry(entry);
                }}
                disabled={isRunning}
                className="flex-1 bg-amber-500 hover:bg-amber-400 text-black py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition disabled:bg-neutral-700 disabled:text-neutral-500"
              >
                <Lock className="w-4 h-4" />
                <span>Close period</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Report Details Modal */}
      {(selectedDate || selectedCid) && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-neutral-900 rounded-2xl max-w-md w-full max-h-[90vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b border-neutral-800">
              <h3 className="text-white font-medium">Report Details</h3>
              <button
                onClick={closeReportModal}
                className="p-2 hover:bg-neutral-800 rounded-lg transition"
              >
                <X className="w-5 h-5 text-neutral-400" />
              </button>
            </div>

            {/* Report Content */}
            <div className="p-4 space-y-4">
              {loadingReport ? (
                <div className="flex flex-col items-center justify-center py-8">
                  <Loader2 className="w-8 h-8 text-neutral-400 animate-spin mb-4" />
                  <p className="text-neutral-500 text-sm">Loading report from IPFS...</p>
                </div>
              ) : reportError ? (
                <div className="bg-red-900/30 border border-red-800 rounded-lg p-4 text-red-400 text-sm">
                  {reportError}
                </div>
              ) : (
                <>
                  {/* Date */}
                  <div className="bg-neutral-800 rounded-lg p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-neutral-400">Date</span>
                      <span className="text-white font-medium">{selectedDate}</span>
                    </div>
                  </div>

                  {/* Open / download */}
                  <div className="bg-neutral-800 rounded-lg p-4 space-y-3">
                    <h4 className="text-white font-medium text-sm">View report</h4>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={handleDownloadReport}
                        disabled={!selectedReport}
                        className="flex-1 flex items-center justify-center gap-2 text-white bg-neutral-700 hover:bg-neutral-600 py-2 px-3 rounded-lg transition text-sm disabled:opacity-50"
                      >
                        <Download className="w-4 h-4" />
                        <span>JSON</span>
                      </button>
                      <button
                        onClick={handleDownloadCsv}
                        disabled={!selectedReport}
                        className="flex-1 flex items-center justify-center gap-2 text-white bg-neutral-700 hover:bg-neutral-600 py-2 px-3 rounded-lg transition text-sm disabled:opacity-50"
                      >
                        <Download className="w-4 h-4" />
                        <span>CSV</span>
                      </button>
                      {printerAvailable && (
                        <button
                          onClick={handlePrintReport}
                          disabled={!selectedReport || printingReportKind !== null}
                          className="col-span-2 flex items-center justify-center gap-2 text-white bg-neutral-700 hover:bg-neutral-600 py-2 px-3 rounded-lg transition text-sm disabled:opacity-50"
                        >
                          {printingReportKind ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Printer className="w-4 h-4" />
                          )}
                          <span>{selectedReport?.dayFinalized ? "Print Z" : "Print X"}</span>
                        </button>
                      )}
                    </div>
                    {printMessage && (
                      <div className={`rounded-lg border px-3 py-2 text-xs ${
                        printMessage.tone === "success"
                          ? "bg-green-900/30 border-green-800 text-green-400"
                          : "bg-red-900/30 border-red-800 text-red-400"
                      }`}>
                        {printMessage.text}
                      </div>
                    )}
                  </div>

                  {/* Selected Report Display */}
                  {selectedReport && (
                    <>
                      {/* Summary Stats */}
                      <div className="bg-gradient-to-r from-green-900/30 to-emerald-900/30 border border-green-800/50 rounded-lg p-4 space-y-3">
                        <h4 className="text-green-400 font-medium text-sm">Report Summary</h4>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="bg-black/30 rounded-lg p-3">
                            <p className="text-neutral-500 text-xs">Transactions</p>
                            <p className="text-white text-xl font-semibold">{selectedReport.totalTransactions}</p>
                          </div>
                          <div className="bg-black/30 rounded-lg p-3">
                            <p className="text-neutral-500 text-xs">Date</p>
                            <p className="text-white text-lg font-semibold">{selectedReport.selectedDate}</p>
                          </div>
                        </div>
                        <div className="space-y-1 text-xs pt-2 border-t border-green-800/30">
                          <div className="flex justify-between">
                            <span className="text-neutral-500">Exported</span>
                            <span className="text-neutral-300">
                              {new Date(selectedReport.exportDate).toLocaleString()}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Transactions List */}
                      <div className="bg-neutral-800 rounded-lg p-4 space-y-3">
                        <h4 className="text-white font-medium text-sm">
                          Transactions ({selectedReport.transactions.length})
                        </h4>
                        <div className="space-y-2 max-h-80 overflow-y-auto">
                          {selectedReport.transactions.map((tx, index) => (
                            <div
                              key={tx.saleId || index}
                              className="bg-neutral-900 rounded-lg p-3 space-y-2"
                            >
                              <div className="flex items-center justify-between">
                                <span className="text-white font-medium text-sm">
                                  {money2(tx.amountFormatted)} {symbol}
                                </span>
                                <span className={`text-xs px-2 py-0.5 rounded ${
                                  tx.status === "Finished"
                                    ? "bg-green-500/20 text-green-400"
                                    : "bg-orange-500/20 text-orange-400"
                                }`}>
                                  {tx.status}
                                </span>
                              </div>
                              <div className="flex justify-between text-xs">
                                <span className="text-neutral-500">Sale</span>
                                <span className="text-neutral-400 font-mono">
                                  #{(tx.saleId ?? "").slice(-4).toUpperCase()}
                                </span>
                              </div>
                              <button
                                onClick={() => handleGenerateReceipt(tx)}
                                disabled={isGeneratingReceipt}
                                className="w-full bg-neutral-700 hover:bg-neutral-600 text-white py-2 px-3 rounded-lg flex items-center justify-center gap-2 transition text-xs"
                              >
                                <FileText className="w-3 h-3" />
                                <span>View Record</span>
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>

            {/* Close Button */}
            <div className="p-4 border-t border-neutral-800">
              <button
                onClick={closeReportModal}
                className="w-full bg-white text-black py-3 rounded-xl font-medium"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Receipt Modal */}
      {selectedTransaction && svgReceipt && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[60] p-4">
          <div className="bg-neutral-900 rounded-2xl max-w-md w-full max-h-[90vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b border-neutral-800">
              <h3 className="text-white font-medium">Transaction Record</h3>
              <button
                onClick={closeReceiptModal}
                className="p-2 hover:bg-neutral-800 rounded-lg transition"
              >
                <X className="w-5 h-5 text-neutral-400" />
              </button>
            </div>

            {/* Receipt SVG */}
            <div className="p-4">
              <div
                className="bg-white rounded-lg overflow-hidden"
                dangerouslySetInnerHTML={{ __html: svgReceipt }}
              />
            </div>

            {/* Transaction Details */}
            <div className="p-4 border-t border-neutral-800">
              <h4 className="text-white font-medium mb-3">Transaction Data</h4>
              <div className="space-y-2 text-xs bg-neutral-800 rounded-lg p-3">
                <div className="flex justify-between">
                  <span className="text-neutral-500">Sale ID</span>
                  <span className="text-neutral-300 font-mono text-[10px]">{selectedTransaction.saleId}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-500">Amount</span>
                  <span className="text-neutral-300">{money2(selectedTransaction.amountFormatted)} {selectedTransaction.asset}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-500">Status</span>
                  <span className={selectedTransaction.status === 'Finished' ? 'text-green-400' : 'text-orange-400'}>
                    {selectedTransaction.status}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-500">From</span>
                  <span className="text-neutral-300">Customer</span>
                </div>
              </div>
            </div>

            {/* Close Button */}
            <div className="p-4 border-t border-neutral-800">
              <button
                onClick={closeReceiptModal}
                className="w-full bg-white text-black py-3 rounded-xl font-medium"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Normalize a stored amount string to two decimals so every numeric column
 * in the export reads consistently ("5.5" → "5.50", "6" → "6.00"). Stored
 * records predating consistent formatting flow through here too. Non-numeric
 * values pass through untouched.
 */
function money2(amount: string): string {
  const n = Number(amount);
  return Number.isFinite(n) ? n.toFixed(2) : amount;
}

/* ── Date helpers ─────────────────────────────────────────────── */

function formatYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayString(): string {
  return formatYmd(new Date());
}

function reportDisplayDate(date: string): string {
  return date.split("#")[0] ?? date;
}

function reportPeriodLabel(date: string): string | null {
  const period = date.split("#")[1];
  if (!period) return null;
  const value = Number(period);
  return Number.isFinite(value) ? `Period ${value}` : period;
}
