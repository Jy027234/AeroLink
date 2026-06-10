import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
  const validUser = {
    email: 'zhang@aerolink.com',
    password: 'password123',
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
    await expect(page.getByText('登录失败，请检查邮箱和密码')).toBeVisible();
  });

  test('should login with valid credentials', async ({ page }) => {
    await page.goto('/');
    await page.fill('input[type="email"]', validUser.email);
    await page.fill('input[type="password"]', validUser.password);
    await page.click('button[type="submit"]');
    await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
  });
});
