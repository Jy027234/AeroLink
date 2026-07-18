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

test('dual-writes canonical enum status shadows while preserving string API contracts', async () => {
  const token = await login();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const partNumber = `P1-04-STATUS-${suffix}`;

  const createRfqResponse = await fetch(`${backendBaseUrl}/rfqs`, {
    method: 'POST',
    headers: mutationHeaders(token, `e2e-status-rfq-${suffix}`),
    body: JSON.stringify({
      customerId: 'c001',
      partNumber,
      quantity: 2,
      requiredDate: '2026-08-01',
      urgency: 'STANDARD',
    }),
  });
  expect(createRfqResponse.status).toBe(201);
  const rfq = await createRfqResponse.json() as ApiEnvelope<{ id: string; status: string; version: number }>;
  expect(rfq.data.status).toBe('pending');
  expect(rfq.data).not.toHaveProperty('statusEnum');

  const sourcingResponse = await fetch(`${backendBaseUrl}/rfqs/${rfq.data.id}/status`, {
    method: 'PATCH',
    headers: mutationHeaders(token, `e2e-status-rfq-sourcing-${suffix}`),
    body: JSON.stringify({ status: 'SOURCING', version: rfq.data.version, reasonCode: 'E2E_STATUS_SOURCING' }),
  });
  expect(sourcingResponse.ok).toBeTruthy();
  const sourcing = await sourcingResponse.json() as ApiEnvelope<{ status: string; version: number }>;
  expect(sourcing.data.status).toBe('sourcing');

  const quotationResponse = await fetch(`${backendBaseUrl}/quotations`, {
    method: 'POST',
    headers: mutationHeaders(token, `e2e-status-quotation-${suffix}`),
    body: JSON.stringify({
      rfqId: rfq.data.id,
      customerId: 'c001',
      partNumber,
      quantity: 2,
      unitPrice: 2100,
      costPrice: 1800,
      validityDays: 14,
    }),
  });
  expect(quotationResponse.status).toBe(201);
  const quotation = await quotationResponse.json() as ApiEnvelope<{ id: string; status: string; version: number }>;
  expect(quotation.data.status).toBe('draft');
  expect(quotation.data).not.toHaveProperty('statusEnum');

  const quotationDetailResponse = await fetch(`${backendBaseUrl}/quotations/${quotation.data.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(quotationDetailResponse.ok).toBeTruthy();
  const quotationDetail = await quotationDetailResponse.json() as ApiEnvelope<Record<string, unknown>>;
  expect(quotationDetail.data).not.toHaveProperty('statusEnum');
  expect(quotationDetail.data.rfq as Record<string, unknown>).not.toHaveProperty('statusEnum');

  const submitResponse = await fetch(`${backendBaseUrl}/quotations/${quotation.data.id}/submit`, {
    method: 'POST',
    headers: mutationHeaders(token, `e2e-status-quotation-submit-${suffix}`),
    body: JSON.stringify({ version: quotation.data.version, reasonCode: 'E2E_STATUS_SUBMIT' }),
  });
  expect(submitResponse.ok).toBeTruthy();
  const submitted = await submitResponse.json() as ApiEnvelope<{ status: string; version: number }>;
  expect(submitted.data.status).toBe('pending_approval');

  const approveResponse = await fetch(`${backendBaseUrl}/quotations/${quotation.data.id}/approve`, {
    method: 'POST',
    headers: mutationHeaders(token, `e2e-status-quotation-approve-${suffix}`),
    body: JSON.stringify({ action: 'approve', version: submitted.data.version, reasonCode: 'E2E_STATUS_APPROVE' }),
  });
  expect(approveResponse.ok).toBeTruthy();
  const approved = await approveResponse.json() as ApiEnvelope<{ status: string; version: number }>;
  expect(approved.data.status).toBe('approved');

  const acceptResponse = await fetch(`${backendBaseUrl}/quotations/${quotation.data.id}/accept`, {
    method: 'POST',
    headers: mutationHeaders(token, `e2e-status-quotation-accept-${suffix}`),
    body: JSON.stringify({
      version: approved.data.version,
      poNumber: `PO-STATUS-${suffix}`,
      confirmationNote: 'P1-04 enum shadow E2E acceptance.',
      reasonCode: 'E2E_STATUS_ACCEPT',
    }),
  });
  expect(acceptResponse.ok).toBeTruthy();
  const accepted = await acceptResponse.json() as ApiEnvelope<{
    status: string;
    order: { id: string; status: string };
  }>;
  expect(accepted.data.status).toBe('accepted');
  expect(accepted.data.order.status).toBe('so_created');
  expect(accepted.data.order).not.toHaveProperty('statusEnum');

  const orderStatusResponse = await fetch(`${backendBaseUrl}/orders/${accepted.data.order.id}/status`, {
    method: 'PATCH',
    headers: mutationHeaders(token, `e2e-status-order-${suffix}`),
    body: JSON.stringify({ status: 'PO_CREATED', reasonCode: 'E2E_STATUS_ORDER_PO' }),
  });
  expect(orderStatusResponse.ok).toBeTruthy();
  const updatedOrder = await orderStatusResponse.json() as ApiEnvelope<Record<string, unknown>>;
  expect(updatedOrder.data.status).toBe('po_created');
  expect(updatedOrder.data).not.toHaveProperty('statusEnum');

  const orderDetailResponse = await fetch(`${backendBaseUrl}/orders/${accepted.data.order.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(orderDetailResponse.ok).toBeTruthy();
  const orderDetail = await orderDetailResponse.json() as ApiEnvelope<Record<string, unknown>>;
  expect(orderDetail.data).not.toHaveProperty('statusEnum');
  expect(orderDetail.data.quotation as Record<string, unknown>).not.toHaveProperty('statusEnum');

  const supplierQuoteResponse = await fetch(`${backendBaseUrl}/supplier-quotes`, {
    method: 'POST',
    headers: mutationHeaders(token, `e2e-status-supplier-${suffix}`),
    body: JSON.stringify({
      rfqId: rfq.data.id,
      supplierId: 's001',
      partNumber,
      quantity: 2,
      unitPrice: 1800,
      leadTimeDays: 7,
    }),
  });
  expect(supplierQuoteResponse.status).toBe(201);
  const supplierQuote = await supplierQuoteResponse.json() as ApiEnvelope<{ id: string; status: string }>;
  expect(supplierQuote.data.status).toBe('pending');
  expect(supplierQuote.data).not.toHaveProperty('statusEnum');

  const updateSupplierQuoteResponse = await fetch(`${backendBaseUrl}/supplier-quotes/${supplierQuote.data.id}`, {
    method: 'PUT',
    headers: mutationHeaders(token, `e2e-status-supplier-update-${suffix}`),
    body: JSON.stringify({ status: 'accepted' }),
  });
  expect(updateSupplierQuoteResponse.ok).toBeTruthy();
  const updatedSupplierQuote = await updateSupplierQuoteResponse.json() as ApiEnvelope<Record<string, unknown>>;
  expect(updatedSupplierQuote.data.status).toBe('accepted');
  expect(updatedSupplierQuote.data).not.toHaveProperty('statusEnum');

  const supplierQuoteDetailResponse = await fetch(`${backendBaseUrl}/supplier-quotes/${supplierQuote.data.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(supplierQuoteDetailResponse.ok).toBeTruthy();
  const supplierQuoteDetail = await supplierQuoteDetailResponse.json() as ApiEnvelope<Record<string, unknown>>;
  expect(supplierQuoteDetail.data).not.toHaveProperty('statusEnum');
  expect(supplierQuoteDetail.data.rfq as Record<string, unknown>).not.toHaveProperty('statusEnum');

  const rfqDetailResponse = await fetch(`${backendBaseUrl}/rfqs/${rfq.data.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(rfqDetailResponse.ok).toBeTruthy();
  const rfqDetail = await rfqDetailResponse.json() as ApiEnvelope<Record<string, unknown>>;
  expect(rfqDetail.data).not.toHaveProperty('statusEnum');
});
