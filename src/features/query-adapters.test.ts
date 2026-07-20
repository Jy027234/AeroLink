import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAccessToken, setAccessToken } from '@/api/client';
import { listRfqs } from '@/features/rfqs';
import { createCustomer, listCustomers } from '@/features/customers';
import { createInventoryReservation, getInventoryItemByPartNumber, listInventoryTransactionsByOrder, updateInventory } from '@/features/inventory';
import { dispatchNotification, listDocumentTemplates } from '@/features/integrations';

describe('generated feature query adapters', () => {
  beforeEach(() => {
    setAccessToken('query-token');
  });

  afterEach(() => {
    setAccessToken(null);
    vi.restoreAllMocks();
  });

  it('uses generated RFQ paths, query parameters, credentials and the in-memory token', async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.url).toContain('/api/rfqs?page=2&limit=10&search=engine');
      expect(request.credentials).toBe('include');
      expect(request.headers.get('Authorization')).toBe('Bearer query-token');
      return new Response(JSON.stringify({
        success: true,
        data: [],
        pagination: { page: 2, limit: 10, total: 0, totalPages: 0 },
        summary: { total: 0 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await listRfqs({ page: 2, limit: 10, search: 'engine' });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBe('query-token');
  });

  it('forwards AbortSignal through the generated customer adapter', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.signal).toBe(controller.signal);
      return new Response(JSON.stringify({ success: true, data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await listCustomers({}, controller.signal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('routes core writes through generated customer and inventory operations', async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.credentials).toBe('include');
      expect(request.headers.get('Authorization')).toBe('Bearer query-token');
      if (request.method === 'POST') {
        expect(request.url).toContain('/api/customers');
        expect(await request.json()).toMatchObject({ name: 'ACME', contactName: 'Buyer' });
      } else {
        expect(request.method).toBe('PATCH');
        expect(request.url).toContain('/api/inventory/inv-1');
        expect(await request.json()).toMatchObject({ quantity: 3 });
      }
      return new Response(JSON.stringify({ success: true, data: { id: 'resource-1' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await createCustomer({ name: 'ACME', contactName: 'Buyer', email: 'buyer@example.test' });
    await updateInventory('inv-1', { quantity: 3, partCategory: 'CONSUMABLE', trackingType: 'BATCH', conditionCode: 'NE', certificateType: 'NONE', unitOfMeasure: 'EA', unitCost: 0, lifeLimited: false, nonIncidentStatement: false, militarySource: false, ata300Packaging: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('routes order-side inventory reads through canonical generated endpoints', async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.method).toBe('GET');
      if (request.url.includes('/inventory-items/part/')) {
        return new Response(JSON.stringify({ id: 'item-1', partNumber: 'PN-1', details: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      expect(request.url).toContain('/api/inventory-transactions/order/order-1');
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const item = await getInventoryItemByPartNumber('PN-1');
    const transactions = await listInventoryTransactionsByOrder('order-1');

    expect(item.partNumber).toBe('PN-1');
    expect(transactions.data).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps one idempotency key when a generated inventory mutation refreshes auth', async () => {
    setAccessToken('expired-token');
    const requestKeys: string[] = [];
    const fetchMock = vi.fn(async (input: Request | string) => {
      if (typeof input === 'string') {
        return new Response(JSON.stringify({ success: true, data: { accessToken: 'refreshed-token' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      requestKeys.push(input.headers.get('Idempotency-Key') || '');
      if (requestKeys.length === 1) {
        return new Response(JSON.stringify({ success: false, message: 'expired' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true, data: { id: 'reservation-1' } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await createInventoryReservation({ inventoryDetailId: 'detail-1', quotationId: 'quote-1', quantity: 1 });

    expect(result.data?.id).toBe('reservation-1');
    expect(requestKeys).toHaveLength(2);
    expect(requestKeys[0]).toBeTruthy();
    expect(requestKeys[1]).toBe(requestKeys[0]);
  });

  it('routes document templates and notification dispatch through the integration feature', async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      if (request.method === 'GET') {
        expect(request.url).toContain('/api/document-templates?documentType=ORDER_CONTRACT');
        return new Response(JSON.stringify({ success: true, data: [{ id: 'template-1', name: 'Contract' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      expect(request.url).toContain('/api/notifications/dispatch');
      expect(request.headers.get('Idempotency-Key')).toBeTruthy();
      return new Response(JSON.stringify({ success: true, data: { dispatched: 1, channels: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const templates = await listDocumentTemplates('ORDER_CONTRACT');
    const notification = await dispatchNotification({ event: 'AOG_RFQ_CREATED', payload: { partNumber: 'PN-1' } });

    expect(templates.data[0]?.id).toBe('template-1');
    expect(notification.data.dispatched).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
