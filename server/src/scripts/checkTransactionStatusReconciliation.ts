import prisma from '../lib/prisma.js';
import { loadTransactionStatusShadowReconciliation } from '../lib/transactionStatusShadows.js';

try {
  const result = await loadTransactionStatusShadowReconciliation();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'PASS') {
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
}
