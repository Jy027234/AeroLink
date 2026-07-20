import { test, expect, type Page } from '@playwright/test';

const E2E_PASSWORD = process.env.E2E_PASSWORD;
if (!E2E_PASSWORD) throw new Error('E2E_PASSWORD is required for seeded E2E tests.');

async function login(page: Page) {
  await page.goto('/');
  await page.fill('input[type="email"]', 'zhang@aerolink.com');
  await page.fill('input[type="password"]', E2E_PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page.locator('main')).toBeVisible();
}

test('Settings tabs are deep-linkable and participate in browser history', async ({ page }) => {
  await login(page);

  await page.goto('/settings?tab=notifications');
  await expect(page).toHaveURL(/\/settings\?tab=notifications$/);
  await expect(page.getByRole('tab', { name: /资料|Profile/ })).toBeVisible();

  await page.getByRole('tab', { name: /资料|Profile/ }).click();
  await expect(page).toHaveURL(/\/settings\?tab=profile$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/settings\?tab=notifications$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/settings\?tab=profile$/);
});

test('unknown Settings tabs normalize without rendering a restricted panel', async ({ page }) => {
  await login(page);

  await page.goto('/settings?tab=not-a-real-tab');
  await expect(page).toHaveURL(/\/settings\?tab=profile$/);
  await expect(page.getByRole('tab', { name: /资料|Profile/ })).toHaveAttribute('data-state', 'active');
  await expect(page.getByRole('tabpanel')).toBeVisible();
});
