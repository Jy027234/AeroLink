import { describe, expect, it } from 'vitest';
import { rfqCreateSchema, rfqUpdateSchema } from './validation.js';

const line = (partNumber: string, lineNo: number) => ({
  partNumber,
  quantity: lineNo,
  requiredDate: '2026-10-0' + lineNo,
  alternatePartNumbers: [`${partNumber}-ALT`],
});

describe('RFQ multi-line validation', () => {
  it('accepts modern line-only demand facts and preserves exact alternates', () => {
    const result = rfqCreateSchema.safeParse({
      customerId: 'customer-1',
      lines: [line('PN-1', 1), line('PN-2', 2), line('PN-3', 3)],
      notes: 'three line test',
    });
    expect(result.success).toBe(true);
    if (result.success && 'lines' in result.data) {
      expect(result.data.lines).toHaveLength(3);
      expect(result.data.lines[1].alternatePartNumbers).toBe('["PN-2-ALT"]');
      expect(result.data.lines[2]).not.toHaveProperty('lineNo');
    }
  });

  it('accepts the legacy single-line shape without creating a client line id', () => {
    const result = rfqCreateSchema.safeParse({
      customerId: 'customer-1',
      partNumber: 'PN-LEGACY',
      quantity: 2,
      requiredDate: '2026-10-01',
    });
    expect(result.success).toBe(true);
    if (result.success) expect('lines' in result.data).toBe(false);
  });

  it('rejects mixed header demand facts so they cannot overwrite line one', () => {
    const result = rfqCreateSchema.safeParse({
      customerId: 'customer-1',
      partNumber: 'STALE-HEADER',
      quantity: 99,
      lines: [line('PN-1', 1), line('PN-2', 2)],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a patch that combines lines with legacy demand fields', () => {
    const result = rfqUpdateSchema.safeParse({
      lines: [line('PN-1', 1)],
      quantity: 99,
    });
    expect(result.success).toBe(false);
  });

  it('accepts line IDs only on updates', () => {
    const result = rfqUpdateSchema.safeParse({
      lines: [{ id: 'server-line-1', ...line('PN-1', 1) }],
      notes: 'keep the source facts',
    });
    expect(result.success).toBe(true);
  });
});
