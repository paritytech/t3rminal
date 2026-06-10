/**
 * Receipt QR is a W3sPay save-receipt deeplink (not the legacy JSON envelope).
 * These pin the wire contract the W3sPay reader parses: short query keys in the
 * URL fragment, repeated `i` items as `name|quantity|unitPrice`, and the `+`/%XX
 * encoding `URLSearchParams` produces on both ends.
 */

import { describe, expect, it } from "vitest";

import {
  buildReceiptDeeplink,
  SAVE_RECEIPT_DEEPLINK_HOST,
  type ReceiptData,
} from "@/lib/receipts/receipt-generator";
import type { BusinessProfile } from "@/lib/config/business";

const business: BusinessProfile = {
  name: "Krusty Krab Pizza",
  addressLine1: "12 Bikiini Bottom",
  addressLine2: "12459 Berlin",
  phone: "0112312312",
  taxRate: 19,
  currency: "EUR",
};

const data: ReceiptData = {
  amount: "14.50",
  asset: "CASH",
  merchant: business.name,
  merchantAddress: "5DfXxr1Npfj42NDof2SFvMZ9DAWifjgA5NHTdb3FtjYpj7hr",
  customerAddress: "5CustomerAddr",
  transactionId: "tx-1",
  saleId: "01KTQ4VZJMGY2SKYNPDTTFJ034",
  blockNumber: 566207,
  items: [
    { name: "Pierogi (8 Stück)", quantity: 1, unitPrice: "9.00" },
    { name: "Bratkartoffeln", quantity: 1, unitPrice: "5.50" },
  ],
};

const ts = new Date("2026-06-09T21:33:27.508Z");

function fragmentParams(url: string): URLSearchParams {
  const u = new URL(url);
  return new URLSearchParams(u.hash.slice(u.hash.indexOf("?") + 1));
}

describe("buildReceiptDeeplink", () => {
  it("emits a save-receipt fragment deeplink with the short-key contract", () => {
    const url = buildReceiptDeeplink(data, business, ts);
    expect(
      url.startsWith(`polkadotapp://${SAVE_RECEIPT_DEEPLINK_HOST}/#/save-receipt?`),
    ).toBe(true);

    const u = new URL(url);
    expect(u.pathname).toBe("/");
    expect(u.hash.startsWith("#/save-receipt?")).toBe(true);

    const q = fragmentParams(url);
    expect(q.get("v")).toBe("1");
    expect(q.get("id")).toBe("01KTQ4VZJMGY2SKYNPDTTFJ034");
    expect(q.get("a")).toBe("14.50");
    expect(q.get("as")).toBe("CASH");
    expect(q.get("c")).toBe("EUR");
    expect(q.get("t")).toBe("19");
    expect(q.get("ts")).toBe("2026-06-09T21:33:27.508Z");
    expect(q.get("bn")).toBe("Krusty Krab Pizza");
    expect(q.get("a1")).toBe("12 Bikiini Bottom");
    expect(q.get("a2")).toBe("12459 Berlin");
    expect(q.get("tel")).toBe("0112312312");
    expect(q.get("bk")).toBe("566207");
    expect(q.get("m")).toBe("5DfXxr1Npfj42NDof2SFvMZ9DAWifjgA5NHTdb3FtjYpj7hr");
    expect(q.getAll("i")).toEqual([
      "Pierogi (8 Stück)|1|9.00",
      "Bratkartoffeln|1|5.50",
    ]);
  });

  it("encodes item specials the way the W3sPay reader decodes them", () => {
    const url = buildReceiptDeeplink(data, business, ts);
    expect(url).toContain("i=Pierogi+%288+St%C3%BCck%29%7C1%7C9.00");
    expect(url).toContain("i=Bratkartoffeln%7C1%7C5.50");
  });

  it("omits the id and optional fields when absent", () => {
    const url = buildReceiptDeeplink(
      {
        amount: "1.00",
        asset: "CASH",
        merchant: "",
        merchantAddress: "",
        customerAddress: "",
        transactionId: "",
      },
      { name: "", taxRate: 0, currency: "CASH" },
      ts,
    );
    const q = fragmentParams(url);
    expect(q.has("id")).toBe(false);
    expect(q.has("bn")).toBe(false);
    expect(q.has("i")).toBe(false);
    expect(q.has("m")).toBe(false);
    expect(q.get("a")).toBe("1.00");
    expect(q.get("t")).toBe("0");
  });
});
