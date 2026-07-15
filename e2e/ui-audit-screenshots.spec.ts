import { test } from '@playwright/test';

const LOGIN_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5173';
const EMAIL = 'zhang@aerolink.com';
const PASSWORD = process.env.E2E_PASSWORD;
if (!PASSWORD) throw new Error('E2E_PASSWORD is required for seeded E2E tests.');

// All pages from the sidebar navigation
const pages = [
  { id: 'dashboard', name: '仪表盘', selector: 'button:has-text("仪表盘")' },
  { id: 'agent-workbench', name: 'AI工作台', selector: 'button:has-text("AI工作台")' },
  { id: 'ingestion', name: '需求归集', selector: 'button:has-text("需求归集")' },
  { id: 'rfq-management', name: 'RFQ管理', selector: 'button:has-text("RFQ管理")' },
  { id: 'sourcing', name: '智能寻源', selector: 'button:has-text("智能寻源")' },
  { id: 'quotations', name: '报价管理', selector: 'button:has-text("报价管理")' },
  { id: 'orders', name: '订单管理', selector: 'button:has-text("订单管理")' },
  { id: 'order-tracking', name: '物流追踪', selector: 'button:has-text("物流追踪")' },
  { id: 'inventory', name: '库存中心', selector: 'button:has-text("库存中心")' },
  { id: 'exchange-vmi', name: '交换/VMI', selector: 'button:has-text("交换/VMI")' },
  { id: 'customers', name: '客户管理', selector: 'button:has-text("客户管理")' },
  { id: 'suppliers', name: '供应商', selector: 'button:has-text("供应商")' },
  { id: 'supplier-quotes', name: '供应商报价', selector: 'button:has-text("供应商报价")' },
  { id: 'supplier-portal', name: '供应商门户', selector: 'button:has-text("供应商门户")' },
  { id: 'certificates', name: '证书管理', selector: 'button:has-text("证书管理")' },
  { id: 'certificate-templates', name: '证书模板', selector: 'button:has-text("证书模板")' },
  { id: 'workflows', name: '工作流', selector: 'button:has-text("工作流")' },
  { id: 'audit-logs', name: '审计日志', selector: 'button:has-text("审计日志")' },
  { id: 'technical-kit', name: '技术资料', selector: 'button:has-text("技术资料")' },
  { id: 'auctions', name: '拍卖', selector: 'button:has-text("拍卖")' },
  { id: 'consignments', name: '寄售', selector: 'button:has-text("寄售")' },
  { id: 'pricing-bi', name: '定价/BI', selector: 'button:has-text("定价/BI")' },
  { id: 'api-platform', name: 'API平台', selector: 'button:has-text("API平台")' },
  { id: 'fmv-platform', name: 'FMV平台', selector: 'button:has-text("FMV平台")' },
  { id: 'blockchain-verification', name: '区块链验证', selector: 'button:has-text("区块链验证")' },
  { id: 'reports', name: '报表中心', selector: 'button:has-text("报表中心")' },
  { id: 'settings', name: '系统设置', selector: 'button:has-text("系统设置")' },
];

test.describe('UI Audit - Page Screenshots', () => {
  test('login and capture all pages', async ({ page }) => {
    // Login
    await page.goto(LOGIN_URL);
    await page.waitForTimeout(2000);
    
    // Fill login form
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="邮箱"]').first();
    const passwordInput = page.locator('input[type="password"], input[name="password"]').first();
    
    if (await emailInput.isVisible().catch(() => false)) {
      await emailInput.fill(EMAIL);
      await passwordInput.fill(PASSWORD);
      
      // Click login button
      const loginBtn = page.locator('button:has-text("登录"), button[type="submit"]').first();
      await loginBtn.click();
      await page.waitForTimeout(3000);
    }
    
    // Take screenshot of each page
    for (const p of pages) {
      try {
        // Try to click the nav item
        const navBtn = page.locator(`nav ${p.selector}, aside ${p.selector}, [class*="sidebar"] ${p.selector}`).first();
        
        // If not found, try by text content anywhere
        const altBtn = page.locator(`button:has-text("${p.name}")`).first();
        
        const btn = await navBtn.isVisible().catch(() => false) ? navBtn : altBtn;
        
        if (await btn.isVisible().catch(() => false)) {
          await btn.click();
          await page.waitForTimeout(2000);
          
          // Take full page screenshot
          await page.screenshot({ 
            path: `test-results/ui-audit/${p.id}.png`, 
            fullPage: true 
          });
          
          console.log(`✓ Captured: ${p.name} (${p.id})`);
        } else {
          // Try direct URL navigation as fallback
          console.log(`⚠ Nav button not found for: ${p.name}, trying direct navigation`);
        }
      } catch (e) {
        console.log(`✗ Failed: ${p.name} - ${e.message}`);
      }
    }
  });
});
