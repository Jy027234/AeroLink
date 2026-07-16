import { expect, test } from '@playwright/test';

const E2E_PASSWORD = process.env.E2E_PASSWORD;
if (!E2E_PASSWORD) throw new Error('E2E_PASSWORD is required for seeded E2E tests.');

const backendBaseUrl = `${process.env.PLAYWRIGHT_API_ORIGIN || 'http://127.0.0.1:3000'}/api`;

type ApiEnvelope<T> = {
  success: boolean;
  code?: string;
  message?: string;
  data: T;
};

async function login(email: string) {
  const response = await fetch(`${backendBaseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: E2E_PASSWORD }),
  });
  expect(response.ok).toBeTruthy();
  const payload = await response.json() as ApiEnvelope<{ token: string }>;
  return payload.data.token;
}

function mutationHeaders(token: string, idempotencyKey?: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  };
}

async function createApprovedQuotationForReservation(token: string, partNumber: string, suffix: string) {
  const rfqResponse = await fetch(`${backendBaseUrl}/rfqs`, {
    method: 'POST',
    headers: mutationHeaders(token, `e2e-race-rfq-${suffix}`),
    body: JSON.stringify({
      customerId: 'c001',
      partNumber,
      quantity: 1,
      requiredDate: '2026-08-01',
      urgency: 'STANDARD',
    }),
  });
  expect(rfqResponse.status).toBe(201);
  const rfq = await rfqResponse.json() as ApiEnvelope<{ id: string }>;

  const quoteResponse = await fetch(`${backendBaseUrl}/quotations`, {
    method: 'POST',
    headers: mutationHeaders(token, `e2e-race-quote-${suffix}`),
    body: JSON.stringify({
      rfqId: rfq.data.id,
      customerId: 'c001',
      partNumber,
      quantity: 1,
      unitPrice: 2400,
      costPrice: 1800,
      validityDays: 14,
    }),
  });
  expect(quoteResponse.status).toBe(201);
  const quote = await quoteResponse.json() as ApiEnvelope<{ id: string; version: number }>;

  const submitResponse = await fetch(`${backendBaseUrl}/quotations/${quote.data.id}/submit`, {
    method: 'POST',
    headers: mutationHeaders(token, `e2e-race-submit-${suffix}`),
    body: JSON.stringify({ version: quote.data.version, reasonCode: 'E2E_RACE_SUBMIT' }),
  });
  expect(submitResponse.ok).toBeTruthy();
  const submitted = await submitResponse.json() as ApiEnvelope<{ version: number }>;

  const approveResponse = await fetch(`${backendBaseUrl}/quotations/${quote.data.id}/approve`, {
    method: 'POST',
    headers: mutationHeaders(token, `e2e-race-approve-${suffix}`),
    body: JSON.stringify({ action: 'approve', version: submitted.data.version, reasonCode: 'E2E_RACE_APPROVE' }),
  });
  expect(approveResponse.ok).toBeTruthy();
  const approved = await approveResponse.json() as ApiEnvelope<{ version: number }>;

  return { id: quote.data.id, version: approved.data.version };
}

test.describe('core transaction flow', () => {
  test('runs RFQ to certificate with reservation, partial outbound, idempotency and authorization safeguards', async () => {
    const managerToken = await login('zhang@aerolink.com');
    const financeToken = await login('li@aerolink.com');
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partNumber = '2341-123-050';
    const inventoryDetailId = 'inv001';

    const rfqKey = `e2e-core-rfq-${suffix}`;
    const createRfqResponse = await fetch(`${backendBaseUrl}/rfqs`, {
      method: 'POST',
      headers: mutationHeaders(managerToken, rfqKey),
      body: JSON.stringify({
        customerId: 'c001',
        partNumber,
        quantity: 2,
        requiredDate: '2026-08-01',
        urgency: 'STANDARD',
        notes: `P1-10 core transaction flow ${suffix}`,
      }),
    });
    expect(createRfqResponse.status).toBe(201);
    const createdRfq = await createRfqResponse.json() as ApiEnvelope<{
      id: string;
      status: string;
      version: number;
    }>;
    expect(createdRfq.data.status).toBe('pending');

    const sourceRfqResponse = await fetch(`${backendBaseUrl}/rfqs/${createdRfq.data.id}/status`, {
      method: 'PATCH',
      headers: mutationHeaders(managerToken, `e2e-core-source-${suffix}`),
      body: JSON.stringify({
        status: 'SOURCING',
        version: createdRfq.data.version,
        reasonCode: 'E2E_CORE_SOURCING',
      }),
    });
    expect(sourceRfqResponse.ok).toBeTruthy();
    const sourcedRfq = await sourceRfqResponse.json() as ApiEnvelope<{ status: string; version: number }>;
    expect(sourcedRfq.data.status).toBe('sourcing');

    const quoteRfqResponse = await fetch(`${backendBaseUrl}/rfqs/${createdRfq.data.id}/status`, {
      method: 'PATCH',
      headers: mutationHeaders(managerToken, `e2e-core-quoting-${suffix}`),
      body: JSON.stringify({
        status: 'QUOTING',
        version: sourcedRfq.data.version,
        reasonCode: 'E2E_CORE_QUOTING',
      }),
    });
    expect(quoteRfqResponse.ok).toBeTruthy();

    const createQuoteResponse = await fetch(`${backendBaseUrl}/quotations`, {
      method: 'POST',
      headers: mutationHeaders(managerToken, `e2e-core-quote-${suffix}`),
      body: JSON.stringify({
        rfqId: createdRfq.data.id,
        customerId: 'c001',
        partNumber,
        quantity: 2,
        unitPrice: 2400,
        costPrice: 1800,
        certificateFiles: ['FAA-8130-3'],
        validityDays: 14,
      }),
    });
    expect(createQuoteResponse.status).toBe(201);
    const createdQuote = await createQuoteResponse.json() as ApiEnvelope<{
      id: string;
      quoteNumber: string;
      status: string;
      version: number;
    }>;
    expect(createdQuote.data.status).toBe('draft');

    const submitQuoteResponse = await fetch(`${backendBaseUrl}/quotations/${createdQuote.data.id}/submit`, {
      method: 'POST',
      headers: mutationHeaders(managerToken, `e2e-core-submit-${suffix}`),
      body: JSON.stringify({ version: createdQuote.data.version, reasonCode: 'E2E_CORE_SUBMIT' }),
    });
    expect(submitQuoteResponse.ok).toBeTruthy();
    const submittedQuote = await submitQuoteResponse.json() as ApiEnvelope<{ status: string; version: number }>;
    expect(submittedQuote.data.status).toBe('pending_approval');

    const approveQuoteResponse = await fetch(`${backendBaseUrl}/quotations/${createdQuote.data.id}/approve`, {
      method: 'POST',
      headers: mutationHeaders(managerToken, `e2e-core-approve-${suffix}`),
      body: JSON.stringify({
        action: 'approve',
        version: submittedQuote.data.version,
        reasonCode: 'E2E_CORE_APPROVE',
      }),
    });
    expect(approveQuoteResponse.ok).toBeTruthy();
    const approvedQuote = await approveQuoteResponse.json() as ApiEnvelope<{ status: string; version: number }>;
    expect(approvedQuote.data.status).toBe('approved');

    const acceptQuoteResponse = await fetch(`${backendBaseUrl}/quotations/${createdQuote.data.id}/accept`, {
      method: 'POST',
      headers: mutationHeaders(managerToken, `e2e-core-accept-${suffix}`),
      body: JSON.stringify({
        version: approvedQuote.data.version,
        poNumber: `PO-E2E-${suffix}`,
        confirmationNote: 'P1-10 end-to-end customer confirmation.',
        reasonCode: 'E2E_CORE_ACCEPT',
      }),
    });
    expect(acceptQuoteResponse.ok).toBeTruthy();
    const acceptedQuote = await acceptQuoteResponse.json() as ApiEnvelope<{
      status: string;
      order: { id: string; orderNumber: string; status: string; inventoryDetailId?: string };
    }>;
    expect(acceptedQuote.data.status).toBe('accepted');
    const orderId = acceptedQuote.data.order.id;

    const inventoryResponse = await fetch(`${backendBaseUrl}/inventory-items/part/${partNumber}`, {
      headers: { Authorization: `Bearer ${managerToken}` },
    });
    expect(inventoryResponse.ok).toBeTruthy();
    const inventoryItem = await inventoryResponse.json() as {
      details: Array<{ id: string; quantity: number; status: string; conditionCode: string }>;
    };
    expect(inventoryItem.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: inventoryDetailId, quantity: 5, status: 'AVAILABLE' }),
    ]));

    const reserveKey = `e2e-core-reserve-${suffix}`;
    const reservationBody = {
      inventoryDetailId,
      quotationId: createdQuote.data.id,
      quantity: 2,
      notes: 'Reserve the two units for the accepted order.',
    };
    const reserveResponse = await fetch(`${backendBaseUrl}/inventory-transactions/reserve`, {
      method: 'POST',
      headers: mutationHeaders(managerToken, reserveKey),
      body: JSON.stringify(reservationBody),
    });
    expect(reserveResponse.status).toBe(201);
    const reservation = await reserveResponse.json() as ApiEnvelope<{
      id: string;
      type: string;
      inventoryStatus: string;
      reservedQuantity: number;
    }>;
    expect(reservation.data).toMatchObject({
      type: 'RESERVATION',
      inventoryStatus: 'RESERVED',
      reservedQuantity: 2,
    });

    const reserveReplayResponse = await fetch(`${backendBaseUrl}/inventory-transactions/reserve`, {
      method: 'POST',
      headers: mutationHeaders(managerToken, reserveKey),
      body: JSON.stringify(reservationBody),
    });
    expect(reserveReplayResponse.status).toBe(201);
    expect(reserveReplayResponse.headers.get('Idempotency-Replayed')).toBe('true');
    const reservationReplay = await reserveReplayResponse.json() as ApiEnvelope<{ id: string }>;
    expect(reservationReplay.data.id).toBe(reservation.data.id);

    const reservedOrderResponse = await fetch(`${backendBaseUrl}/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${managerToken}` },
    });
    expect(reservedOrderResponse.ok).toBeTruthy();
    const reservedOrder = await reservedOrderResponse.json() as ApiEnvelope<{
      inventoryDetailId: string;
      outboundQuantity: number;
      outboundStatus: string;
    }>;
    expect(reservedOrder.data).toMatchObject({
      inventoryDetailId,
      outboundQuantity: 0,
      outboundStatus: 'PENDING',
    });

    const reservedQuotationResponse = await fetch(`${backendBaseUrl}/quotations/${createdQuote.data.id}`, {
      headers: { Authorization: `Bearer ${managerToken}` },
    });
    expect(reservedQuotationResponse.ok).toBeTruthy();
    const reservedQuotation = await reservedQuotationResponse.json() as ApiEnvelope<{
      inventoryDetailId: string;
      reservedQuantity: number;
    }>;
    expect(reservedQuotation.data).toMatchObject({ inventoryDetailId, reservedQuantity: 2 });

    const financeAttempt = await fetch(`${backendBaseUrl}/inventory-transactions/outbound`, {
      method: 'POST',
      headers: mutationHeaders(financeToken, `e2e-core-finance-${suffix}`),
      body: JSON.stringify({ inventoryDetailId, orderId, quantity: 1 }),
    });
    expect(financeAttempt.status).toBe(403);
    expect((await financeAttempt.json() as ApiEnvelope<never>).code).toBe('AUTH_FORBIDDEN');

    const mismatchedOutbound = await fetch(`${backendBaseUrl}/inventory-transactions/outbound`, {
      method: 'POST',
      headers: mutationHeaders(managerToken, `e2e-core-mismatch-${suffix}`),
      body: JSON.stringify({ inventoryDetailId: 'inv003', orderId, quantity: 1 }),
    });
    expect(mismatchedOutbound.status).toBe(409);
    expect((await mismatchedOutbound.json() as ApiEnvelope<never>).code).toBe('RESOURCE_CONFLICT');

    const outboundKey = `e2e-core-outbound-one-${suffix}`;
    const outboundBody = {
      inventoryDetailId,
      orderId,
      quantity: 1,
      notes: 'First partial outbound.',
    };
    const firstOutboundResponse = await fetch(`${backendBaseUrl}/inventory-transactions/outbound`, {
      method: 'POST',
      headers: mutationHeaders(managerToken, outboundKey),
      body: JSON.stringify(outboundBody),
    });
    expect(firstOutboundResponse.status).toBe(201);
    const firstOutbound = await firstOutboundResponse.json() as ApiEnvelope<{
      id: string;
      type: string;
      beforeQuantity: number;
      afterQuantity: number;
      inventoryStatus: string;
      outboundQuantity: number;
      outboundStatus: string;
      orderStatus: string;
      reservedQuantity: number;
    }>;
    expect(firstOutbound.data).toMatchObject({
      type: 'OUTBOUND',
      beforeQuantity: 5,
      afterQuantity: 4,
      inventoryStatus: 'RESERVED',
      outboundQuantity: 1,
      outboundStatus: 'PARTIAL',
      orderStatus: 'so_created',
      reservedQuantity: 1,
    });

    const firstOutboundReplayResponse = await fetch(`${backendBaseUrl}/inventory-transactions/outbound`, {
      method: 'POST',
      headers: mutationHeaders(managerToken, outboundKey),
      body: JSON.stringify(outboundBody),
    });
    expect(firstOutboundReplayResponse.status).toBe(201);
    expect(firstOutboundReplayResponse.headers.get('Idempotency-Replayed')).toBe('true');
    const firstOutboundReplay = await firstOutboundReplayResponse.json() as ApiEnvelope<{ id: string }>;
    expect(firstOutboundReplay.data.id).toBe(firstOutbound.data.id);

    const transactionHistoryResponse = await fetch(`${backendBaseUrl}/inventory-transactions/order/${orderId}`, {
      headers: { Authorization: `Bearer ${managerToken}` },
    });
    expect(transactionHistoryResponse.ok).toBeTruthy();
    const transactionHistory = await transactionHistoryResponse.json() as ApiEnvelope<Array<{ id: string; type: string }>>;
    expect(transactionHistory.data.filter((transaction) => transaction.type === 'OUTBOUND')).toHaveLength(1);
    expect(transactionHistory.data.filter((transaction) => transaction.type === 'RESERVATION')).toHaveLength(1);

    const secondOutboundResponse = await fetch(`${backendBaseUrl}/inventory-transactions/outbound`, {
      method: 'POST',
      headers: mutationHeaders(managerToken, `e2e-core-outbound-two-${suffix}`),
      body: JSON.stringify({
        inventoryDetailId,
        orderId,
        quantity: 1,
        notes: 'Complete outbound.',
      }),
    });
    expect(secondOutboundResponse.status).toBe(201);
    const secondOutbound = await secondOutboundResponse.json() as ApiEnvelope<{
      afterQuantity: number;
      inventoryStatus: string;
      outboundQuantity: number;
      outboundStatus: string;
      orderStatus: string;
      reservedQuantity: number;
    }>;
    expect(secondOutbound.data).toMatchObject({
      afterQuantity: 3,
      inventoryStatus: 'AVAILABLE',
      outboundQuantity: 2,
      outboundStatus: 'COMPLETED',
      orderStatus: 'shipped',
      reservedQuantity: 0,
    });

    const shippedOrderResponse = await fetch(`${backendBaseUrl}/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${managerToken}` },
    });
    expect(shippedOrderResponse.ok).toBeTruthy();
    const shippedOrder = await shippedOrderResponse.json() as ApiEnvelope<{
      status: string;
      outboundQuantity: number;
      outboundStatus: string;
      inventoryDetailId: string;
    }>;
    expect(shippedOrder.data).toMatchObject({
      status: 'shipped',
      outboundQuantity: 2,
      outboundStatus: 'COMPLETED',
      inventoryDetailId,
    });

    const certificateKey = `e2e-core-certificate-${suffix}`;
    const certificateBody = {
      inventoryDetailId,
      orderId,
      quotationId: createdQuote.data.id,
      partNumber,
      quantity: 2,
      certificateType: 'FAA-8130-3',
      issuerCompany: 'AeroLink E2E',
    };
    const issueCertificateResponse = await fetch(`${backendBaseUrl}/certificates/issue`, {
      method: 'POST',
      headers: mutationHeaders(managerToken, certificateKey),
      body: JSON.stringify(certificateBody),
    });
    expect(issueCertificateResponse.status).toBe(201);
    const issuedCertificate = await issueCertificateResponse.json() as ApiEnvelope<{
      id: string;
      inventoryDetailId: string;
      orderId: string;
      quotationId: string;
      partNumber: string;
    }>;
    expect(issuedCertificate.data).toMatchObject({
      inventoryDetailId,
      orderId,
      quotationId: createdQuote.data.id,
      partNumber,
    });

    const issueCertificateReplay = await fetch(`${backendBaseUrl}/certificates/issue`, {
      method: 'POST',
      headers: mutationHeaders(managerToken, certificateKey),
      body: JSON.stringify(certificateBody),
    });
    expect(issueCertificateReplay.status).toBe(201);
    expect(issueCertificateReplay.headers.get('Idempotency-Replayed')).toBe('true');
    expect((await issueCertificateReplay.json() as ApiEnvelope<{ id: string }>).data.id).toBe(issuedCertificate.data.id);

    const verifyCertificateResponse = await fetch(`${backendBaseUrl}/certificates/${issuedCertificate.data.id}/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${managerToken}` },
    });
    expect(verifyCertificateResponse.ok).toBeTruthy();
    const verifiedCertificate = await verifyCertificateResponse.json() as ApiEnvelope<{
      isValid: boolean;
      orderNumber: string;
      inventoryPartNumber: string;
    }>;
    expect(verifiedCertificate.data.isValid).toBe(true);
    expect(verifiedCertificate.data.orderNumber).toBe(acceptedQuote.data.order.orderNumber);
    expect(verifiedCertificate.data.inventoryPartNumber).toBe(partNumber);
  });

  test('allows only one concurrent reservation for the same inventory detail', async () => {
    const managerToken = await login('zhang@aerolink.com');
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partNumber = '3214-567-100';
    const inventoryDetailId = 'inv003';
    const [firstQuotation, secondQuotation] = await Promise.all([
      createApprovedQuotationForReservation(managerToken, partNumber, `${suffix}-one`),
      createApprovedQuotationForReservation(managerToken, partNumber, `${suffix}-two`),
    ]);

    const [firstReservation, secondReservation] = await Promise.all([
      fetch(`${backendBaseUrl}/inventory-transactions/reserve`, {
        method: 'POST',
        headers: mutationHeaders(managerToken, `e2e-race-reserve-${suffix}-one`),
        body: JSON.stringify({ inventoryDetailId, quotationId: firstQuotation.id, quantity: 1 }),
      }),
      fetch(`${backendBaseUrl}/inventory-transactions/reserve`, {
        method: 'POST',
        headers: mutationHeaders(managerToken, `e2e-race-reserve-${suffix}-two`),
        body: JSON.stringify({ inventoryDetailId, quotationId: secondQuotation.id, quantity: 1 }),
      }),
    ]);

    expect([firstReservation.status, secondReservation.status].sort()).toEqual([201, 409]);

    const detailTransactionsResponse = await fetch(`${backendBaseUrl}/inventory-transactions/detail/${inventoryDetailId}`, {
      headers: { Authorization: `Bearer ${managerToken}` },
    });
    expect(detailTransactionsResponse.ok).toBeTruthy();
    const detailTransactions = await detailTransactionsResponse.json() as ApiEnvelope<Array<{ type: string }>>;
    expect(detailTransactions.data.filter((transaction) => transaction.type === 'RESERVATION')).toHaveLength(1);
  });

  test('releases an unaccepted reservation atomically and replays the result safely', async () => {
    const managerToken = await login('zhang@aerolink.com');
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const inventoryDetailId = 'inv007';
    const quotation = await createApprovedQuotationForReservation(managerToken, '3456-789-012', suffix);

    const reserveResponse = await fetch(`${backendBaseUrl}/inventory-transactions/reserve`, {
      method: 'POST',
      headers: mutationHeaders(managerToken, `e2e-release-reserve-${suffix}`),
      body: JSON.stringify({ inventoryDetailId, quotationId: quotation.id, quantity: 1 }),
    });
    expect(reserveResponse.status).toBe(201);

    const releaseKey = `e2e-release-${suffix}`;
    const releaseBody = {
      quotationId: quotation.id,
      notes: 'Release stock after the customer pauses the purchase decision.',
    };
    const releaseResponse = await fetch(`${backendBaseUrl}/inventory-transactions/release`, {
      method: 'POST',
      headers: mutationHeaders(managerToken, releaseKey),
      body: JSON.stringify(releaseBody),
    });
    expect(releaseResponse.status).toBe(201);
    const released = await releaseResponse.json() as ApiEnvelope<{
      id: string;
      type: string;
      inventoryStatus: string;
      releasedQuantity: number;
      reservedQuantity: number;
    }>;
    expect(released.data).toMatchObject({
      type: 'RESERVATION_RELEASE',
      inventoryStatus: 'AVAILABLE',
      releasedQuantity: 1,
      reservedQuantity: 0,
    });

    const replayResponse = await fetch(`${backendBaseUrl}/inventory-transactions/release`, {
      method: 'POST',
      headers: mutationHeaders(managerToken, releaseKey),
      body: JSON.stringify(releaseBody),
    });
    expect(replayResponse.status).toBe(201);
    expect(replayResponse.headers.get('Idempotency-Replayed')).toBe('true');
    const replay = await replayResponse.json() as ApiEnvelope<{ id: string }>;
    expect(replay.data.id).toBe(released.data.id);

    const detailTransactionsResponse = await fetch(`${backendBaseUrl}/inventory-transactions/detail/${inventoryDetailId}`, {
      headers: { Authorization: `Bearer ${managerToken}` },
    });
    expect(detailTransactionsResponse.ok).toBeTruthy();
    const detailTransactions = await detailTransactionsResponse.json() as ApiEnvelope<Array<{ type: string; quotationId?: string }>>;
    const releasedTransactions = detailTransactions.data.filter((transaction) => (
      transaction.type === 'RESERVATION_RELEASE' && transaction.quotationId === quotation.id
    ));
    expect(releasedTransactions).toHaveLength(1);
  });
});
