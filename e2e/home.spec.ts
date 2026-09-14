import { merchantTest as test, expect } from './fixtures';
import { waitForAppReady, selectMerchantMode } from './helpers';

test.describe('Home page loads via Host API', () => {
  test('opens the empty merchant catalog after host connection', async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);

    await expect(frame.getByRole('heading', { name: 'No items yet' })).toBeVisible();
    await expect(frame.getByRole('link', { name: 'Go to Admin Configuration' }))
      .toHaveAttribute('href', '/settings/admin-config/');
  });

  test('auto-redirects to the merchant home with bottom nav', async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);

    // Once the host connection resolves, `/` auto-redirects to /items.
    await selectMerchantMode(frame);

    // Bottom nav links should be visible on the merchant home. (Reports moved
    // out of the nav into Settings → Reports & Backup.)
    await expect(frame.getByRole('link', { name: 'Payment', exact: true })).toBeVisible();
    await expect(frame.getByText('History')).toBeVisible();
    await expect(frame.getByText('Settings')).toBeVisible();
  });
});
