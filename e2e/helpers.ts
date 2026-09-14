import type { TestHost } from '@parity/host-api-test-sdk/playwright';
import type { FrameLocator } from '@playwright/test';

const PRODUCT_PORT = '5199';

/**
 * Wait for the app to be fully ready inside the test host iframe:
 * 1. Host API connection established (product-sdk <-> host-container)
 * 2. Merchant home rendered after the account-driven redirect
 */
export async function waitForAppReady(
  testHost: TestHost,
  options?: { timeout?: number },
): Promise<FrameLocator> {
  const timeout = options?.timeout ?? 90_000;
  const frame = testHost.productFrame();

  // Wait for product-sdk to connect to host container
  await testHost.waitForConnection(timeout);

  // The connecting heading is transient; account resolution replaces this route.
  await frame
    .getByRole('link', { name: 'Payment', exact: true })
    .waitFor({ state: 'visible', timeout });

  return frame;
}

/**
 * Wait for the merchant home to be ready.
 *
 * There is no merchant/customer landing step anymore: once the host
 * connection resolves, `/` auto-redirects to the merchant home (`/items`).
 * This waits for that home to render (bottom nav present) instead of clicking
 * a (no-longer-existent) "merchant" button. Kept under the old name so the
 * specs read the same.
 */
export async function selectMerchantMode(
  frame: FrameLocator,
  options?: { timeout?: number },
): Promise<void> {
  const timeout = options?.timeout ?? 30_000;
  await frame
    .getByRole('link', { name: 'Payment', exact: true })
    .waitFor({ state: 'visible', timeout });
}

/**
 * Reports are no longer in the bottom nav — they live under
 * Settings → Reports & Backup → Save reports. Walk that path and wait for the
 * reports header.
 */
export async function openReports(
  frame: FrameLocator,
  options?: { timeout?: number },
): Promise<void> {
  const timeout = options?.timeout ?? 30_000;
  await frame.getByText('Settings').click();
  await frame.getByText('Reports & Backup').click();
  await frame.getByText('Save reports').click();
  await frame
    .locator('[data-testid="reports-header"]')
    .waitFor({ state: 'visible', timeout });
}

/**
 * Open the manual-amount keypad terminal (`/terminal`).
 *
 * The keypad is no longer reachable by a tap — the bottom-nav "Payment" goes
 * to `/items`, and "Charge" jumps straight to the QR with the cart total. So
 * we navigate the product iframe directly to `/terminal` to exercise the
 * keypad + QR generation.
 */
export async function navigateToTerminal(
  testHost: TestHost,
  options?: { timeout?: number },
): Promise<void> {
  const timeout = options?.timeout ?? 30_000;
  const productFrame = testHost
    .page
    .frames()
    .find((f) => f.url().includes(PRODUCT_PORT));
  if (!productFrame) throw new Error('navigateToTerminal: product frame not found');
  await productFrame.evaluate(() => {
    window.location.href = '/terminal';
  });
  await testHost
    .productFrame()
    .locator('[data-testid="terminal-header"]')
    .waitFor({ state: 'visible', timeout });
}

/**
 * Enter an amount via the calculator by clicking digit buttons.
 * Supports digits 0-9 and decimal point.
 *
 * @example enterAmount(frame, '12.50')
 */
export async function enterAmount(
  frame: FrameLocator,
  amount: string,
): Promise<void> {
  for (const char of amount) {
    if (char === '.') {
      await frame.locator('[data-testid="calc-decimal"]').click();
    } else if (char >= '0' && char <= '9') {
      await frame.locator(`[data-testid="calc-digit-${char}"]`).click();
    }
  }
}
