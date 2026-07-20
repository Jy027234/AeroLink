import { test, expect } from '@playwright/test';

test('login validation errors are announced through an alert landmark', async ({ page }) => {
  await page.goto('/');

  await page.locator('form button[type="submit"]').click();

  const alert = page.getByRole('alert').first();
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/请输入邮箱和密码|Please enter email and password/i);
});

test('forgot-password validation errors are announced inside the dialog', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /忘记密码|Forgot password/i }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /发送重置邮件|Send reset email/i }).click();

  const alert = dialog.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/邮箱|email/i);
});
