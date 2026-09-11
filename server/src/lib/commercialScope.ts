import { AppError } from '../middleware/errorHandler.js';

/** The confirmed first release covers inventory sales and back-to-back resale. */
export function assertSupportedSaleType(value: unknown): 'Sale' {
  if (value === undefined || value === null || value === '' || value === 'Sale') return 'Sale';
  throw new AppError('首期仅支持自有库存销售及背靠背采购转售；交换、借用、寄售及维修尚未开放', 409, 'BAD_REQUEST');
}
