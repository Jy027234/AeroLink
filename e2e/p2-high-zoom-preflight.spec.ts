import { test, expect, type Page } from '@playwright/test';

const E2E_PASSWORD = process.env.E2E_PASSWORD;
if (!E2E_PASSWORD) throw new Error('E2E_PASSWORD is required for seeded E2E tests.');

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
  const diagnostics = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const elements = Array.from(document.querySelectorAll<HTMLElement>('*'));
    const pageLevelRight = Math.max(
      viewport,
      ...elements
        .filter((element) => !element.closest('.overflow-x-auto'))
        .map((element) => Math.round(element.getBoundingClientRect().right))
    );
    const offenders = elements
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          className: element.className && typeof element.className === 'string' ? element.className.slice(0, 120) : '',
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          text: (element.innerText || '').trim().slice(0, 80),
          scrollContainer: Boolean(element.closest('.overflow-x-auto')),
        };
      })
      .filter((element) => element.right > viewport + 1 && !element.scrollContainer)
      .sort((left, right) => right.right - left.right)
      .slice(0, 8);
    return {
      viewport,
      pageLevelRight,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      offenders,
    };
  });
  expect(diagnostics.pageLevelRight, JSON.stringify(diagnostics)).toBeLessThanOrEqual(diagnostics.viewport + 1);
}

for (const scale of [2, 4] as const) {
  test(`P2 high-zoom ${scale * 100}% preflight has no page-level overflow`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page);

    for (const path of corePaths) {
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();
      // Let the authenticated Query-backed panels settle before capturing visual evidence.
      // This is intentionally bounded; the assertion below remains the page-level overflow gate.
      await page.waitForTimeout(750);
      await page.evaluate((zoom) => {
        document.documentElement.style.zoom = String(zoom);
      }, scale);
      await page.waitForTimeout(250);
      await expectNoPageOverflow(page);
      await page.screenshot({ path: `test-results/p2-high-zoom/${scale * 100}-${path.replace(/[^a-z0-9]+/gi, '-') || 'root'}.png`, fullPage: true });
      await page.evaluate(() => {
        document.documentElement.style.zoom = '';
      });
    }
  });
}
