// Compatibility entry retained for existing tests and non-module callers.
// The implementation now lives behind the quotationOrder public module entry.
export {
  buildSalesOrderNumber,
  createOrderFromQuotation,
  mapOrderResponse,
} from '../modules/quotationOrder/service.js';
