import { AxeBuilder } from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';

const E2E_PASSWORD = process.env.E2E_PASSWORD;
if (!E2E_PASSWORD) throw new Error('E2E_PASSWORD is required for seeded E2E tests.');

const viewports = [
  { name: 'mobile', width: 360, height: 800 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

const corePaths = [
  '/dashboard',
  '/rfq-management',
  '/quotations',
  '/orders',
  '/inventory',
  '/supplier-information',
  '/settings?tab=profile',
] as const;

async function login(page: Page) {
  await page.goto('/');
  await page.fill('input[type="email"]', 'zhang@aerolink.com');
  await page.fill('input[type="password"]', E2E_PASSWORD!);
  await page.click('button[type="submit"]');
  await expect(page.locator('main')).toBeVisible();
}

async function expectNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));

  expect(dimensions.documentWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.bodyWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport + 1);
}

for (const viewport of viewports) {
  test(`P2 core pages fit ${viewport.name} viewport and expose no serious axe findings`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await login(page);

    for (const path of corePaths) {
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();
      await expectNoPageOverflow(page);
    }

    const axeResults = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    const seriousFindings = axeResults.violations.filter((violation) => ['critical', 'serious'].includes(violation.impact ?? ''));

    expect(seriousFindings, JSON.stringify(seriousFindings, null, 2)).toEqual([]);
  });
}
