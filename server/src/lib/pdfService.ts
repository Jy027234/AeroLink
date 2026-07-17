import puppeteer, { Browser } from 'puppeteer';
import { logger } from './logger.js';

// --- Browser singleton pool ---

let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  browserInstance = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  logger.info('Puppeteer browser instance created');

  return browserInstance;
}

async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    try {
      await browserInstance.close();
      logger.info('Puppeteer browser instance closed');
    } catch (err) {
      logger.error({ err }, 'Error closing browser');
    } finally {
      browserInstance = null;
    }
  }
}

// Graceful shutdown: close browser on process termination signals
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, closing browser...');
  closeBrowser().then(() => process.exit(0));
});
process.on('SIGINT', () => {
  logger.info('SIGINT received, closing browser...');
  closeBrowser().then(() => process.exit(0));
});

// --- PDF generation ---

export interface PDFOptions {
  header?: string;
  footer?: string;
  title?: string;
  margin?: {
    top?: string;
    right?: string;
    bottom?: string;
    left?: string;
  };
}

export async function generatePDF(html: string, options: PDFOptions = {}): Promise<Buffer> {
  const browser = await getBrowser();

  const page = await browser.newPage();
  try {
    const fullHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${options.title || 'AeroLink Document'}</title>
  <style>
    @page {
      margin: ${options.margin?.top || '20mm'} ${options.margin?.right || '15mm'} ${options.margin?.bottom || '20mm'} ${options.margin?.left || '15mm'};
    }
    body {
      font-family: 'Microsoft YaHei', 'SimSun', sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: #333;
    }
    .header {
      text-align: center;
      border-bottom: 2px solid #1e3a5f;
      padding-bottom: 10px;
      margin-bottom: 20px;
    }
    .header h1 {
      color: #1e3a5f;
      font-size: 24px;
      margin: 0;
    }
    .header .subtitle {
      color: #666;
      font-size: 12px;
      margin-top: 5px;
    }
    .section {
      margin-bottom: 20px;
    }
    .section-title {
      font-size: 16px;
      font-weight: bold;
      color: #1e3a5f;
      border-left: 4px solid #1e3a5f;
      padding-left: 10px;
      margin-bottom: 10px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 15px;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 8px 12px;
      text-align: left;
    }
    th {
      background-color: #f5f5f5;
      font-weight: bold;
    }
    .footer {
      margin-top: 30px;
      padding-top: 10px;
      border-top: 1px solid #ddd;
      font-size: 12px;
      color: #999;
      text-align: center;
    }
    .highlight {
      background-color: #fff3cd;
      padding: 2px 4px;
    }
    .text-right {
      text-align: right;
    }
    .total-row {
      font-weight: bold;
      background-color: #f5f5f5;
    }
  </style>
</head>
<body>
  ${options.header || ''}
  ${html}
  ${options.footer || `<div class="footer">AeroLink 航材交易平台 - 生成时间: ${new Date().toLocaleString('zh-CN')}</div>`}
</body>
</html>`;

    await page.setContent(fullHtml, { waitUntil: 'networkidle0' });

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    });

    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}

export function generateQuotationHTML(data: {
  quoteNumber: string;
  customerName: string;
  partNumber: string;
  description?: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  costPrice?: number;
  margin?: number;
  validityDays: number;
  saleType?: string;
  incoterm?: string;
  incotermLocation?: string;
  leadTimeDays?: number;
  leadTimeBasis?: string;
  moq?: number;
  mpq?: number;
  priceBasis?: string;
  taxIncluded?: boolean;
  taxRate?: number;
  warrantyDays?: number;
  warrantyTerms?: string;
  packagingRequirement?: string;
  shippingMethod?: string;
  commonNote?: string;
  certificateFiles?: string[];
  createdAt: string;
  expiryDate: string;
  createdBy?: string;
  /** Internal route only. Customer-facing quotation attachments must not expose cost or margin. */
  includeInternalInfo?: boolean;
}): string {
  const totalCost = (data.costPrice || 0) * data.quantity;
  const marginPercent = data.margin ? data.margin.toFixed(2) : '0.00';

  return `
<div class="header">
  <h1>报价单 QUOTATION</h1>
  <div class="subtitle">Quote No: ${data.quoteNumber}</div>
</div>

<div class="section">
  <div class="section-title">客户信息 Customer Information</div>
  <table>
    <tr><td style="width:30%"><strong>客户名称</strong></td><td>${data.customerName}</td></tr>
  </table>
</div>

<div class="section">
  <div class="section-title">报价明细 Quotation Details</div>
  <table>
    <thead>
      <tr>
        <th>件号 Part Number</th>
        <th>描述 Description</th>
        <th>数量 Qty</th>
        <th>单价 Unit Price</th>
        <th>总价 Total</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>${data.partNumber}</td>
        <td>${data.description || '-'}</td>
        <td class="text-right">${data.quantity}</td>
        <td class="text-right">$${data.unitPrice.toLocaleString()}</td>
        <td class="text-right">$${data.totalPrice.toLocaleString()}</td>
      </tr>
      <tr class="total-row">
        <td colspan="4" class="text-right"><strong>合计 Total</strong></td>
        <td class="text-right"><strong>$${data.totalPrice.toLocaleString()}</strong></td>
      </tr>
    </tbody>
  </table>
</div>

<div class="section">
  <div class="section-title">商务条款 Terms & Conditions</div>
  <table>
    <tr><td style="width:30%"><strong>销售类型 Sale Type</strong></td><td>${data.saleType || 'Sale'}</td></tr>
    <tr><td><strong>贸易术语 Incoterm</strong></td><td>${data.incoterm || '-'} ${data.incotermLocation || ''}</td></tr>
    <tr><td><strong>交货期 Lead Time</strong></td><td>${data.leadTimeDays ? data.leadTimeDays + ' days' : '-'} ${data.leadTimeBasis || ''}</td></tr>
    <tr><td><strong>最小起订量 MOQ</strong></td><td>${data.moq || '-'}</td></tr>
    <tr><td><strong>最小包装量 MPQ</strong></td><td>${data.mpq || '-'}</td></tr>
    <tr><td><strong>含税 Tax Included</strong></td><td>${data.taxIncluded ? 'Yes' : 'No'}${data.taxRate ? ` (${data.taxRate}%)` : ''}</td></tr>
    <tr><td><strong>质保 Warranty</strong></td><td>${data.warrantyDays || 90} days${data.warrantyTerms ? ` (${data.warrantyTerms})` : ''}</td></tr>
    <tr><td><strong>包装要求 Packaging</strong></td><td>${data.packagingRequirement || 'N/A'}</td></tr>
    <tr><td><strong>运输方式 Shipping</strong></td><td>${data.shippingMethod || 'N/A'}</td></tr>
    <tr><td><strong>报价有效期 Valid Until</strong></td><td>${data.expiryDate}</td></tr>
    <tr><td><strong>证书文件 Certificates</strong></td><td>${data.certificateFiles?.join(', ') || 'N/A'}</td></tr>
    ${data.commonNote ? `<tr><td><strong>备注 Note</strong></td><td>${data.commonNote}</td></tr>` : ''}
  </table>
</div>

  ${data.includeInternalInfo ? `
  <div class="section">
   <div class="section-title">内部信息 Internal Info</div>
   <table>
     <tr><td style="width:30%"><strong>成本价 Cost Price</strong></td><td>$${data.costPrice?.toLocaleString() || '0'} x ${data.quantity} = $${totalCost.toLocaleString()}</td></tr>
     <tr><td><strong>利润率 Margin</strong></td><td>${marginPercent}%</td></tr>
     <tr><td><strong>报价人 Created By</strong></td><td>${data.createdBy || 'N/A'}</td></tr>
     <tr><td><strong>创建时间 Created At</strong></td><td>${data.createdAt}</td></tr>
   </table>
 </div>` : ''}
`;
}

export function generateOrderHTML(data: {
  orderNumber: string;
  customerName: string;
  partNumber: string;
  quantity: number;
  totalAmount: number;
  status: string;
  poNumber?: string;
  deliveryDate?: string;
  trackingNumber?: string;
  carrier?: string;
  createdAt: string;
}): string {
  return `
<div class="header">
  <h1>销售订单 Sales Order</h1>
  <div class="subtitle">SO No: ${data.orderNumber}</div>
</div>

<div class="section">
  <div class="section-title">订单信息 Order Information</div>
  <table>
    <tr><td style="width:30%"><strong>客户名称 Customer</strong></td><td>${data.customerName}</td></tr>
    <tr><td><strong>客户PO号 PO Number</strong></td><td>${data.poNumber || 'N/A'}</td></tr>
    <tr><td><strong>订单状态 Status</strong></td><td><span class="highlight">${data.status}</span></td></tr>
    <tr><td><strong>创建时间 Created At</strong></td><td>${data.createdAt}</td></tr>
  </table>
</div>

<div class="section">
  <div class="section-title">产品明细 Product Details</div>
  <table>
    <thead>
      <tr>
        <th>件号 Part Number</th>
        <th>数量 Qty</th>
        <th>总价 Total Amount</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>${data.partNumber}</td>
        <td class="text-right">${data.quantity}</td>
        <td class="text-right">$${data.totalAmount.toLocaleString()}</td>
      </tr>
    </tbody>
  </table>
</div>

<div class="section">
  <div class="section-title">物流信息 Logistics</div>
  <table>
    <tr><td style="width:30%"><strong>预计交货日期 Delivery Date</strong></td><td>${data.deliveryDate || 'TBD'}</td></tr>
    <tr><td><strong>运单号 Tracking Number</strong></td><td>${data.trackingNumber || 'N/A'}</td></tr>
    <tr><td><strong>承运商 Carrier</strong></td><td>${data.carrier || 'N/A'}</td></tr>
  </table>
</div>
`;
}

export async function generateQuotationPDF(data: Parameters<typeof generateQuotationHTML>[0]): Promise<Buffer> {
  const html = generateQuotationHTML(data);
  return generatePDF(html, { title: `Quotation-${data.quoteNumber}` });
}

export async function generateOrderPDF(data: Parameters<typeof generateOrderHTML>[0]): Promise<Buffer> {
  const html = generateOrderHTML(data);
  return generatePDF(html, { title: `Order-${data.orderNumber}` });
}
