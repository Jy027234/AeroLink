import prisma from '../../lib/prisma.js';

/**
 * Read/query delegates owned by the quotation-order module.
 * Mutations that span quotation, order, documents and outbox remain in the
 * transaction supplied by the HTTP use case and must not be split here.
 */
export const quotationRepository = prisma.quotation;
export const orderRepository = prisma.order;
