import { useState } from "react";
import { usePdfReceipt } from "./use-pdf-receipt";
import { getTimestampFromSaleId } from "@/lib/utils/sale-id";
import { buildReceiptQrPayload, buildReceiptDeeplink, type ReceiptItem } from "@/lib/receipts/receipt-generator";
import { BUSINESS_PROFILE, type BusinessProfile } from "@/lib/config/business";
import { useAdminQrPayload } from "@/lib/config/admin-qr";

export interface ReceiptData {
  amount: string;
  asset: string;
  merchantAddress: string;
  customerAddress: string;
  transactionId: string;
  blockNumber?: number;
  blockHash?: string;
  assetId: string;
  saleId?: string;
  /** Optional itemized rows when the sale came from /items */
  items?: ReceiptItem[];
}

/**
 * Hook that handles receipt generation (SVG with QR and PDF download)
 * Centralizes the try-catch logic and fallback handling
 */
export function useReceiptGenerator() {
  const { generateReceipt, generateSvg, generateSvgWithQR } = usePdfReceipt();
  const adminPayload = useAdminQrPayload();
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Synthesize a BusinessProfile from the admin payload when one is bound.
  // The richer `profile` field (post-2026-06 QRs) carries address + phone
  // + tax id directly; older QRs only carry `displayName`, in which case
  // address lines fall back to the local BUSINESS_PROFILE defaults.
  // taxRate + currency aren't on the QR yet — they stay on the local
  // profile until the admin format covers them.
  const business: BusinessProfile = adminPayload
    ? {
        ...BUSINESS_PROFILE,
        name: adminPayload.profile?.name ?? adminPayload.displayName,
        addressLine1:
          adminPayload.profile?.addressLine1 ?? BUSINESS_PROFILE.addressLine1,
        addressLine2:
          adminPayload.profile?.addressLine2 ?? BUSINESS_PROFILE.addressLine2,
        phone: adminPayload.profile?.phone ?? BUSINESS_PROFILE.phone,
      }
    : BUSINESS_PROFILE;

  /**
   * Generate SVG receipt with embedded QR code
   * Falls back to regular SVG if QR generation fails
   */
  const generateSvgReceipt = async (data: ReceiptData): Promise<string | null> => {
    setIsGenerating(true);
    setError(null);

    // Extract timestamp from SaleId ULID (canonical time), fallback to current time
    const timestamp = data.saleId
      ? getTimestampFromSaleId(data.saleId) ?? new Date()
      : new Date();

    try {
      // Try to generate SVG with QR code
      const svg = await generateSvgWithQR({
        amount: data.amount,
        asset: data.asset,
        merchant: business.name,
        business,
        merchantAddress: data.merchantAddress,
        customerAddress: data.customerAddress,
        transactionId: data.transactionId,
        blockNumber: data.blockNumber,
        blockHash: data.blockHash,
        timestamp,
        assetId: data.assetId,
        saleId: data.saleId,
        items: data.items,
      });

      setIsGenerating(false);
      return svg;
    } catch (qrError) {
      console.error("[Receipt Generator] Error generating SVG with QR code:", qrError);

      // Fallback to regular SVG without QR
      try {
        const fallbackSvg = generateSvg({
          amount: data.amount,
          asset: data.asset,
          merchant: business.name,
        business,
          merchantAddress: data.merchantAddress,
          customerAddress: data.customerAddress,
          transactionId: data.transactionId,
          blockNumber: data.blockNumber,
          blockHash: data.blockHash,
          timestamp,
          assetId: data.assetId,
          saleId: data.saleId,
          items: data.items,
        });

        setIsGenerating(false);
        return fallbackSvg;
      } catch (fallbackError) {
        console.error("[Receipt Generator] Error generating fallback SVG:", fallbackError);
        setError("Failed to generate receipt");
        setIsGenerating(false);
        return null;
      }
    }
  };

  /**
   * Build the exact same wallet deeplink that gets embedded as the QR on the
   * printed receipt. Sharing this value (rather than a `/receipt/<id>` URL)
   * lets the wallet rebuild the full receipt offline — no chain or gateway
   * round-trip needed. Timestamp is derived from the SaleId ULID so it
   * matches the QR baked into the rendered receipt.
   */
  const buildReceiptQrValue = (data: ReceiptData): string => {
    const timestamp = data.saleId
      ? getTimestampFromSaleId(data.saleId) ?? new Date()
      : new Date();
    return buildReceiptDeeplink(
      buildReceiptQrPayload(
        {
          amount: data.amount,
          asset: data.asset,
          merchant: business.name,
          business,
          merchantAddress: data.merchantAddress,
          customerAddress: data.customerAddress,
          transactionId: data.transactionId,
          blockNumber: data.blockNumber,
          blockHash: data.blockHash,
          timestamp,
          assetId: data.assetId,
          saleId: data.saleId,
          items: data.items,
        },
        business,
        timestamp,
      ),
    );
  };

  /**
   * Download receipt as PDF
   */
  const downloadPdfReceipt = async (data: ReceiptData): Promise<void> => {
    setIsGenerating(true);
    setError(null);

    // Extract timestamp from SaleId ULID (canonical time), fallback to current time
    const timestamp = data.saleId
      ? getTimestampFromSaleId(data.saleId) ?? new Date()
      : new Date();

    try {
      await generateReceipt({
        amount: data.amount,
        asset: data.asset,
        merchant: business.name,
        business,
        merchantAddress: data.merchantAddress,
        customerAddress: data.customerAddress,
        transactionId: data.transactionId,
        blockNumber: data.blockNumber,
        blockHash: data.blockHash,
        timestamp,
        assetId: data.assetId,
        saleId: data.saleId,
        items: data.items,
      });

      setIsGenerating(false);
    } catch (err) {
      console.error("[Receipt Generator] Failed to download PDF receipt:", err);
      setError("Failed to download PDF");
      setIsGenerating(false);
      throw err;
    }
  };

  return {
    generateSvgReceipt,
    buildReceiptQrValue,
    downloadPdfReceipt,
    isGenerating,
    error,
  };
}
