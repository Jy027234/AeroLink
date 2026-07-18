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

  test('controlled demo creates a real RFQ only after confirmation', async ({ page }) => {
    test.slow();

    const before = await getRfqSnapshot(page);

    await page.getByTestId('agent-run-demo').click();

    const confirmationPanel = page.getByTestId('agent-confirmation-panel');
    await expect(confirmationPanel).toBeVisible();
    await expect(page.getByTestId('agent-confirmation-title')).toHaveText('需求单生成确认');
    await expect(confirmationPanel).toContainText('海南航空');

    const beforeConfirm = await getRfqSnapshot(page);
    expect(beforeConfirm.count).toBe(before.count);
    await expect(page.getByTestId('agent-confirm-submit')).toHaveText('确认生成');

    await page.getByTestId('agent-confirm-submit').click();

    await expect.poll(async () => (await getRfqSnapshot(page)).count, {
      timeout: 30000,
      message: 'RFQ count should increase only after confirmation',
    }).toBe(before.count + 1);

    const afterConfirm = await getRfqSnapshot(page);
    expect(afterConfirm.latestRfqNumber).toBeTruthy();

    await expect(page.getByText(afterConfirm.latestRfqNumber!).first()).toBeVisible();
    await expect(page.getByText('Skyline Aero Trading')).toHaveCount(0);
  });
});
