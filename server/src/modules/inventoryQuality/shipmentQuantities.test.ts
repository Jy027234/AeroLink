import { describe, expect, it } from 'vitest';
import {
  calculateShipmentLineQuantities,
  calculateShippableQuantities,
  deriveOrderDeliveryProgress,
  type OrderLineDeliveryQuantity,
} from './shipmentQuantities.js';

const expectInconsistent = (operation: () => unknown) => {
  expect(operation).toThrowError(expect.objectContaining({
    statusCode: 409,
    code: 'ALLOCATION_INCONSISTENT',
  }));
};

describe('calculateShippableQuantities', () => {
  it('keeps two real batches and two shipment slices separate for one order line', () => {
    const result = calculateShippableQuantities(
      [
        { id: 'outbound-batch-a', quantity: 4 },
        { id: 'outbound-batch-b', quantity: 6 },
      ],
      [
        { id: 'shipment-a-line', outboundTransactionId: 'outbound-batch-a', quantity: 4 },
        { id: 'shipment-b-line', outboundTransactionId: 'outbound-batch-b', quantity: 2 },
      ],
    );

    expect(result).toEqual({
      actualOutboundQuantity: 10,
      boundShipmentQuantity: 6,
      shippableQuantity: 4,
      byOutboundTransaction: [
        {
          outboundTransactionId: 'outbound-batch-a',
          actualOutboundQuantity: 4,
          boundShipmentQuantity: 4,
          shippableQuantity: 0,
        },
        {
          outboundTransactionId: 'outbound-batch-b',
          actualOutboundQuantity: 6,
          boundShipmentQuantity: 2,
          shippableQuantity: 4,
        },
      ],
    });
  });

  it('allows one OUTBOUND transaction to be split across multiple shipments while preserving total balance', () => {
    const result = calculateShippableQuantities(
      [{ id: 'outbound-1', quantity: 7 }],
      [
        { id: 'shipment-1-line', outboundTransactionId: 'outbound-1', quantity: 3 },
        { id: 'shipment-2-line', outboundTransactionId: 'outbound-1', quantity: 2 },
      ],
    );

    expect(result.boundShipmentQuantity).toBe(5);
    expect(result.shippableQuantity).toBe(2);
    expect(result.byOutboundTransaction[0].shippableQuantity).toBe(2);
  });

  it('rejects duplicate or over-allocated OUTBOUND bindings', () => {
    expectInconsistent(() => calculateShippableQuantities(
      [{ id: 'outbound-1', quantity: 5 }],
      [
        { id: 'shipment-1-line', outboundTransactionId: 'outbound-1', quantity: 3 },
        { id: 'shipment-2-line', outboundTransactionId: 'outbound-1', quantity: 3 },
      ],
    ));
    expectInconsistent(() => calculateShippableQuantities(
      [{ id: 'outbound-1', quantity: 5 }],
      [{ id: 'shipment-1-line', outboundTransactionId: 'outbound-1', quantity: 1 },
        { id: 'shipment-1-line', outboundTransactionId: 'outbound-1', quantity: 1 }],
    ));
    expectInconsistent(() => calculateShippableQuantities(
      [{ id: 'outbound-1', quantity: 5 }],
      [{ id: 'shipment-1-line', outboundTransactionId: 'outbound-missing', quantity: 1 }],
    ));
  });
});

describe('calculateShipmentLineQuantities', () => {
  it('derives partial receipt, net receipt, and remaining return headroom', () => {
    expect(calculateShipmentLineQuantities({
      shipmentLineId: 'shipment-1-line',
      shippedQuantity: 5,
      receivedQuantity: 3,
      returnedQuantity: 1,
    })).toEqual({
      shipmentLineId: 'shipment-1-line',
      shippedQuantity: 5,
      receivedQuantity: 3,
      returnedQuantity: 1,
      remainingToReceive: 2,
      remainingToReturn: 4,
      fullyReceived: false,
    });
  });

  it('allows a refused shipment to return before any customer receipt', () => {
    expect(calculateShipmentLineQuantities({
      shipmentLineId: 'shipment-refused-line',
      shippedQuantity: 5,
      receivedQuantity: 0,
      returnedQuantity: 2,
    })).toMatchObject({
      remainingToReceive: 5,
      remainingToReturn: 3,
      fullyReceived: false,
    });
  });

  it('does not mark a partially received shipment line as complete', () => {
    expect(calculateShipmentLineQuantities({
      shipmentLineId: 'shipment-2-line',
      shippedQuantity: 5,
      receivedQuantity: 5,
      returnedQuantity: 0,
    }).fullyReceived).toBe(true);
    expect(calculateShipmentLineQuantities({
      shipmentLineId: 'shipment-3-line',
      shippedQuantity: 5,
      receivedQuantity: 4,
      returnedQuantity: 0,
    }).fullyReceived).toBe(false);
  });

  it('rejects receipt or return quantities beyond their source quantity', () => {
    expectInconsistent(() => calculateShipmentLineQuantities({
      shipmentLineId: 'shipment-1-line', shippedQuantity: 4, receivedQuantity: 5, returnedQuantity: 0,
    }));
    expectInconsistent(() => calculateShipmentLineQuantities({
      shipmentLineId: 'shipment-1-line', shippedQuantity: 4, receivedQuantity: 0, returnedQuantity: 5,
    }));
  });
});

describe('deriveOrderDeliveryProgress', () => {
  const partialLines: OrderLineDeliveryQuantity[] = [
    { orderLineId: 'order-line-1', quantity: 6, receivedQuantity: 4 },
    { orderLineId: 'order-line-2', quantity: 2, receivedQuantity: 2 },
  ];

  it('derives order completion from every line receipt, not shipment status text', () => {
    expect(deriveOrderDeliveryProgress(partialLines)).toMatchObject({
      requiredQuantity: 8,
      receivedQuantity: 6,
      remainingQuantity: 2,
      complete: false,
    });
    expect(deriveOrderDeliveryProgress(partialLines.map((line) => ({ ...line, receivedQuantity: line.quantity })))).toMatchObject({
      requiredQuantity: 8,
      receivedQuantity: 8,
      remainingQuantity: 0,
      complete: true,
    });
  });

  it('does not call an empty order delivered', () => {
    expect(deriveOrderDeliveryProgress([])).toEqual({
      requiredQuantity: 0,
      receivedQuantity: 0,
      remainingQuantity: 0,
      complete: false,
      lines: [],
    });
  });

  it('rejects duplicate lines and receipt overages', () => {
    expectInconsistent(() => deriveOrderDeliveryProgress([
      { orderLineId: 'order-line-1', quantity: 5, receivedQuantity: 5 },
      { orderLineId: 'order-line-1', quantity: 5, receivedQuantity: 0 },
    ]));
    expectInconsistent(() => deriveOrderDeliveryProgress([
      { orderLineId: 'order-line-1', quantity: 5, receivedQuantity: 6 },
    ]));
  });
});

describe('shipment quantity validation', () => {
  it('rejects zero, negative, fractional, and unsafe values', () => {
    expectInconsistent(() => calculateShippableQuantities([{ id: 'outbound-1', quantity: 0 }], []));
    expectInconsistent(() => calculateShippableQuantities([{ id: 'outbound-1', quantity: -1 }], []));
    expectInconsistent(() => calculateShippableQuantities([{ id: 'outbound-1', quantity: 1.5 }], []));
    expectInconsistent(() => calculateShipmentLineQuantities({
      shipmentLineId: 'shipment-1-line', shippedQuantity: 0, receivedQuantity: 0, returnedQuantity: 0,
    }));
    expectInconsistent(() => deriveOrderDeliveryProgress([
      { orderLineId: 'order-line-1', quantity: 1.5, receivedQuantity: 0 },
    ]));
  });

  it('rejects safe-integer aggregate overflow', () => {
    expectInconsistent(() => calculateShippableQuantities([
      { id: 'outbound-1', quantity: Number.MAX_SAFE_INTEGER },
      { id: 'outbound-2', quantity: Number.MAX_SAFE_INTEGER },
    ], []));
    expectInconsistent(() => deriveOrderDeliveryProgress([
      { orderLineId: 'order-line-1', quantity: Number.MAX_SAFE_INTEGER, receivedQuantity: 0 },
      { orderLineId: 'order-line-2', quantity: Number.MAX_SAFE_INTEGER, receivedQuantity: 0 },
    ]));
  });
});
