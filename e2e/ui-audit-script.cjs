const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const LOGIN_URL = 'http://127.0.0.1:8080';
const EMAIL = 'zhang@aerolink.com';
const PASSWORD = 'password123';
const OUTPUT_DIR = path.join(__dirname, '..', 'test-results', 'ui-audit');

// Ensure output directory exists
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const pages = [
  { id: 'dashboard', name: '仪表盘' },
  { id: 'agent-workbench', name: 'AI工作台' },
  { id: 'ingestion', name: '需求归集' },
  { id: 'rfq-management', name: 'RFQ管理' },
  { id: 'sourcing', name: '智能寻源' },
  { id: 'quotations', name: '报价管理' },
  { id: 'orders', name: '订单管理' },
  { id: 'order-tracking', name: '物流追踪' },
  { id: 'inventory', name: '库存中心' },
  { id: 'exchange-vmi', name: '交换/VMI' },
  { id: 'customers', name: '客户管理' },
  { id: 'suppliers', name: '供应商' },
  { id: 'supplier-quotes', name: '供应商报价' },
  { id: 'supplier-portal', name: '供应商门户' },
  { id: 'certificates', name: '证书管理' },
  { id: 'certificate-templates', name: '证书模板' },
  { id: 'workflows', name: '工作流' },
  { id: 'audit-logs', name: '审计日志' },
  { id: 'technical-kit', name: '技术资料' },
  { id: 'auctions', name: '拍卖' },
  { id: 'consignments', name: '寄售' },
  { id: 'pricing-bi', name: '定价/BI' },
  { id: 'api-platform', name: 'API平台' },
  { id: 'fmv-platform', name: 'FMV平台' },
  { id: 'blockchain-verification', name: '区块链验证' },
  { id: 'reports', name: '报表中心' },
  { id: 'settings', name: '系统设置' },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  console.log('Navigating to login page...');
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Take login page screenshot
  await page.screenshot({ path: path.join(OUTPUT_DIR, '00-login.png'), fullPage: true });
  console.log('✓ Captured: login page');

  // Fill login form
  const emailInput = page.locator('input[type="email"]').first();
  const passwordInput = page.locator('input[type="password"]').first();
  
  if (await emailInput.isVisible().catch(() => false)) {
    await emailInput.fill(EMAIL);
    await passwordInput.fill(PASSWORD);
    
    const loginBtn = page.locator('button:has-text("登录"), button[type="submit"]').first();
    await loginBtn.click();
    await page.waitForTimeout(3000);
    
    // Take post-login screenshot
    await page.screenshot({ path: path.join(OUTPUT_DIR, '01-post-login.png'), fullPage: true });
    console.log('✓ Captured: post-login dashboard');
  }

  // Capture each page by clicking nav items
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    try {
      // Find nav button by text
      const btn = page.locator('button', { hasText: new RegExp(p.name) }).first();
      
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(2500);
        
        // Scroll to bottom to capture full page
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(500);
        
        await page.screenshot({ 
          path: path.join(OUTPUT_DIR, `${String(i + 2).padStart(2, '0')}-${p.id}.png`), 
          fullPage: true 
        });
        
        console.log(`✓ Captured: ${p.name} (${p.id})`);
      } else {
        console.log(`⚠ Button not visible: ${p.name}`);
      }
    } catch (e) {
      console.log(`✗ Failed: ${p.name} - ${e.message}`);
    }
  }

  // Also try to find and click common buttons/dialogs on each page
  console.log('\n--- Checking for dialogs and buttons ---');
  
  // Go back to dashboard and check for buttons
  const dashboardBtn = page.locator('button', { hasText: /仪表盘/ }).first();
  if (await dashboardBtn.isVisible().catch(() => false)) {
    await dashboardBtn.click();
    await page.waitForTimeout(2000);
  }

  await browser.close();
  console.log('\nDone! Screenshots saved to:', OUTPUT_DIR);
})();
