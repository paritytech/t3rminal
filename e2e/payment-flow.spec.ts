import { merchantCustomerTest as test, expect } from './fixtures';
import { waitForAppReady, selectMerchantMode, navigateToTerminal, enterAmount } from './helpers';

test.describe('Payment flow — merchant to customer', () => {
  test('merchant generates a pUSD payment QR', async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await selectMerchantMode(frame);
    await navigateToTerminal(testHost);
    await enterAmount(frame, '1');

    await frame.locator('[data-testid="btn-generate-qr"]').click();

    await expect(
      frame.locator('[data-testid="waiting-text"]'),
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      frame.locator('[data-testid="qr-code"]'),
    ).toBeVisible();

    const qrContainer = frame.locator('[data-testid="qr-code"] svg');
    await expect(qrContainer).toBeVisible({ timeout: 10_000 });
    // Symbol comes from useAssetSymbol() → PUSD_SYMBOL ("CASH Token"), see lib/utils/asset-ids.ts
    await expect(
      frame.locator('[data-testid="qr-amount"]'),
    ).toHaveText('1 CASH Token');
  });
});
