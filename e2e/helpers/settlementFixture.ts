import { createRequire } from 'node:module';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const requireServer = createRequire(path.resolve('server/package.json'));

type DecimalLike = { toFixed: (digits: number) => string };
type UserProjection = { id: string; email: string; name: string };
type PurchaseCandidate = {
  id: string;
  commitmentNumber: string;
  currency: string;
  status: string;
  totalCost: DecimalLike;
  order: {
    id: string;
    orderNumber: string;
    lineItemsMode: boolean;
    status: string;
    totalAmountDecimal: DecimalLike | null;
    quotation: { creator: UserProjection };
  };
};

type PurchaseCommitmentDelegate = {
  findMany: (args: unknown) => Promise<PurchaseCandidate[]>;
};

type UserDelegate = {
  create: (args: {
    data: { email: string; name: string; password: string; role: string; department: string };
  }) => Promise<UserProjection>;
  update: (args: { where: { id: string }; data: { password: string } }) => Promise<UserProjection>;
};

type SettlementUiDatabase = {
  purchaseCommitment: PurchaseCommitmentDelegate;
  user: UserDelegate;
  $disconnect: () => Promise<void>;
};

type PrismaRuntime = { PrismaClient: new () => SettlementUiDatabase };
type BcryptRuntime = { hash: (value: string, rounds: number) => Promise<string> };

const { PrismaClient } = requireServer('@prisma/client') as PrismaRuntime;
const bcrypt = requireServer('bcryptjs') as BcryptRuntime;

const expectedDatabase = 'aerolink_settlement_test_20260910';
const expectedPort = '55970';

/** Password shared by the three disposable UI identities created for one run. */
export const SETTLEMENT_UI_PASSWORD = process.env.AEROLINK_SETTLEMENT_UI_PASSWORD
  || 'Synthetic-Settlement-UI-Only!2026';

export type SettlementUiFixture = {
  tag: string;
  orderId: string;
  orderNumber: string;
  orderAmount: string;
  purchaseId: string;
  purchaseNumber: string;
  purchaseAmount: string;
  salesEmail: string;
  financeEmail: string;
  outsiderEmail: string;
};

function assertLocalIntegrationDatabase() {
  if (process.env.AEROLINK_SETTLEMENT_UI_INTEGRATION !== 'true') {
    throw new Error('Explicit AEROLINK_SETTLEMENT_UI_INTEGRATION=true is required');
  }
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error('DATABASE_URL is required for the settlement UI fixture');
  const databaseUrl = new URL(rawUrl);
  if (!['localhost', '127.0.0.1'].includes(databaseUrl.hostname)
    || databaseUrl.port !== expectedPort
    || databaseUrl.pathname !== `/${expectedDatabase}`) {
    throw new Error(`Refusing non-local/non-${expectedDatabase} DATABASE_URL`);
  }
}

function isSyntheticSalesCreator(user: UserProjection) {
  return user.email.includes('@example.invalid') && user.name.toLowerCase().includes('synthetic');
}

/**
 * Finds an existing modern order/purchase on the isolated settlement clone,
 * then creates only disposable login identities for the UI run.  It never
 * creates, updates, or deletes commercial/order/settlement facts.
 */
export async function createSettlementUiFixture(): Promise<SettlementUiFixture> {
  assertLocalIntegrationDatabase();
  const tag = randomUUID().replaceAll('-', '').slice(0, 12);
  const db = new PrismaClient();
  try {
    const candidates = await db.purchaseCommitment.findMany({
      where: {
        status: { in: ['CONFIRMED', 'CLOSED'] },
        currency: 'USD',
        totalCost: { gt: '1' },
        order: {
          lineItemsMode: true,
          totalAmountDecimal: { gt: '1' },
          status: { in: ['SO_CREATED', 'PO_CREATED', 'SHIPPED', 'DELIVERED'] },
          settlementAccounts: { none: {} },
        },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        commitmentNumber: true,
        currency: true,
        status: true,
        totalCost: true,
        order: {
          select: {
            id: true,
            orderNumber: true,
            lineItemsMode: true,
            status: true,
            totalAmountDecimal: true,
            quotation: { select: { creator: { select: { id: true, email: true, name: true } } } },
          },
        },
      },
    });
    const safeCandidates = candidates.filter(candidate => isSyntheticSalesCreator(candidate.order.quotation.creator));
    const candidate = safeCandidates.find(row => row.order.orderNumber.startsWith('D14-DIRECT-ORDER-'))
      || safeCandidates[0];
    if (!candidate) {
      throw new Error('Need an unused confirmed/closed USD purchase on a modern order with a synthetic sales creator');
    }
    if (!candidate.order.totalAmountDecimal) throw new Error('Selected order is missing totalAmountDecimal');
    if (candidate.currency !== 'USD' || candidate.status === 'DRAFT') {
      throw new Error('Selected purchase is not a confirmed USD commercial fact');
    }

    const passwordHash = await bcrypt.hash(SETTLEMENT_UI_PASSWORD, 10);
    await db.user.update({
      where: { id: candidate.order.quotation.creator.id },
      data: { password: passwordHash },
    });

    const financeEmail = `settlement-finance-${tag}@example.invalid`;
    const outsiderEmail = `settlement-outsider-${tag}@example.invalid`;
    await db.user.create({
      data: {
        email: financeEmail,
        name: `Synthetic settlement finance ${tag}`,
        password: passwordHash,
        role: 'FINANCE',
        department: 'Finance',
      },
    });
    await db.user.create({
      data: {
        email: outsiderEmail,
        name: `Synthetic settlement outsider ${tag}`,
        password: passwordHash,
        role: 'SALES',
        department: 'Other',
      },
    });

    return {
      tag,
      orderId: candidate.order.id,
      orderNumber: candidate.order.orderNumber,
      orderAmount: candidate.order.totalAmountDecimal.toFixed(4),
      purchaseId: candidate.id,
      purchaseNumber: candidate.commitmentNumber,
      purchaseAmount: candidate.totalCost.toFixed(4),
      salesEmail: candidate.order.quotation.creator.email,
      financeEmail,
      outsiderEmail,
    };
  } finally {
    await db.$disconnect();
  }
}
