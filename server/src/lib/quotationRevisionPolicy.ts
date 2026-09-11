import { AppError } from '../middleware/errorHandler.js';

/** A superseded commercial offer remains readable, but cannot create new obligations. */
export function assertActiveQuotationRevision(quotation: { supersededAt?: Date | string | null }) {
  if (quotation.supersededAt) {
    throw new AppError('该报价已有新的商业版次，请打开最新报价继续操作', 409, 'RESOURCE_CONFLICT');
  }
}
