import { test as base, type Page } from '@playwright/test';
import {
  createTestHostFixture,
  PASEO_ASSET_HUB,
  type TestHost,
} from '@parity/host-api-test-sdk/playwright';

// Inject the E2E tag into every page so Sentry can exclude synthetic traffic.
const taggedBase = base.extend<{ page: Page }>({
  // eslint-disable-next-line no-empty-pattern
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      (window as unknown as { __T3RMINAL_E2E_TAG?: string }).__T3RMINAL_E2E_TAG =
        "e2e-t3rminal";
    });
    await use(page);
  },
});

// ── Target selection via E2E_TARGET env var ──────────────────────────
// Default: Paseo Asset Hub testnet

const PRODUCT_URL = 'http://localhost:5199';

// ── Fixtures ────────────────────────────────────────────────────────

/** Bob fixture — merchant account (generates QR, receives payments) */
const bobFixture = createTestHostFixture({
  productUrl: PRODUCT_URL,
  accounts: ['bob'],
  networks: [PASEO_ASSET_HUB],
});

/** Charlie fixture — customer account (pays via /pay page) */
const charlieFixture = createTestHostFixture({
  productUrl: PRODUCT_URL,
  accounts: ['charlie'],
  networks: [PASEO_ASSET_HUB],
});

/** Multi-account fixture — Bob (merchant, default) + Charlie (customer, switchable) */
const bobCharlieFixture = createTestHostFixture({
  productUrl: PRODUCT_URL,
  accounts: ['bob', 'charlie'],
  networks: [PASEO_ASSET_HUB],
});

/** Merchant test — Bob */
export const merchantTest = taggedBase.extend<{ testHost: TestHost }>(bobFixture);

/** Customer test — Charlie */
export const customerTest = taggedBase.extend<{ testHost: TestHost }>(charlieFixture);

/** Merchant+Customer test — starts as Bob, can switchAccount('charlie') */
export const merchantCustomerTest = taggedBase.extend<{ testHost: TestHost }>(bobCharlieFixture);

export { expect } from '@playwright/test';
