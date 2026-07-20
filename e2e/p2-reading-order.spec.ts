import { test, expect, type Page } from '@playwright/test';

const E2E_PASSWORD = process.env.E2E_PASSWORD;
if (!E2E_PASSWORD) throw new Error('E2E_PASSWORD is required for seeded E2E tests.');

async function login(page: Page) {
  await page.goto('/');
  await page.fill('input[type="email"]', 'zhang@aerolink.com');
  await page.fill('input[type="password"]', E2E_PASSWORD!);
  await page.click('button[type="submit"]');
  await expect(page.locator('main')).toBeVisible();
}

test('mobile tab order keeps visible controls named and follows the page content', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await login(page);
  await page.goto('/dashboard');
  await expect(page.locator('main')).toBeVisible();
  await expect(page.getByText(/销售漏斗|Sales funnel/i)).toBeVisible();

  const structure = await page.evaluate(() => {
    const banner = document.querySelector('header, [role="banner"]');
    const main = document.querySelector('main');
    const heading = banner?.querySelector('h1, h2, h3, [role="heading"]');
    const firstInteractive = main?.querySelector('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    return {
      hasHeading: Boolean(heading && (heading.textContent || '').trim()),
      headingBeforeMain: Boolean(
        heading
        && main
        && (heading.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING),
      ),
      firstInteractiveInMain: Boolean(firstInteractive),
    };
  });
  expect(structure).toEqual({ hasHeading: true, headingBeforeMain: true, firstInteractiveInMain: true });

  const tabStops: Array<{ tag: string; name: string; visible: boolean; disabled: boolean }> = [];
  for (let index = 0; index < 20; index += 1) {
    await page.keyboard.press('Tab');
    tabStops.push(await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      const rect = element?.getBoundingClientRect();
      const style = element ? getComputedStyle(element) : null;
      const input = element as HTMLInputElement | null;
      const name = element?.getAttribute('aria-label')
        || element?.getAttribute('title')
        || input?.labels?.[0]?.textContent?.trim()
        || element?.textContent?.trim()
        || '';
      return {
        tag: element?.tagName.toLowerCase() || '',
        name,
        visible: Boolean(element && rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden'),
        disabled: Boolean(input?.disabled || element?.getAttribute('aria-disabled') === 'true'),
      };
    }));
  }

  expect(tabStops).toHaveLength(20);
  expect(tabStops.every((stop) => stop.visible)).toBe(true);
  expect(tabStops.every((stop) => stop.disabled || stop.name.length > 0)).toBe(true);
});
