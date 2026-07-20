import prisma from '../../lib/prisma.js';

/** Query delegate owned by the RFQ/sourcing module. */
export const rfqRepository = prisma.rFQ;
