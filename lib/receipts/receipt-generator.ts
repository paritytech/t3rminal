/**
 * SVG Receipt Generator — Quittung-style paper receipt with optional itemized
 * lines. Designed to print on a standard 80mm thermal roll equivalent.
 *
 * When `items` are present the receipt shows the line-by-line breakdown,
 * subtotal, tendered amount, change and tax footer (Funkhaus-style). When no
 * items are passed (direct-amount-entry flow) the layout falls back to a
 * compact "amount only" receipt.
 */

import QRCode from "qrcode"
import { BUSINESS_PROFILE, type BusinessProfile } from "@/lib/config/business"

export interface ReceiptItem {
  /** Display label (e.g. "Espresso") */
  name: string
  quantity: number
  /** Per-unit price formatted in the receipt currency (e.g. "2.50") */
  unitPrice: string
}

export interface ReceiptData {
  amount: string
  asset: string
  merchant: string
  merchantAddress: string
  customerAddress: string
  transactionId: string
  blockNumber?: number
  blockHash?: string
  timestamp?: Date
  assetId?: string
  saleId?: string
  /** Optional itemized breakdown — when present, renders Quittung layout. */
  items?: ReceiptItem[]
  /** Optional business profile override (defaults to BUSINESS_PROFILE). */
  business?: BusinessProfile
}

// ── Helpers ───────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function formatMoney(amount: string): string {
  // Normalize "5", "5.0", "5.50" → "5.00"
  const n = Number(amount)
  if (!Number.isFinite(n)) return amount
  return n.toFixed(2)
}

function formatDateEn(ts: Date): string {
  const dd = String(ts.getDate()).padStart(2, "0")
  const mm = String(ts.getMonth() + 1).padStart(2, "0")
  const yyyy = ts.getFullYear()
  const hh = String(ts.getHours()).padStart(2, "0")
  const min = String(ts.getMinutes()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`
}

function shortRef(saleId?: string): string {
  return saleId ? saleId.slice(-4).toUpperCase() : "----"
}

// ── Layout ────────────────────────────────────────────────────

const WIDTH = 320
const LINE = 16 // monospace line height
const FONT_MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
const FONT_DISPLAY = "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"

type RenderRow =
  | { type: "text"; value: string; align?: "left" | "center" | "right"; bold?: boolean; size?: number }
  | { type: "split"; left: string; right: string; bold?: boolean; size?: number }
  | { type: "rule" }
  | { type: "space"; height: number }

function buildRows(data: ReceiptData, business: BusinessProfile, ts: Date): RenderRow[] {
  const rows: RenderRow[] = []

  // Header — business identity, centered
  rows.push({ type: "text", value: business.name, align: "center", bold: true, size: 13 })
  if (business.addressLine1) rows.push({ type: "text", value: business.addressLine1, align: "center", size: 11 })
  if (business.addressLine2) rows.push({ type: "text", value: business.addressLine2, align: "center", size: 11 })
  if (business.phone) rows.push({ type: "text", value: business.phone, align: "center", size: 11 })
  rows.push({ type: "space", height: 10 })
  rows.push({ type: "text", value: "RECORD", align: "center", bold: true, size: 20 })
  rows.push({ type: "space", height: 10 })

  // Meta — Record # / Date / dual Sale ID / Admin
  rows.push({ type: "split", left: "Record", right: `#${shortRef(data.saleId)}` })
  rows.push({ type: "split", left: "Date", right: formatDateEn(ts) })
  if (data.saleId) {
    rows.push({ type: "text", value: `${shortRef(data.saleId)} (ID: ${data.saleId})`, align: "left", size: 10 })
  }
  rows.push({ type: "text", value: "Admin", align: "left", size: 11 })
  rows.push({ type: "space", height: 4 })
  rows.push({ type: "rule" })

  // Right-aligned currency header above prices
  rows.push({ type: "text", value: business.currency, align: "right", bold: true })

  // Items
  if (data.items && data.items.length > 0) {
    for (const item of data.items) {
      const lineTotal = (Number(item.unitPrice) * item.quantity).toFixed(2)
      rows.push({
        type: "split",
        left: `${item.quantity} × ${item.name}`,
        right: `${formatMoney(lineTotal)} A`,
      })
    }
  } else {
    // Direct-amount sale — single line
    rows.push({
      type: "split",
      left: "1 × Amount",
      right: `${formatMoney(data.amount)} A`,
    })
  }

  rows.push({ type: "rule" })
  rows.push({ type: "split", left: `Total ${business.currency}`, right: formatMoney(data.amount), bold: true, size: 14 })

  // Payment / change — receipt printed in the merchant's local currency (CASH).
  rows.push({ type: "space", height: 6 })
  rows.push({ type: "split", left: `Paid ${business.currency}`, right: formatMoney(data.amount) })
  rows.push({ type: "split", left: "Change", right: "0.00" })

  // Tax footer
  if (business.taxRate > 0) {
    const net = Number(data.amount) / (1 + business.taxRate / 100)
    const tax = Number(data.amount) - net
    rows.push({ type: "space", height: 6 })
    rows.push({
      type: "split",
      left: `A incl. ${business.taxRate}% VAT on ${formatMoney(net.toFixed(2))}`,
      right: formatMoney(tax.toFixed(2)),
    })
  }

  return rows
}

// ── SVG composer ──────────────────────────────────────────────

interface ComposeOptions {
  qrDataUrl?: string
}

function composeSvg(rows: RenderRow[], opts: ComposeOptions): string {
  const padding = 24
  const innerWidth = WIDTH - padding * 2

  // Measure pass: compute height
  let y = padding
  for (const r of rows) {
    if (r.type === "space") y += r.height
    else if (r.type === "rule") y += 8
    else y += LINE
  }

  // QR area
  const qrSize = opts.qrDataUrl ? 110 : 0
  const qrPad = opts.qrDataUrl ? 20 : 0
  const totalHeight = y + qrPad + qrSize + padding

  // Render pass
  const elements: string[] = []
  y = padding
  for (const r of rows) {
    if (r.type === "space") {
      y += r.height
      continue
    }
    if (r.type === "rule") {
      y += 4
      elements.push(
        `<line x1="${padding}" y1="${y}" x2="${WIDTH - padding}" y2="${y}" stroke="#999" stroke-width="0.5" stroke-dasharray="2,2"/>`
      )
      y += 4
      continue
    }
    const size = r.type === "text" ? r.size ?? 12 : r.size ?? 12
    const weight = (r.type === "text" || r.type === "split") && r.bold ? "700" : "400"
    const family = r.type === "text" && r.align === "center" ? FONT_DISPLAY : FONT_MONO

    if (r.type === "text") {
      const align = r.align ?? "left"
      const x = align === "center" ? WIDTH / 2 : align === "right" ? WIDTH - padding : padding
      const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start"
      elements.push(
        `<text x="${x}" y="${y + size * 0.8}" font-family="${family}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="#111">${escapeXml(r.value)}</text>`
      )
    } else {
      // split
      elements.push(
        `<text x="${padding}" y="${y + size * 0.8}" font-family="${FONT_MONO}" font-size="${size}" font-weight="${weight}" fill="#111">${escapeXml(r.left)}</text>`
      )
      elements.push(
        `<text x="${WIDTH - padding}" y="${y + size * 0.8}" font-family="${FONT_MONO}" font-size="${size}" font-weight="${weight}" text-anchor="end" fill="#111">${escapeXml(r.right)}</text>`
      )
    }
    y += LINE
  }

  // QR
  if (opts.qrDataUrl) {
    const qrX = (WIDTH - qrSize) / 2
    const qrY = y + qrPad
    elements.push(
      `<image x="${qrX}" y="${qrY}" width="${qrSize}" height="${qrSize}" href="${opts.qrDataUrl}"/>`
    )
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${WIDTH} ${totalHeight}" width="100%" preserveAspectRatio="xMidYMid meet">
  <rect width="${WIDTH}" height="${totalHeight}" fill="#ffffff"/>
  ${elements.join("\n  ")}
</svg>`
}

// ── Public API ────────────────────────────────────────────────

export function generateReceiptSVG(data: ReceiptData): string {
  const ts = data.timestamp ? new Date(data.timestamp) : new Date()
  const business = data.business ?? BUSINESS_PROFILE
  const rows = buildRows(data, business, ts)
  return composeSvg(rows, {})
}

/**
 * Versioned receipt envelope carried by the QR code. Anything that wants
 * to rebuild this exact receipt (mobile companion app, audit tool, etc.)
 * only needs to scan and run the same `buildRows` against the payload.
 *
 * Bump `v` and add a new branch in the reader when fields are added; older
 * decoders will then reject unknown versions instead of silently dropping
 * data.
 */
export interface ReceiptQrPayload {
  v: 1
  type: "t3rminal-receipt"
  saleId: string | null
  amount: string
  asset: string
  /** Currency printed on the receipt (e.g. "CASH"). */
  currency: string
  /** ISO 4217 currency code the receipt is denominated in (e.g. "EUR"). */
  currencyCode: string
  taxRate: number
  business: {
    name: string
    addressLine1?: string
    addressLine2?: string
    phone?: string
  }
  items: ReceiptItem[]
  /** ISO 8601 of the sale timestamp (extracted from saleId ULID or wall clock). */
  issuedAt: string
  /** Substrate block hash (hex) that confirmed the credit, when known. */
  blockHash?: string
  blockNumber?: number
  merchantAddress: string
}

export function buildReceiptQrPayload(
  data: ReceiptData,
  business: BusinessProfile,
  ts: Date,
): ReceiptQrPayload {
  return {
    v: 1,
    type: "t3rminal-receipt",
    saleId: data.saleId ?? null,
    amount: data.amount,
    asset: data.asset,
    currency: business.currency,
    currencyCode: business.currencyCode,
    taxRate: business.taxRate,
    business: {
      name: business.name,
      addressLine1: business.addressLine1,
      addressLine2: business.addressLine2,
      phone: business.phone,
    },
    items: data.items ?? [],
    issuedAt: ts.toISOString(),
    blockHash: data.blockHash,
    blockNumber: data.blockNumber,
    merchantAddress: data.merchantAddress,
  }
}

/** Wallet deeplink scheme for "save this receipt" — handled by the Polkadot
 *  wallet app, same `polkadotapp://w3spay.dot/...` family as the pay flow. */
export const SAVE_RECEIPT_DEEPLINK_BASE = "polkadotapp://w3spay.dot/save-receipt"

/**
 * Serialize a receipt envelope into the `save-receipt` wallet deeplink. The
 * QR on the printed receipt carries this URL: scanning it opens the wallet's
 * "save receipt" handler, which rebuilds the full receipt offline from the
 * query params — no chain or gateway round-trip.
 *
 * Items are repeated `item=<name>|<quantity>|<unitPrice>` params. Values are
 * URL-encoded by URLSearchParams (spaces → `+`, `|` → `%7C`), matching the
 * encoding the wallet already decodes for the pay deeplink. Optional fields
 * are omitted entirely when absent rather than emitted empty.
 */
export function buildReceiptDeeplink(payload: ReceiptQrPayload): string {
  const params = new URLSearchParams()
  params.set("version", String(payload.v))
  if (payload.saleId) params.set("saleId", payload.saleId)
  params.set("amount", payload.amount)
  // The receipt's printed label is the `asset` on the deeplink (e.g. "CASH");
  // the ISO 4217 code is `currency` (e.g. "EUR").
  params.set("asset", payload.currency)
  params.set("currency", payload.currencyCode)
  params.set("taxRate", String(payload.taxRate))
  params.set("issuedAt", payload.issuedAt)
  params.set("businessName", payload.business.name)
  if (payload.business.addressLine1) params.set("businessAddressLine1", payload.business.addressLine1)
  if (payload.business.addressLine2) params.set("businessAddressLine2", payload.business.addressLine2)
  if (payload.business.phone) params.set("businessPhone", payload.business.phone)
  for (const item of payload.items) {
    params.append("item", `${item.name}|${item.quantity}|${item.unitPrice}`)
  }
  if (payload.blockHash) params.set("blockHash", payload.blockHash)
  if (payload.blockNumber !== undefined) params.set("blockNumber", String(payload.blockNumber))
  if (payload.merchantAddress) params.set("merchantAddress", payload.merchantAddress)
  return `${SAVE_RECEIPT_DEEPLINK_BASE}?${params.toString()}`
}

export async function generateReceiptSVGWithQR(data: ReceiptData): Promise<string> {
  const ts = data.timestamp ? new Date(data.timestamp) : new Date()
  const business = data.business ?? BUSINESS_PROFILE
  const rows = buildRows(data, business, ts)

  // Full receipt envelope as a wallet deeplink — scanning this opens the
  // wallet's save-receipt handler, which rebuilds the exact same printable
  // receipt offline without round-tripping through the chain or gateway.
  const qrPayload = buildReceiptDeeplink(buildReceiptQrPayload(data, business, ts))

  try {
    const qrDataUrl = await QRCode.toDataURL(qrPayload, {
      width: 240,
      margin: 0,
      // L (~7% recovery) trades resilience for capacity — the receipt
      // payload with a long item list comfortably exceeds the M-level
      // ceiling, and the printed QR sits on white paper where damage
      // tolerance isn't load-bearing anyway. Scanners still read fine.
      errorCorrectionLevel: "L",
      color: { dark: "#000000", light: "#ffffff" },
    })
    return composeSvg(rows, { qrDataUrl })
  } catch (error) {
    console.error("[Receipt] QR generation failed, returning receipt without QR:", error)
    return composeSvg(rows, {})
  }
}

/**
 * Parse a scanned receipt QR back into the structured payload. Returns
 * `null` for anything that isn't a t3rminal receipt v1 envelope — caller
 * decides whether to ignore, warn, or fall back.
 */
export function parseReceiptQr(raw: string): ReceiptQrPayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  if (obj.type !== "t3rminal-receipt" || obj.v !== 1) return null
  return obj as unknown as ReceiptQrPayload
}

export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export function downloadSVG(svg: string, filename: string = "receipt.svg") {
  const blob = new Blob([svg], { type: "image/svg+xml" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
