import { test, expect } from '@playwright/test';

test.describe('Navigation', () => {
  const validUser = {
    email: 'zhang@aerolink.com',
    password: 'password123',
  };

  async function login(page: import('@playwright/test').Page, path = '/') {
    await page.goto(path);
    await page.fill('input[type="email"]', validUser.email);
    await page.fill('input[type="password"]', validUser.password);
    await page.click('button[type="submit"]');
  }

  async function navigateFromSidebar(
    page: import('@playwright/test').Page,
    groupLabel: string,
    itemLabel: RegExp,
  ) {
    const item = page.getByRole('button', { name: itemLabel });
    if (!(await item.isVisible())) {
      await page.getByRole('button', { name: groupLabel, exact: true }).click();
    }
    await item.click();
  }

  test('should navigate to RFQs page', async ({ page }) => {
    await login(page);
    await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
    await navigateFromSidebar(page, '寻源报价', /需求单管理/);
    await expect(page.getByRole('banner').getByRole('heading', { name: '需求单管理' })).toBeVisible();
  });

  test('should navigate to Orders page', async ({ page }) => {
    await login(page);
    await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
    await navigateFromSidebar(page, '订单与库存', /订单管理/);
    await expect(page.getByRole('banner').getByRole('heading', { name: '订单管理' })).toBeVisible();
  });

  test('should navigate to Inventory page', async ({ page }) => {
    await login(page);
    await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
    await navigateFromSidebar(page, '订单与库存', /库存中心/);
    await expect(page.getByRole('banner').getByRole('heading', { name: '库存中心' })).toBeVisible();
  });

  test('should preserve deep links, history, and reload state after login', async ({ page }) => {
    await login(page, '/orders');
    await expect(page).toHaveURL(/\/orders$/);
    await expect(page.getByRole('banner').getByRole('heading', { name: '订单管理' })).toBeVisible();

    await navigateFromSidebar(page, '客户与供应商', /客户管理/);
    await expect(page).toHaveURL(/\/customers$/);
    await expect(page.getByRole('banner').getByRole('heading', { name: '客户管理' })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/orders$/);
    await expect(page.getByRole('banner').getByRole('heading', { name: '订单管理' })).toBeVisible();

    await page.goForward();
    await expect(page).toHaveURL(/\/customers$/);
    await expect(page.getByRole('banner').getByRole('heading', { name: '客户管理' })).toBeVisible();

    await page.reload();
    await expect(page).toHaveURL(/\/customers$/);
    await expect(page.getByRole('banner').getByRole('heading', { name: '客户管理' })).toBeVisible();
  });
});
