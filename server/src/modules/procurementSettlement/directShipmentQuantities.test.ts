import { describe, expect, it } from 'vitest';
import {
  DIRECT_SHIPMENT_QUANTITY_MAX,
  deriveDirectShipmentQuantities,
  deriveMixedOrderDelivery,
  deriveMixedOrderDeliveryProjection,
  type DirectShipmentHead,
  type DirectShipmentLine,
  type DirectShipmentPurchaseLine,
  type MixedOrderDeliveryLine,
} from './directShipmentQuantities.js';

const purchase = (overrides: Partial<DirectShipmentPurchaseLine> = {}): DirectShipmentPurchaseLine => ({
  id: 'purchase-line-1',
  quantity: 10,
  cancelledQuantity: 0,
  receivedQuantity: 0,
  directShippedQuantity: 0,
  fulfillmentMode: 'SUPPLIER_DIRECT',
  ...overrides,
});

const directLine = (overrides: Partial<DirectShipmentLine> = {}): DirectShipmentLine => ({
  id: 'direct-line-1',
  purchaseCommitmentLineId: 'purchase-line-1',
  quantity: 2,
  reviewStatus: 'APPROVED',
  receivedQuantity: 0,
  ...overrides,
});

const directHead = (overrides: Partial<DirectShipmentHead> = {}): DirectShipmentHead => ({
  id: 'shipment-1',
  status: 'DISPATCHED',
  lines: [directLine()],
  ...overrides,
});

const expectQuantityError = (action: () => unknown, code?: string) => {
  if (code) {
    expect(action).toThrowError(expect.objectContaining({ code }));
  } else {
    expect(action).toThrow();
  }
};

describe('supplier direct shipment quantity projections', () => {
  it('splits a purchase line across prepared, cancelled, and dispatched batches', () => {
    const result = deriveDirectShipmentQuantities({
      purchaseLines: [purchase({ quantity: 12, cancelledQuantity: 2, directShippedQuantity: 3 })],
      shipments: [
        directHead({
          id: 'prepared-1',
          status: 'PREPARED',
          lines: [
            directLine({ id: 'prepared-pending', quantity: 4, reviewStatus: 'PENDING_REVIEW' }),
            directLine({ id: 'prepared-rejected', quantity: 2, reviewStatus: 'REJECTED' }),
          ],
        }),
        directHead({
          id: 'cancelled-1',
          status: 'CANCELLED',
          lines: [directLine({ id: 'cancelled-line', quantity: 3 })],
        }),
        directHead({
          id: 'dispatched-1',
          status: 'DISPATCHED',
          lines: [directLine({ id: 'dispatched-line', quantity: 3 })],
        }),
      ],
    });

    expect(result.perPurchaseLine).toEqual([{
      purchaseLineId: 'purchase-line-1',
      purchaseQuantity: 12,
      cancelledQuantity: 2,
      stockReceivedQuantity: 0,
      preparedQuantity: 4,
      dispatchedQuantity: 3,
      directShippedQuantity: 3,
      plannedQuantity: 7,
      customerReceivedQuantity: 0,
      remainingToPlan: 3,
    }]);
    expect(result.heads.map(head => ({
      id: head.headId,
      planned: head.plannedQuantity,
      dispatched: head.dispatchedQuantity,
      received: head.customerReceivedQuantity,
      remaining: head.remainingToReceive,
    }))).toEqual([
      { id: 'prepared-1', planned: 4, dispatched: 0, received: 0, remaining: 0 },
      { id: 'cancelled-1', planned: 0, dispatched: 0, received: 0, remaining: 0 },
      { id: 'dispatched-1', planned: 3, dispatched: 3, received: 0, remaining: 3 },
    ]);
    expect(result.headTotals).toEqual({
      headCount: 3,
      lineCount: 4,
      preparedQuantity: 4,
      plannedQuantity: 7,
      dispatchedQuantity: 3,
      customerReceivedQuantity: 0,
      cancelledHeadCount: 1,
    });
  });

  it('reconciles two dispatched batches with partial customer receipt', () => {
    const result = deriveDirectShipmentQuantities({
      purchaseLines: [purchase({ quantity: 8, directShippedQuantity: 5 })],
      shipments: [
        directHead({ id: 'batch-1', lines: [directLine({ id: 'line-1', quantity: 2 })] }),
        directHead({
          id: 'batch-2',
          status: 'PARTIALLY_RECEIVED',
          lines: [directLine({ id: 'line-2', quantity: 3, receivedQuantity: 1 })],
        }),
      ],
    });

    expect(result.perPurchaseLine[0]).toMatchObject({
      plannedQuantity: 5,
      dispatchedQuantity: 5,
      directShippedQuantity: 5,
      customerReceivedQuantity: 1,
      remainingToPlan: 3,
    });
    expect(result.heads[1]).toMatchObject({
      status: 'PARTIALLY_RECEIVED',
      plannedQuantity: 3,
      dispatchedQuantity: 3,
      customerReceivedQuantity: 1,
      remainingToReceive: 2,
    });
    expect(result.headTotals).toMatchObject({
      plannedQuantity: 5,
      dispatchedQuantity: 5,
      customerReceivedQuantity: 1,
    });
  });

  it('keeps local inventory and supplier-direct quantities separate for mixed delivery', () => {
    const orderLines: MixedOrderDeliveryLine[] = [
      { id: 'order-line-1', quantity: 10, localOutbound: 4, directShipped: 6, localReceived: 3, directReceived: 2 },
      { id: 'order-line-2', quantity: 4, localOutbound: 2, directShipped: 0, localReceived: 2, directReceived: 0 },
    ];

    const result = deriveMixedOrderDelivery(orderLines);

    expect(result.lines).toEqual([
      expect.objectContaining({
        orderLineId: 'order-line-1',
        localOutbound: 4,
        directShipped: 6,
        localReceived: 3,
        directReceived: 2,
        remainingToDispatch: 0,
        remainingLocalToReceive: 1,
        remainingDirectToReceive: 4,
        remainingToReceive: 5,
        fullyDispatched: true,
        fullyReceived: false,
      }),
      expect.objectContaining({
        orderLineId: 'order-line-2',
        localOutbound: 2,
        directShipped: 0,
        remainingToDispatch: 2,
        remainingToReceive: 2,
        fullyDispatched: false,
        fullyReceived: false,
      }),
    ]);
    expect(result.totals).toEqual({
      quantity: 14,
      localOutbound: 6,
      directShipped: 6,
      localReceived: 5,
      directReceived: 2,
      remainingToDispatch: 2,
      remainingToReceive: 7,
      fullyDispatched: false,
      fullyReceived: false,
    });
  });

  it('rejects duplicate identities and unknown direct sources', () => {
    expectQuantityError(() => deriveDirectShipmentQuantities({
      purchaseLines: [purchase(), purchase({ id: 'purchase-line-1' })],
      shipments: [],
    }), 'DUPLICATE_PURCHASE_LINE_ID');

    expectQuantityError(() => deriveDirectShipmentQuantities({
      purchaseLines: [purchase({ directShippedQuantity: 2 })],
      shipments: [
        directHead({ id: 'shipment-1' }),
        directHead({ id: 'shipment-1', lines: [directLine({ id: 'direct-line-2' })] }),
      ],
    }), 'DUPLICATE_DIRECT_HEAD_ID');

    expectQuantityError(() => deriveDirectShipmentQuantities({
      purchaseLines: [purchase({ directShippedQuantity: 4 })],
      shipments: [directHead({ lines: [directLine({ id: 'same', quantity: 2 }), directLine({ id: 'same', quantity: 2 })] })],
    }), 'DUPLICATE_DIRECT_LINE_ID');

    expectQuantityError(() => deriveDirectShipmentQuantities({
      purchaseLines: [purchase({ directShippedQuantity: 1 })],
      shipments: [directHead({ lines: [directLine({ purchaseCommitmentLineId: 'missing' })] })],
    }), 'UNKNOWN_PURCHASE_LINE');
  });

  it('does not mix stock receipt and supplier-direct fulfilment', () => {
    expectQuantityError(() => deriveDirectShipmentQuantities({
      purchaseLines: [purchase({ fulfillmentMode: 'STOCK_RECEIPT' })],
      shipments: [directHead()],
    }), 'FULFILLMENT_MODE_MISMATCH');

    expectQuantityError(() => deriveDirectShipmentQuantities({
      purchaseLines: [purchase({ receivedQuantity: 1 })],
      shipments: [],
    }), 'FULFILLMENT_MODE_MISMATCH');
  });

  it('requires approved lines and exact purchase direct-shipped reconciliation', () => {
    expectQuantityError(() => deriveDirectShipmentQuantities({
      purchaseLines: [purchase({ directShippedQuantity: 2 })],
      shipments: [directHead({ lines: [directLine({ reviewStatus: 'PENDING_REVIEW' })] })],
    }), 'DIRECT_REVIEW_REQUIRED');

    expectQuantityError(() => deriveDirectShipmentQuantities({
      purchaseLines: [purchase({ directShippedQuantity: 1 })],
      shipments: [directHead()],
    }), 'DIRECT_SHIPPED_MISMATCH');

    expectQuantityError(() => deriveDirectShipmentQuantities({
      purchaseLines: [purchase({ quantity: 4, cancelledQuantity: 2, directShippedQuantity: 3 })],
      shipments: [directHead({ lines: [directLine({ quantity: 3 })] })],
    }), 'DIRECT_COVERAGE_EXCEEDED');
  });

  it('requires head status to match the aggregate customer receipt', () => {
    const cases: Array<{ head: DirectShipmentHead; code: string }> = [
      {
        head: directHead({ status: 'DISPATCHED', lines: [directLine({ receivedQuantity: 1 })] }),
        code: 'HEAD_STATUS_QUANTITY_MISMATCH',
      },
      {
        head: directHead({ status: 'PARTIALLY_RECEIVED', lines: [directLine({ receivedQuantity: 0 })] }),
        code: 'HEAD_STATUS_QUANTITY_MISMATCH',
      },
      {
        head: directHead({ status: 'PARTIALLY_RECEIVED', lines: [directLine({ receivedQuantity: 2 })] }),
        code: 'HEAD_STATUS_QUANTITY_MISMATCH',
      },
      {
        head: directHead({ status: 'DELIVERED', lines: [directLine({ receivedQuantity: 1 })] }),
        code: 'HEAD_STATUS_QUANTITY_MISMATCH',
      },
      {
        head: directHead({ status: 'CANCELLED', lines: [directLine({ receivedQuantity: 1 })] }),
        code: 'INVALID_RECEIVED_QUANTITY',
      },
    ];
    for (const testCase of cases) {
      expectQuantityError(() => deriveDirectShipmentQuantities({
        purchaseLines: [purchase({ directShippedQuantity: testCase.head.status === 'CANCELLED' ? 0 : 2 })],
        shipments: [testCase.head],
      }), testCase.code);
    }
  });

  it('rejects invalid quantities, over-coverage, and Int32 aggregate overflow', () => {
    for (const quantity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, DIRECT_SHIPMENT_QUANTITY_MAX + 1]) {
      expectQuantityError(() => deriveDirectShipmentQuantities({
        purchaseLines: [purchase({ quantity })],
        shipments: [],
      }));
    }

    expectQuantityError(() => deriveDirectShipmentQuantities({
      purchaseLines: [purchase({
        quantity: 3, cancelledQuantity: 2, receivedQuantity: 2, fulfillmentMode: 'STOCK_RECEIPT',
      })],
      shipments: [],
    }), 'DIRECT_COVERAGE_EXCEEDED');

    expectQuantityError(() => deriveMixedOrderDeliveryProjection({
      orderLines: [
        { id: 'line-1', quantity: DIRECT_SHIPMENT_QUANTITY_MAX, localOutbound: 0, directShipped: 0, localReceived: 0, directReceived: 0 },
        { id: 'line-2', quantity: 1, localOutbound: 0, directShipped: 0, localReceived: 0, directReceived: 0 },
      ],
    }), 'QUANTITY_OVERFLOW');
  });

  it('rejects mixed delivery over-dispatch and cross-source receipt', () => {
    expectQuantityError(() => deriveMixedOrderDeliveryProjection({
      orderLines: [{ id: 'line-1', quantity: 5, localOutbound: 3, directShipped: 3, localReceived: 0, directReceived: 0 }],
    }), 'ORDER_COVERAGE_EXCEEDED');
    expectQuantityError(() => deriveMixedOrderDeliveryProjection({
      orderLines: [{ id: 'line-1', quantity: 5, localOutbound: 3, directShipped: 2, localReceived: 4, directReceived: 0 }],
    }), 'ORDER_COVERAGE_EXCEEDED');
    expectQuantityError(() => deriveMixedOrderDeliveryProjection({
      orderLines: [
        { id: 'line-1', quantity: 5, localOutbound: 0, directShipped: 5, localReceived: 0, directReceived: 6 },
      ],
    }), 'ORDER_COVERAGE_EXCEEDED');
    expectQuantityError(() => deriveMixedOrderDeliveryProjection({
      orderLines: [
        { id: 'line-1', quantity: 5, localOutbound: 0, directShipped: 5, localReceived: 0, directReceived: 0 },
        { id: 'line-1', quantity: 1, localOutbound: 0, directShipped: 0, localReceived: 0, directReceived: 0 },
      ],
    }), 'DUPLICATE_PURCHASE_LINE_ID');
  });

  it('keeps an all-dispatched, all-received mixed order fully complete', () => {
    const result = deriveMixedOrderDeliveryProjection({
      orderLines: [
        { id: 'line-1', quantity: 5, localOutbound: 2, directShipped: 3, localReceived: 2, directReceived: 3 },
      ],
    });
    expect(result.totals).toMatchObject({
      remainingToDispatch: 0,
      remainingToReceive: 0,
      fullyDispatched: true,
      fullyReceived: true,
    });
    expect(result.lines[0]).toMatchObject({ fullyDispatched: true, fullyReceived: true });
  });
});
