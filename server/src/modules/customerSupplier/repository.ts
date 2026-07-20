import prisma from '../../lib/prisma.js';

/**
 * Public repository boundary for Customer and Supplier data access.
 * Route handlers may compose query arguments, but they no longer reach the
 * Prisma delegates directly. Cross-aggregate transactions remain in the
 * owning service until their use cases are extracted in a later batch.
 */
export const customerRepository = prisma.customer;
export const supplierRepository = prisma.supplier;
