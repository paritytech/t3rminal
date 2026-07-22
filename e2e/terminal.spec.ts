import { merchantTest as test, expect } from './fixtures';
import { waitForAppReady, selectMerchantMode, navigateToTerminal, enterAmount } from './helpers';

test.describe('Terminal — calculator and QR generation', () => {
  test('navigates to terminal and shows header', async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await selectMerchantMode(frame);

    // Navigate to terminal via bottom nav
    await navigateToTerminal(testHost);
  });

  test('enters digits via calculator and displays amount', async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await selectMerchantMode(frame);
    await navigateToTerminal(testHost);

    // Enter "42"
    await enterAmount(frame, '42');

    await expect(
      frame.locator('[data-testid="amount-display"]'),
    ).toHaveText('42');
  });

  test('enters decimal amount', async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await selectMerchantMode(frame);
    await navigateToTerminal(testHost);

    // Enter "12.50"
    await enterAmount(frame, '12.50');

    await expect(
      frame.locator('[data-testid="amount-display"]'),
    ).toHaveText('12.50');
  });

  test('backspace removes last digit', async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await selectMerchantMode(frame);
    await navigateToTerminal(testHost);

    await enterAmount(frame, '123');
    await expect(frame.locator('[data-testid="amount-display"]')).toHaveText('123');

    await frame.locator('[data-testid="calc-backspace"]').click();
    await expect(frame.locator('[data-testid="amount-display"]')).toHaveText('12');
  });

  test('Generate QR Code button is disabled with zero amount', async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await selectMerchantMode(frame);
    await navigateToTerminal(testHost);

    await expect(
      frame.locator('[data-testid="btn-generate-qr"]'),
    ).toBeDisabled();
  });

  test('generates QR code and shows waiting state', async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await selectMerchantMode(frame);
    await navigateToTerminal(testHost);

    // Enter an amount
    await enterAmount(frame, '5');

    // Generate QR
    await frame.locator('[data-testid="btn-generate-qr"]').click();

    // Should transition to QR / waiting state
    await expect(
      frame.locator('[data-testid="waiting-text"]'),
    ).toBeVisible({ timeout: 15_000 });

    // Amount should be displayed — symbol is PUSD_SYMBOL ("CASH Token"), see lib/utils/asset-ids.ts
    await expect(
      frame.locator('[data-testid="qr-amount"]'),
    ).toHaveText('5 CASH Token');

    // QR code container should be visible
    await expect(
      frame.locator('[data-testid="qr-code"]'),
    ).toBeVisible();
  });
});
