import { describe, it, expect } from 'vitest';
import { rfqCreateSchema, rfqStatusUpdateSchema } from '../lib/validation.js';

describe('RFQ validation schemas', () => {
  it('should validate correct RFQ create data', () => {
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

  it('should reject negative quantity', () => {
    const result = rfqCreateSchema.safeParse({
      customerId: 'cust-1',
      partNumber: 'PN123',
      quantity: -1,
      requiredDate: '2025-06-01',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing required fields', () => {
    const result = rfqCreateSchema.safeParse({
      partNumber: 'PN123',
    });
    expect(result.success).toBe(false);
  });

  it('should validate status update', () => {
    const result = rfqStatusUpdateSchema.safeParse({ status: 'SOURCING' });
    expect(result.success).toBe(true);
  });

  it('should reject invalid status', () => {
    const result = rfqStatusUpdateSchema.safeParse({ status: 'INVALID' });
    expect(result.success).toBe(false);
  });
});
