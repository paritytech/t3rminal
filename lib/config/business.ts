/**
 * Merchant business profile shown on the printed receipt.
 *
 * Static for now — later this will move to a Settings page so the merchant
 * can edit it in-app. Tax rate is also configurable; 0 disables the tax
 * footer line entirely.
 */

export interface BusinessProfile {
  name: string
  addressLine1?: string
  addressLine2?: string
  phone?: string
  /** VAT / sales tax percent (e.g. 19 for 19%). 0 hides the tax footer. */
  taxRate: number
  /** Currency label printed on the receipt — separate from the on-chain
   *  asset symbol. Defaults to "CASH" for the test environment. */
  currency: string
  /** ISO 4217 currency code the receipt is denominated in (e.g. "EUR").
   *  Carried on the receipt deeplink as `currency=` while `currency` above
   *  is the printed label (`asset=`). */
  currencyCode: string
}

export const BUSINESS_PROFILE: BusinessProfile = {
  name: "Funkhaus Berlin Events GmbH",
  addressLine1: "Nalepastraße 18",
  addressLine2: "12459 Berlin",
  phone: "030/12085416",
  taxRate: 19,
  currency: "CASH",
  currencyCode: "EUR",
}
