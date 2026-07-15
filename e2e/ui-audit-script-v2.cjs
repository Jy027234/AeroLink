const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const LOGIN_URL = 'http://127.0.0.1:5173';
const EMAIL = 'zhang@aerolink.com';
const PASSWORD = process.env.E2E_PASSWORD;
if (!PASSWORD) throw new Error('E2E_PASSWORD is required for the UI audit script.');
const OUTPUT_DIR = path.join(__dirname, '..', 'test-results', 'ui-audit');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const pages = [
  { id: 'dashboard', name: '仪表盘', keywords: ['dashboard', '仪表盘', '概览'] },
  { id: 'agent-workbench', name: 'AI工作台', keywords: ['agent', 'AI', '工作台'] },
  { id: 'ingestion', name: '需求归集', keywords: ['ingestion', '需求', '归集'] },
  { id: 'rfq-management', name: 'RFQ管理', keywords: ['rfq', 'RFQ'] },
  { id: 'sourcing', name: '智能寻源', keywords: ['sourcing', '寻源'] },
  { id: 'quotations', name: '报价管理', keywords: ['quotation', '报价'] },
  { id: 'orders', name: '订单管理', keywords: ['order', '订单'] },
  { id: 'order-tracking', name: '物流追踪', keywords: ['tracking', '物流', '追踪'] },
  { id: 'inventory', name: '库存中心', keywords: ['inventory', '库存'] },
  { id: 'exchange-vmi', name: '交换/VMI', keywords: ['exchange', 'vmi', '交换'] },
  { id: 'customers', name: '客户管理', keywords: ['customer', '客户'] },
  { id: 'suppliers', name: '供应商', keywords: ['supplier', '供应商'] },
  { id: 'supplier-quotes', name: '供应商报价', keywords: ['supplier quote', '供应商报价'] },
  { id: 'supplier-portal', name: '供应商门户', keywords: ['portal', '门户'] },
  { id: 'certificates', name: '证书管理', keywords: ['certificate', '证书'] },
  { id: 'certificate-templates', name: '证书模板', keywords: ['template', '模板'] },
  { id: 'workflows', name: '工作流', keywords: ['workflow', '工作流'] },
  { id: 'audit-logs', name: '审计日志', keywords: ['audit', '审计', '日志'] },
  { id: 'technical-kit', name: '技术资料', keywords: ['technical', '技术', '资料'] },
  { id: 'auctions', name: '拍卖', keywords: ['auction', '拍卖'] },
  { id: 'consignments', name: '寄售', keywords: ['consignment', '寄售'] },
  { id: 'pricing-bi', name: '定价/BI', keywords: ['pricing', '定价', 'BI'] },
  { id: 'api-platform', name: 'API平台', keywords: ['api', 'API', '平台'] },
  { id: 'fmv-platform', name: 'FMV平台', keywords: ['fmv', 'FMV'] },
  { id: 'blockchain-verification', name: '区块链验证', keywords: ['blockchain', '区块链'] },
  { id: 'reports', name: '报表中心', keywords: ['report', '报表'] },
  { id: 'settings', name: '系统设置', keywords: ['setting', '设置'] },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ 
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN'
  });
  const page = await context.newPage();

  console.log('Navigating to login page...');
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Debug: print page title and content
  const title = await page.title();
  console.log('Page title:', title);
  
  const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
  console.log('Body text preview:', bodyText);

  // Take login page screenshot
  await page.screenshot({ path: path.join(OUTPUT_DIR, '00-login.png'), fullPage: false });
  console.log('✓ Captured: login page');

  // Check if we're on login page
  const hasEmailInput = await page.locator('input[type="email"]').first().isVisible().catch(() => false);
  const hasPasswordInput = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
  
  console.log('Email input visible:', hasEmailInput);
  console.log('Password input visible:', hasPasswordInput);

  if (hasEmailInput && hasPasswordInput) {
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    
    // Find and click login button
    const loginBtn = page.locator('button').filter({ hasText: /登录|Login|Sign in/i }).first();
    await loginBtn.click();
    
    // Wait for navigation
    await page.waitForTimeout(4000);
    
    // Check if logged in
    const postLoginTitle = await page.title();
    console.log('Post-login title:', postLoginTitle);
    
    const postLoginBody = await page.evaluate(() => document.body.innerText.substring(0, 500));
    console.log('Post-login body preview:', postLoginBody);
    
    await page.screenshot({ path: path.join(OUTPUT_DIR, '01-post-login.png'), fullPage: false });
    console.log('✓ Captured: post-login');
  } else {
    console.log('Login form not found, might already be logged in or page structure different');
  }

  // Try to find all buttons on the page
  const allButtons = await page.locator('button').all();
  console.log(`\nFound ${allButtons.length} buttons on page`);
  
  for (let i = 0; i < Math.min(allButtons.length, 30); i++) {
    const text = await allButtons[i].textContent().catch(() => '');
    if (text.trim()) {
      console.log(`  Button ${i}: "${text.trim().substring(0, 50)}"`);
    }
  }

  // Try to capture each page
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    try {
      // Try multiple strategies to find the nav button
      let btn = null;
      
      // Strategy 1: exact text match
      for (const keyword of p.keywords) {
        const candidates = page.locator('button').filter({ hasText: new RegExp(keyword, 'i') });
        const count = await candidates.count().catch(() => 0);
        if (count > 0) {
          btn = candidates.first();
          break;
        }
      }
      
      if (btn && await btn.isVisible().catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(3000);
        
        await page.screenshot({ 
          path: path.join(OUTPUT_DIR, `${String(i + 2).padStart(2, '0')}-${p.id}.png`), 
          fullPage: false 
        });
        
        console.log(`✓ Captured: ${p.name}`);
      } else {
        console.log(`⚠ Not found: ${p.name}`);
      }
    } catch (e) {
      console.log(`✗ Failed: ${p.name} - ${e.message}`);
    }
  }

  await browser.close();
  console.log('\nDone! Screenshots saved to:', OUTPUT_DIR);
})();
