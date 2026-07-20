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

async function activeElementSnapshot(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    const rect = element?.getBoundingClientRect();
    const style = element ? getComputedStyle(element) : null;
    return {
      tagName: element?.tagName,
      role: element?.getAttribute('role'),
      visible: Boolean(element && rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden'),
      focusIndicator: Boolean(style && (style.outlineStyle !== 'none' || style.boxShadow !== 'none')),
    };
  });
}

test('mobile navigation traps focus and restores it after Escape', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await login(page);

  const menuTrigger = page.getByRole('button', { name: /打开导航菜单|Open navigation menu/ });
  await menuTrigger.click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();

  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('Tab');
    const snapshot = await activeElementSnapshot(page);
    expect(snapshot.visible, `tab stop ${index + 1} must remain visible`).toBe(true);
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(menuTrigger).toBeFocused();
});

test('header account menu exposes visible keyboard focus and returns focus on Escape', async ({ page }) => {
  await login(page);
  const accountTrigger = page.getByRole('button', { name: /我的账户|My account/i });
  await accountTrigger.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();

  const snapshot = await activeElementSnapshot(page);
  expect(snapshot.visible).toBe(true);
  expect(snapshot.focusIndicator).toBe(true);
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="menu"]')))).toBe(true);

  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(accountTrigger).toBeFocused();
});
