import { describe, it, expect } from 'vitest';
import {
  loginSchema,
  rfqCreateSchema,
  rfqStatusUpdateSchema,
  quotationCreateSchema,
  quotationSendSchema,
  quotationWithdrawSchema,
  quotationAcceptSchema,
  documentTemplateCreateSchema,
  customerCreateSchema,
  paginationSchema,
} from './validation.js';

describe('loginSchema', () => {
  it('should validate correct login data', () => {
    const result = loginSchema.safeParse({ email: 'test@example.com', password: 'password123' });
    expect(result.success).toBe(true);
  });

  it('should fail on invalid email', () => {
    const result = loginSchema.safeParse({ email: 'invalid-email', password: 'password123' });
    expect(result.success).toBe(false);
  });

  it('should fail on empty password', () => {
    const result = loginSchema.safeParse({ email: 'test@example.com', password: '' });
    expect(result.success).toBe(false);
  });
});

describe('rfqCreateSchema', () => {
  it('should validate correct RFQ data', () => {
    const result = rfqCreateSchema.safeParse({
      customerId: 'cust-1',
      partNumber: 'PN123',
      quantity: 10,
      requiredDate: '2025-06-01',
      urgency: 'AOG',
    });
    expect(result.success).toBe(true);
  });

  it('should default urgency to STANDARD', () => {
    const result = rfqCreateSchema.safeParse({
      customerId: 'cust-1',
      partNumber: 'PN123',
      quantity: 10,
      requiredDate: '2025-06-01',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.urgency).toBe('STANDARD');
    }
  });

  it('should fail on missing required fields', () => {
    const result = rfqCreateSchema.safeParse({
      partNumber: 'PN123',
      quantity: 10,
    });
    expect(result.success).toBe(false);
  });

  it('should fail on negative quantity', () => {
    const result = rfqCreateSchema.safeParse({
      customerId: 'cust-1',
      partNumber: 'PN123',
      quantity: -1,
      requiredDate: '2025-06-01',
    });
    expect(result.success).toBe(false);
  });
});

describe('rfqStatusUpdateSchema', () => {
  it('should validate valid status', () => {
    const result = rfqStatusUpdateSchema.safeParse({ status: 'SOURCING' });
    expect(result.success).toBe(true);
  });

  it('should fail on invalid status', () => {
    const result = rfqStatusUpdateSchema.safeParse({ status: 'INVALID' });
    expect(result.success).toBe(false);
  });
});

describe('quotationCreateSchema', () => {
  it('should validate correct quotation data', () => {
    const result = quotationCreateSchema.safeParse({
      rfqId: 'rfq-1',
      customerId: 'cust-1',
      partNumber: 'PN123',
      quantity: 5,
      unitPrice: 100,
      costPrice: 80,
    });
    expect(result.success).toBe(true);
  });

  it('should fail when unitPrice is negative', () => {
    const result = quotationCreateSchema.safeParse({
      rfqId: 'rfq-1',
      customerId: 'cust-1',
      partNumber: 'PN123',
      quantity: 5,
      unitPrice: -10,
      costPrice: 80,
    });
    expect(result.success).toBe(false);
  });
});

describe('quotationSendSchema', () => {
  it('should allow custom subject and message', () => {
    const result = quotationSendSchema.safeParse({
      subject: 'Quotation QT-001',
      message: 'Please check the attached quotation.',
    });
    expect(result.success).toBe(true);
  });
});

describe('quotationWithdrawSchema', () => {
  it('should require a withdrawal reason', () => {
    const result = quotationWithdrawSchema.safeParse({ reason: 'Pricing updated' });
    expect(result.success).toBe(true);
  });

  it('should reject empty withdrawal reason', () => {
    const result = quotationWithdrawSchema.safeParse({ reason: '' });
    expect(result.success).toBe(false);
  });
});

describe('quotationAcceptSchema', () => {
  it('should allow poNumber, deliveryDate and contract template selection', () => {
    const result = quotationAcceptSchema.safeParse({
      poNumber: 'PO-20260512-001',
      deliveryDate: '2026-06-01',
      templateId: 'tpl-001',
      confirmationNote: 'Confirmed by customer procurement team',
    });
    expect(result.success).toBe(true);
  });
});

describe('documentTemplateCreateSchema', () => {
  it('should validate a contract template payload', () => {
    const result = documentTemplateCreateSchema.safeParse({
      name: '标准销售合同模板',
      code: 'default-order-contract',
      bodyTemplate: '<p>{{customer.name}}</p>',
      isActive: true,
      isDefault: true,
    });
    expect(result.success).toBe(true);
  });
});

describe('customerCreateSchema', () => {
  it('should validate correct customer data', () => {
    const result = customerCreateSchema.safeParse({
      name: 'Airline Co',
      contactName: 'John Doe',
      email: 'john@airline.com',
      phone: '+86-1234567890',
    });
    expect(result.success).toBe(true);
  });

  it('should fail on invalid email', () => {
    const result = customerCreateSchema.safeParse({
      name: 'Airline Co',
      contactName: 'John Doe',
      email: 'not-an-email',
    });
    expect(result.success).toBe(false);
  });

  it('should fail on missing name', () => {
    const result = customerCreateSchema.safeParse({
      contactName: 'John Doe',
      email: 'john@airline.com',
    });
    expect(result.success).toBe(false);
  });
});

describe('paginationSchema', () => {
  it('should default page and limit', () => {
    const result = paginationSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(20);
    }
  });

  it('should parse string numbers', () => {
    const result = paginationSchema.safeParse({ page: '3', limit: '50' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(3);
      expect(result.data.limit).toBe(50);
    }
  });
});
