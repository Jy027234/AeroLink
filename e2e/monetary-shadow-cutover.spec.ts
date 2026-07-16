import { expect, test } from '@playwright/test';

const E2E_PASSWORD = process.env.E2E_PASSWORD;
if (!E2E_PASSWORD) throw new Error('E2E_PASSWORD is required for seeded E2E tests.');

const backendBaseUrl = `${process.env.PLAYWRIGHT_API_ORIGIN || 'http://127.0.0.1:3000'}/api`;

type ApiEnvelope<T> = {
  success: boolean;
  data: T;
};

function mutationHeaders(token: string, idempotencyKey: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
  };
}

async function login() {
  const response = await fetch(`${backendBaseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'zhang@aerolink.com', password: E2E_PASSWORD }),
  });
  expect(response.ok).toBeTruthy();
  const payload = await response.json() as ApiEnvelope<{ token: string }>;
  return payload.data.token;
}

test('keeps precise quote-to-order and supplier amounts compatible through Decimal shadows', async () => {
  const token = await login();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const partNumber = `P1-04-MONEY-${suffix}`;

  const quotationResponse = await fetch(`${backendBaseUrl}/quotations`, {
    method: 'POST',
    headers: mutationHeaders(token, `e2e-money-quote-${suffix}`),
    body: JSON.stringify({
      rfqId: 'rfq002',
      customerId: 'c001',
      partNumber,
      quantity: 3,
      unitPrice: 12.34565,
      costPrice: 8.10005,
      validityDays: 14,
    }),
  });
  expect(quotationResponse.status).toBe(201);
  const quotation = await quotationResponse.json() as ApiEnvelope<{
    id: string;
    version: number;
    totalPrice: number;
  }>;
  expect(quotation.data.totalPrice).toBeCloseTo(37.0371, 10);

  const quotationDetailResponse = await fetch(`${backendBaseUrl}/quotations/${quotation.data.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(quotationDetailResponse.ok).toBeTruthy();
  const quotationDetail = await quotationDetailResponse.json() as ApiEnvelope<Record<string, unknown>>;
  expect(quotationDetail.data).toMatchObject({
    unitPrice: 12.3457,
    totalPrice: 37.0371,
    costPrice: 8.1001,
  });
  expect(quotationDetail.data).not.toHaveProperty('unitPriceDecimal');
  expect(quotationDetail.data).not.toHaveProperty('totalPriceDecimal');
  expect(quotationDetail.data).not.toHaveProperty('costPriceDecimal');

  const submitResponse = await fetch(`${backendBaseUrl}/quotations/${quotation.data.id}/submit`, {
    method: 'POST',
    headers: mutationHeaders(token, `e2e-money-submit-${suffix}`),
    body: JSON.stringify({ version: quotation.data.version, reasonCode: 'E2E_MONEY_SUBMIT' }),
  });
  expect(submitResponse.ok).toBeTruthy();
  const submitted = await submitResponse.json() as ApiEnvelope<{ version: number }>;

  const approveResponse = await fetch(`${backendBaseUrl}/quotations/${quotation.data.id}/approve`, {
    method: 'POST',
    headers: mutationHeaders(token, `e2e-money-approve-${suffix}`),
    body: JSON.stringify({ action: 'approve', version: submitted.data.version, reasonCode: 'E2E_MONEY_APPROVE' }),
  });
  expect(approveResponse.ok).toBeTruthy();
  const approved = await approveResponse.json() as ApiEnvelope<{ version: number }>;

  const acceptResponse = await fetch(`${backendBaseUrl}/quotations/${quotation.data.id}/accept`, {
    method: 'POST',
    headers: mutationHeaders(token, `e2e-money-accept-${suffix}`),
    body: JSON.stringify({
      version: approved.data.version,
      poNumber: `PO-MONEY-${suffix}`,
      confirmationNote: 'P1-04 Decimal shadow E2E acceptance.',
      reasonCode: 'E2E_MONEY_ACCEPT',
    }),
  });
  expect(acceptResponse.ok).toBeTruthy();
  const accepted = await acceptResponse.json() as ApiEnvelope<{
    order: { id: string; totalAmount: number };
  }>;
  expect(accepted.data.order.totalAmount).toBeCloseTo(37.0371, 10);

  const updateOrderResponse = await fetch(`${backendBaseUrl}/orders/${accepted.data.order.id}`, {
    method: 'PATCH',
    headers: mutationHeaders(token, `e2e-money-order-update-${suffix}`),
    body: JSON.stringify({
      importDuty: 12.34565,
      vatAmount: 1.2,
      totalLandCost: 50.00005,
      exchangeCoreCharge: 0.00005,
    }),
  });
  expect(updateOrderResponse.ok).toBeTruthy();
  const updatedOrder = await updateOrderResponse.json() as ApiEnvelope<Record<string, unknown>>;
  expect(updatedOrder.data).toMatchObject({
    totalAmount: 37.0371,
    importDuty: 12.3457,
    vatAmount: 1.2,
    totalLandCost: 50.0001,
    exchangeCoreCharge: 0.0001,
  });
  expect(updatedOrder.data).not.toHaveProperty('totalAmountDecimal');
  expect(updatedOrder.data).not.toHaveProperty('importDutyDecimal');

  const orderDetailResponse = await fetch(`${backendBaseUrl}/orders/${accepted.data.order.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(orderDetailResponse.ok).toBeTruthy();
  const orderDetail = await orderDetailResponse.json() as ApiEnvelope<Record<string, unknown>>;
  expect(orderDetail.data).toMatchObject({
    totalAmount: 37.0371,
    quotation: {
      unitPrice: 12.3457,
      totalPrice: 37.0371,
      costPrice: 8.1001,
    },
  });
  expect(orderDetail.data).not.toHaveProperty('totalAmountDecimal');
  expect(orderDetail.data.quotation as Record<string, unknown>).not.toHaveProperty('unitPriceDecimal');

  const supplierQuoteResponse = await fetch(`${backendBaseUrl}/supplier-quotes`, {
    method: 'POST',
    headers: mutationHeaders(token, `e2e-money-supplier-quote-${suffix}`),
    body: JSON.stringify({
      supplierId: 's001',
      partNumber,
      quantity: 3,
      unitPrice: 10.11115,
    }),
  });
  expect(supplierQuoteResponse.status).toBe(201);
  const supplierQuote = await supplierQuoteResponse.json() as ApiEnvelope<Record<string, unknown>>;
  expect(supplierQuote.data).toMatchObject({ unitPrice: 10.1112, totalPrice: 30.3336 });
  expect(supplierQuote.data).not.toHaveProperty('unitPriceDecimal');
  expect(supplierQuote.data).not.toHaveProperty('totalPriceDecimal');
});
