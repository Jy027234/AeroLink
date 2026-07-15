import { test, expect } from '@playwright/test';

const E2E_PASSWORD = process.env.E2E_PASSWORD;
if (!E2E_PASSWORD) throw new Error('E2E_PASSWORD is required for seeded E2E tests.');

test.describe('Authentication', () => {
  const validUser = {
    email: 'zhang@aerolink.com',
    password: E2E_PASSWORD,
  };

  test('should display login page', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('should show error on invalid credentials', async ({ page }) => {
    await page.goto('/');
    await page.fill('input[type="email"]', 'invalid@example.com');
    await page.fill('input[type="password"]', 'wrongpassword');
    await page.click('button[type="submit"]');
    await expect(page.getByText(/登录失败，请检查邮箱和密码|邮箱或密码错误|Login failed\. Please check your email and password\.|Invalid credentials/)).toBeVisible();
  });

  test('should login with valid credentials', async ({ page }) => {
    await page.goto('/');
    await page.fill('input[type="email"]', validUser.email);
    await page.fill('input[type="password"]', validUser.password);
    await page.click('button[type="submit"]');
    await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
  });

  test('should restore the session after reload without persisting an access token', async ({ page }) => {
    await page.goto('/');
    await page.fill('input[type="email"]', validUser.email);
    await page.fill('input[type="password"]', validUser.password);
    await page.click('button[type="submit"]');
    await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem('aerolink_token'))).toBeNull();

    await page.reload();

    await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem('aerolink_token'))).toBeNull();
  });
});
