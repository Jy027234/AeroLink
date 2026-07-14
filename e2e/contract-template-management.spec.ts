import { expect, test } from '@playwright/test';

const managerUser = {
  email: 'zhang@aerolink.com',
  password: 'password123',
};

async function loginByUi(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.fill('input[type="email"]', managerUser.email);
  await page.fill('input[type="password"]', managerUser.password);
  await page.click('button[type="submit"]');
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
}

test('should show a localized alert and keep the template dialog open when contract template save fails', async ({ page }) => {
  const uniqueSuffix = Date.now();
  const templateName = `Playwright 合同模板 ${uniqueSuffix}`;
  const templateCode = `PW-CONTRACT-${uniqueSuffix}`;

  await loginByUi(page);
  await page.getByRole('button', { name: /系统设置/ }).click();
  await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible();

  await page.getByRole('tab', { name: '合同模板' }).click();
  await expect(page.getByRole('main').getByText('订单合同模板管理')).toBeVisible();

  await page.route('**/api/document-templates', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        message: 'forced template save failure',
      }),
    });
  });

  await page.getByRole('button', { name: '新建模板' }).click();
  const templateDialog = page.getByRole('dialog');
  await expect(templateDialog.getByRole('heading', { name: '新建合同模板' })).toBeVisible();

  await templateDialog.locator('input').nth(0).fill(templateName);
  await templateDialog.locator('input').nth(1).fill(templateCode);
  await templateDialog.locator('textarea').first().fill('<table><tr><td>{{customer.name}}</td><td>{{quotation.quoteNumber}}</td></tr></table>');

  await templateDialog.getByRole('button', { name: '保存模板' }).click();
  const errorToast = page.locator('[data-sonner-toast]').filter({ hasText: '保存失败，请检查模板内容。' }).last();
  await expect(errorToast).toBeVisible();

  await expect(templateDialog.getByRole('heading', { name: '新建合同模板' })).toBeVisible();
  await templateDialog.getByRole('button', { name: '取消' }).click();
  await expect(page.locator('table')).not.toContainText(templateCode);
});

test('should show a retryable error banner when contract templates fail to load', async ({ page }) => {
  let remainingFailures = 1;

  await page.route('**/api/document-templates*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }

    if (remainingFailures > 0) {
      remainingFailures -= 1;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          message: 'forced contract template load failure',
        }),
      });
      return;
    }

    await route.continue();
  });

  await loginByUi(page);
  await page.getByRole('button', { name: /系统设置/ }).click();
  await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible();

  await page.getByRole('tab', { name: '合同模板' }).click();
  const errorBanner = page.getByRole('alert').filter({ hasText: '合同模板加载失败' });
  await expect(errorBanner).toBeVisible();
  await expect(errorBanner).toContainText('当前模板列表可能不是最新，请重试。');

  await errorBanner.getByRole('button', { name: '重试加载' }).click();

  await expect(errorBanner).toHaveCount(0);
  await expect(page.locator('table')).toContainText('default-order-contract');
});
