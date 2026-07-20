import prisma from '../../lib/prisma.js';

/** Public repository boundary for the InventoryDetail aggregate. */
export const inventoryRepository = prisma.inventoryDetail;
/** Read-only ledger queries stay behind the same module boundary. */
export const inventoryTransactionRepository = prisma.inventoryTransaction;
