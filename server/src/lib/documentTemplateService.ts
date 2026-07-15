import type { Customer, DocumentTemplate, Order, Prisma, Quotation } from '@prisma/client';
import { AppError } from '../middleware/errorHandler.js';
import { generatePDF } from './pdfService.js';
import prisma from './prisma.js';

export const ORDER_CONTRACT_DOCUMENT_TYPE = 'ORDER_CONTRACT';

type ContractDocumentClient = Pick<Prisma.TransactionClient, 'documentTemplate' | 'generatedDocument'>;

export const ORDER_CONTRACT_TEMPLATE_VARIABLES = [
  'customer.name',
  'customer.contactName',
  'customer.email',
  'customer.phone',
  'customer.address',
  'quotation.quoteNumber',
  'quotation.partNumber',
  'quotation.quantity',
  'quotation.unitPrice',
  'quotation.totalPrice',
  'quotation.saleType',
  'quotation.incoterm',
  'quotation.incotermLocation',
  'quotation.leadTimeDays',
  'quotation.warrantyDays',
  'quotation.taxIncluded',
  'quotation.taxRate',
  'quotation.packagingRequirement',
  'quotation.shippingMethod',
  'quotation.expiryDate',
  'quotation.customerConfirmationNote',
  'order.orderNumber',
  'order.soNumber',
  'order.poNumber',
  'order.deliveryDate',
  'system.generatedAt',
] as const;

const DEFAULT_ORDER_CONTRACT_BODY = `
<div class="header">
  <h1>销售合同 Sales Contract</h1>
  <div class="subtitle">合同号 / Contract No: {{order.orderNumber}}</div>
</div>

<div class="section">
  <div class="section-title">客户信息 Customer Information</div>
  <table>
    <tr><td style="width: 30%"><strong>客户名称</strong></td><td>{{customer.name}}</td></tr>
    <tr><td><strong>联系人</strong></td><td>{{customer.contactName}}</td></tr>
    <tr><td><strong>邮箱</strong></td><td>{{customer.email}}</td></tr>
    <tr><td><strong>电话</strong></td><td>{{customer.phone}}</td></tr>
    <tr><td><strong>地址</strong></td><td>{{customer.address}}</td></tr>
  </table>
</div>

<div class="section">
  <div class="section-title">报价确认 Quotation Confirmation</div>
  <table>
    <tr><td style="width: 30%"><strong>报价单号</strong></td><td>{{quotation.quoteNumber}}</td></tr>
    <tr><td><strong>销售类型</strong></td><td>{{quotation.saleType}}</td></tr>
    <tr><td><strong>贸易术语</strong></td><td>{{quotation.incoterm}} {{quotation.incotermLocation}}</td></tr>
    <tr><td><strong>交货期</strong></td><td>{{quotation.leadTimeDays}} 天</td></tr>
    <tr><td><strong>质保</strong></td><td>{{quotation.warrantyDays}} 天</td></tr>
    <tr><td><strong>含税</strong></td><td>{{quotation.taxIncluded}}</td></tr>
    <tr><td><strong>报价有效期</strong></td><td>{{quotation.expiryDate}}</td></tr>
    <tr><td><strong>客户确认说明</strong></td><td>{{quotation.customerConfirmationNote}}</td></tr>
  </table>
</div>

<div class="section">
  <div class="section-title">货物明细 Goods Table</div>
  <table>
    <thead>
      <tr>
        <th>件号 Part Number</th>
        <th>数量 Qty</th>
        <th>单价 Unit Price</th>
        <th>总价 Total Amount</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>{{quotation.partNumber}}</td>
        <td class="text-right">{{quotation.quantity}}</td>
        <td class="text-right">{{quotation.unitPrice}}</td>
        <td class="text-right">{{quotation.totalPrice}}</td>
      </tr>
    </tbody>
  </table>
</div>

<div class="section">
  <div class="section-title">订单信息 Order Information</div>
  <table>
    <tr><td style="width: 30%"><strong>销售单号 SO No.</strong></td><td>{{order.soNumber}}</td></tr>
    <tr><td><strong>客户 PO 号</strong></td><td>{{order.poNumber}}</td></tr>
    <tr><td><strong>预计交付日期</strong></td><td>{{order.deliveryDate}}</td></tr>
    <tr><td><strong>生成时间</strong></td><td>{{system.generatedAt}}</td></tr>
  </table>
</div>

<div class="section">
  <div class="section-title">补充条款 Additional Terms</div>
  <p>1. 本合同基于客户确认报价自动生成，最终执行以双方确认版本为准。</p>
  <p>2. 若需补充质量、包装、证书或运输条款，可在模板管理中预制对应条款段落。</p>
</div>
`.trim();

function getDefaultValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '待补充';
  }

  if (value instanceof Date) {
    return value.toISOString().split('T')[0];
  }

  if (typeof value === 'number') {
    return value.toLocaleString('en-US', {
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: 2,
    });
  }

  return String(value);
}

function resolvePath(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, source);
}

export function renderTemplate(bodyTemplate: string, payload: Record<string, unknown>): string {
  return bodyTemplate.replace(/{{\s*([\w.]+)\s*}}/g, (_match, token) => {
    const resolved = resolvePath(payload, token);
    return getDefaultValue(resolved);
  });
}

export function buildOrderContractPayload(args: {
  quotation: Quotation;
  customer: Customer;
  order: Order;
}): Record<string, unknown> {
  const { quotation, customer, order } = args;

  return {
    customer: {
      name: customer.name,
      contactName: customer.contactName,
      email: customer.email,
      phone: customer.phone,
      address: customer.registeredAddress,
    },
    quotation: {
      quoteNumber: quotation.quoteNumber,
      partNumber: quotation.partNumber,
      quantity: quotation.quantity,
      unitPrice: quotation.unitPrice,
      totalPrice: quotation.totalPrice,
      saleType: quotation.saleType,
      incoterm: quotation.incoterm,
      incotermLocation: quotation.incotermLocation,
      leadTimeDays: quotation.leadTimeDays,
      warrantyDays: quotation.warrantyDays,
      taxIncluded: quotation.taxIncluded,
      taxRate: quotation.taxRate,
      packagingRequirement: quotation.packagingRequirement,
      shippingMethod: quotation.shippingMethod,
      expiryDate: quotation.expiryDate,
      customerConfirmationNote: quotation.customerConfirmationNote,
    },
    order: {
      orderNumber: order.orderNumber,
      soNumber: order.soNumber,
      poNumber: order.poNumber,
      deliveryDate: order.deliveryDate,
    },
    system: {
      generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    },
  };
}

export async function ensureDefaultOrderContractTemplate(createdById?: string, db: ContractDocumentClient = prisma) {
  const existing = await db.documentTemplate.findFirst({
    where: {
      documentType: ORDER_CONTRACT_DOCUMENT_TYPE,
      isDefault: true,
    },
  });

  if (existing) {
    return existing;
  }

  return db.documentTemplate.create({
    data: {
      name: '标准销售合同模板',
      code: 'default-order-contract',
      documentType: ORDER_CONTRACT_DOCUMENT_TYPE,
      description: '系统默认销售合同模板，用于客户确认报价后自动填充生成。',
      bodyTemplate: DEFAULT_ORDER_CONTRACT_BODY,
      isActive: true,
      isDefault: true,
      createdById,
    },
  });
}

export async function getOrderContractTemplate(templateId?: string | null, db: ContractDocumentClient = prisma) {
  if (templateId) {
    const template = await db.documentTemplate.findUnique({ where: { id: templateId } });
    if (!template) {
      throw new AppError('合同模板不存在', 404, 'RESOURCE_NOT_FOUND');
    }
    if (!template.isActive) {
      throw new AppError('合同模板已停用，不能用于自动生成', 400, 'BAD_REQUEST');
    }
    return template;
  }

  const defaultTemplate = await db.documentTemplate.findFirst({
    where: {
      documentType: ORDER_CONTRACT_DOCUMENT_TYPE,
      isActive: true,
      isDefault: true,
    },
  });

  if (defaultTemplate) {
    return defaultTemplate;
  }

  const fallback = await db.documentTemplate.findFirst({
    where: {
      documentType: ORDER_CONTRACT_DOCUMENT_TYPE,
      isActive: true,
    },
    orderBy: {
      updatedAt: 'desc',
    },
  });

  if (fallback) {
    return fallback;
  }

  return ensureDefaultOrderContractTemplate(undefined, db);
}

export async function createOrderContractDocument(args: {
  quotation: Quotation;
  customer: Customer;
  order: Order;
  templateId?: string | null;
  generatedById?: string;
  tx?: ContractDocumentClient;
}) {
  const db = args.tx ?? prisma;
  const template = await getOrderContractTemplate(args.templateId, db);
  const payload = buildOrderContractPayload(args);
  const contentHtml = renderTemplate(template.bodyTemplate, payload);

  const title = `销售合同 - ${args.order.orderNumber}`;

  return db.generatedDocument.create({
    data: {
      templateId: template.id,
      quotationId: args.quotation.id,
      orderId: args.order.id,
      customerId: args.customer.id,
      documentType: ORDER_CONTRACT_DOCUMENT_TYPE,
      title,
      status: 'GENERATED',
      contentHtml,
      payloadJson: JSON.stringify(payload),
      generatedById: args.generatedById,
    },
  });
}

export async function ensureOrderContractDocument(args: {
  quotation: Quotation;
  customer: Customer;
  order: Order;
  templateId?: string | null;
  generatedById?: string;
  tx?: ContractDocumentClient;
}) {
  const db = args.tx ?? prisma;
  const existing = await db.generatedDocument.findFirst({
    where: {
      orderId: args.order.id,
      documentType: ORDER_CONTRACT_DOCUMENT_TYPE,
    },
    orderBy: {
      generatedAt: 'desc',
    },
  });

  if (existing) {
    return existing;
  }

  return createOrderContractDocument({ ...args, tx: db });
}

export async function generateDocumentPdf(document: {
  title: string;
  contentHtml: string;
}) {
  return generatePDF(document.contentHtml, {
    title: document.title,
  });
}

export function mapDocumentTemplate(template: DocumentTemplate) {
  return {
    id: template.id,
    name: template.name,
    code: template.code,
    documentType: template.documentType,
    description: template.description,
    bodyTemplate: template.bodyTemplate,
    headerTemplate: template.headerTemplate,
    footerTemplate: template.footerTemplate,
    isActive: template.isActive,
    isDefault: template.isDefault,
    version: template.version,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
    createdById: template.createdById,
  };
}
