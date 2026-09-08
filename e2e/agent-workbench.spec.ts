import { test, expect, type Page } from '@playwright/test';

const E2E_PASSWORD = process.env.E2E_PASSWORD;
if (!E2E_PASSWORD) throw new Error('E2E_PASSWORD is required for seeded E2E tests.');
const API_ORIGIN = process.env.PLAYWRIGHT_API_ORIGIN
  ?? (process.env.PLAYWRIGHT_EXTERNAL === 'true'
    ? ''
    : `http://127.0.0.1:${process.env.PLAYWRIGHT_BACKEND_PORT || '3000'}`);

const validUser = {
  email: 'zhang@aerolink.com',
  password: E2E_PASSWORD,
};

async function login(page: Page) {
  await page.goto('/');
  await page.fill('input[type="email"]', validUser.email);
  await page.fill('input[type="password"]', validUser.password);
  await page.click('button[type="submit"]');
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
}

async function navigateToAgentWorkbench(page: Page) {
  // Navigation is rendered only after the server-issued capability snapshot is
  // loaded. Wait for that state rather than toggling the unrelated locale menu.
  const agentWorkbenchButton = page.getByRole('button', { name: /AGENT工作台|AI Agent Workbench/ });
  await expect(agentWorkbenchButton).toBeVisible();
  await agentWorkbenchButton.click();

  await expect(page.getByRole('heading', { name: /AGENT工作台|智能航材销售AGENT|AI Agent Workbench/ })).toBeVisible();
}

async function getRfqSnapshot(page: Page) {
  return page.evaluate(async (apiOrigin) => {
    const apiBase = apiOrigin ? `${apiOrigin}/api` : '/api';
    const refreshResponse = await fetch(`${apiBase}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    const refreshPayload = await refreshResponse.json();
    const token = refreshPayload.data?.accessToken ?? refreshPayload.accessToken;

    if (!refreshResponse.ok || !token) {
      throw new Error(`Refresh request failed: ${refreshResponse.status}`);
    }

    const response = await fetch(`${apiBase}/rfqs`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    if (!response.ok) {
      throw new Error(`RFQ request failed: ${response.status}`);
    }

    const payload = await response.json();
    const rfqs = Array.isArray(payload.data) ? payload.data : [];

    return {
      count: rfqs.length,
      latestRfqNumber: rfqs[0]?.rfqNumber ?? null,
    };
  }, API_ORIGIN);
}

test.describe('Agent Workbench', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateToAgentWorkbench(page);
  });

  test('runtime assistant is view-only and cannot create an RFQ', async ({ page }) => {
    test.slow();

    const before = await getRfqSnapshot(page);

    const runtimeButton = page.getByTestId('agent-runtime-disabled');
    await expect(runtimeButton).toBeVisible();
    await expect(runtimeButton).toBeDisabled();
    await expect(runtimeButton).toContainText(/助手执行已暂停|Assistant execution paused/);

    // The former demo action must not remain as an executable client entry point.
    await expect(page.getByTestId('agent-run-demo')).toHaveCount(0);
    await expect(page.getByTestId('agent-confirmation-panel')).toHaveCount(0);

    const after = await getRfqSnapshot(page);
    expect(after.count).toBe(before.count);
  });
});
