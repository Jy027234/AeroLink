import { describe, it, expect } from 'vitest';
import {
  loginSchema,
  rfqCreateSchema,
  quotationCreateSchema,
  customerCreateSchema,
  orderCreateSchema,
  orderStatusUpdateSchema,
  paginationSchema,
} from './validation.js';

describe('API Contract - Request/Response shapes', () => {
  describe('Auth API', () => {
    it('login request should require email and password', () => {
      const valid = loginSchema.safeParse({ email: 'a@b.com', password: '123' });
      expect(valid.success).toBe(true);

      const missingEmail = loginSchema.safeParse({ password: '123' });
      expect(missingEmail.success).toBe(false);

      const missingPassword = loginSchema.safeParse({ email: 'a@b.com' });
      expect(missingPassword.success).toBe(false);
    });
  });

  describe('RFQ API', () => {
    it('create RFQ request should have required fields', () => {
      const valid = rfqCreateSchema.safeParse({
        customerId: 'c1',
        partNumber: 'PN123',
        quantity: 10,
        requiredDate: '2025-06-01',
      });
      expect(valid.success).toBe(true);

      const missingPartNumber = rfqCreateSchema.safeParse({
        customerId: 'c1',
        quantity: 10,
        requiredDate: '2025-06-01',
      });
      expect(missingPartNumber.success).toBe(false);
    });

    it('RFQ urgency should default to STANDARD', () => {
      const result = rfqCreateSchema.safeParse({
        customerId: 'c1',
        partNumber: 'PN123',
        quantity: 10,
        requiredDate: '2025-06-01',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.urgency).toBe('STANDARD');
      }
    });
  });

  describe('Quotation API', () => {
    it('create quotation request should require pricing fields', () => {
      const valid = quotationCreateSchema.safeParse({
        rfqId: 'r1',
        customerId: 'c1',
        partNumber: 'PN123',
        quantity: 5,
        unitPrice: 100,
        costPrice: 80,
      });
      expect(valid.success).toBe(true);

      const missingPrice = quotationCreateSchema.safeParse({
        rfqId: 'r1',
        customerId: 'c1',
        partNumber: 'PN123',
        quantity: 5,
      });
      expect(missingPrice.success).toBe(false);
    });
  });

  describe('Customer API', () => {
    it('create customer request should require name, contact and email', () => {
      const valid = customerCreateSchema.safeParse({
        name: 'Airline Co',
        contactName: 'John',
        email: 'john@airline.com',
      });
      expect(valid.success).toBe(true);

      const missingName = customerCreateSchema.safeParse({
        contactName: 'John',
        email: 'john@airline.com',
      });
      expect(missingName.success).toBe(false);
    });
  });

  describe('Order API', () => {
    it('create order request should require quotationId and customerId', () => {
      const valid = orderCreateSchema.safeParse({
        quotationId: 'q1',
        customerId: 'c1',
      });
      expect(valid.success).toBe(true);

      const missingQuotation = orderCreateSchema.safeParse({
        customerId: 'c1',
      });
      expect(missingQuotation.success).toBe(false);
    });

    it('status update should normalize supported aliases and reject arbitrary values', () => {
      const valid = orderStatusUpdateSchema.safeParse({ status: 'in-transit' });
      expect(valid.success).toBe(true);
      if (valid.success) {
        expect(valid.data.status).toBe('IN_TRANSIT');
      }

      const invalid = orderStatusUpdateSchema.safeParse({ status: 'delayed' });
      expect(invalid.success).toBe(false);
    });
  });

  describe('Pagination API', () => {
    it('pagination params should default to page=1, limit=20', () => {
      const result = paginationSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(1);
        expect(result.data.limit).toBe(20);
      }
    });

    it('pagination params should parse string numbers', () => {
      const result = paginationSchema.safeParse({ page: '3', limit: '50' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(3);
        expect(result.data.limit).toBe(50);
      }
    });
  });
});
