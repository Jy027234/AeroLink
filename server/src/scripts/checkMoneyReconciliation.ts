import { loadMoneyShadowReconciliation } from '../lib/moneyReconciliation.js';
import prisma from '../lib/prisma.js';

try {
  const result = await loadMoneyShadowReconciliation();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'PASS') {
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
}
