import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';

const databaseUrl = new URL(process.env.DATABASE_URL || 'postgresql://invalid/');
if (process.env.AEROLINK_SETTLEMENT_INTEGRATION !== 'true'
  || !['localhost', '127.0.0.1'].includes(databaseUrl.hostname)
  || databaseUrl.port !== '55970'
  || databaseUrl.pathname !== '/aerolink_settlement_test_20260910') {
  throw new Error('Explicit opt-in and local aerolink_settlement_test_20260910:55970 required');
}

const preferredAccountId = '67b3b586-c1d3-4098-82c1-a697d55e8035';
const tag = randomUUID().replaceAll('-', '').slice(0, 12);
const db = new PrismaClient();
const checks: string[] = [];
const failureDetails: Array<{
  label: string;
  prismaCode: string;
  postgresCode: string;
  postgresMessage: string;
}> = [];

type SettlementAccountWithRecords = Prisma.SettlementAccountGetPayload<{
  include: { records: { orderBy: { accountVersion: 'asc' } } };
}>;
type EvidenceFingerprint = { id: string; version: number; sha256: string; status: 'AVAILABLE' };

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function decimal(value: Prisma.Decimal.Value) {
  return new Prisma.Decimal(value);
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorCode(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error) return String((error as { code?: unknown }).code);
  return '';
}

function databaseFailure(error: unknown) {
  const fullText = errorText(error);
  const value = error && typeof error === 'object'
    ? error as { meta?: { code?: unknown; message?: unknown } }
    : {};
  const metaCode = typeof value.meta?.code === 'string' ? value.meta.code : '';
  const metaMessage = typeof value.meta?.message === 'string' ? value.meta.message : '';
  const parsedCode = fullText.match(/Raw query failed\. Code:\s*`?([A-Z0-9]+)`?/i)?.[1] || '';
  const parsedMessage = fullText.match(/Message:\s*`?([\s\S]*)/i)?.[1]?.replace(/`\s*$/, '') || '';
  return {
    prismaCode: errorCode(error),
    postgresCode: metaCode || parsedCode,
    postgresMessage: metaMessage || parsedMessage || fullText,
  };
}

function asEvidence(value: unknown): EvidenceFingerprint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || typeof item.version !== 'number' || typeof item.sha256 !== 'string' || item.status !== 'AVAILABLE') return null;
  return { id: item.id, version: item.version, sha256: item.sha256, status: 'AVAILABLE' };
}

async function loadAccount(id: string) {
  return db.settlementAccount.findUnique({
    where: { id },
    include: { records: { orderBy: { accountVersion: 'asc' } } },
  });
}

async function usableEvidence(account: SettlementAccountWithRecords) {
  for (const record of [...account.records].reverse()) {
    if (!Array.isArray(record.evidence)) continue;
    for (const value of record.evidence) {
      const fingerprint = asEvidence(value);
      if (!fingerprint) continue;
      const file = await db.storedObject.findUnique({ where: { id: fingerprint.id } });
      if (file
        && file.status === 'AVAILABLE'
        && file.domain === 'settlement_account'
        && file.resourceId === account.id
        && file.ownerId === record.actorId
        && file.version === fingerprint.version
        && file.sha256 === fingerprint.sha256) {
        return { actorId: record.actorId, fingerprint };
      }
    }
  }
  return null;
}

function effectiveSum(account: SettlementAccountWithRecords, kind: 'PAYMENT' | 'CREDIT' | 'REFUND') {
  const reversed = new Set(account.records.flatMap((record) => record.reversalOfId ? [record.reversalOfId] : []));
  return account.records
    .filter((record) => record.kind === kind && !reversed.has(record.id) && record.amount !== null)
    .reduce((total, record) => total.plus(record.amount!), decimal(0));
}

async function state(ids: string[]) {
  const accounts = await db.settlementAccount.findMany({
    where: { id: { in: ids } },
    orderBy: { id: 'asc' },
    include: { records: { orderBy: { accountVersion: 'asc' } } },
  });
  return accounts.map((account) => ({
    id: account.id,
    version: account.version,
    dueDate: account.dueDate.toISOString(),
    initialAmount: account.initialAmount.toFixed(4),
    records: account.records.map((record) => ({
      id: record.id,
      accountVersion: record.accountVersion,
      kind: record.kind,
      amount: record.amount?.toFixed(4) ?? null,
      reversalOfId: record.reversalOfId,
    })),
    amounts: {
      payment: effectiveSum(account, 'PAYMENT').toFixed(4),
      credit: effectiveSum(account, 'CREDIT').toFixed(4),
      refund: effectiveSum(account, 'REFUND').toFixed(4),
    },
  }));
}

type RawRecord = {
  accountId: string;
  accountVersion: number;
  kind: 'PAYMENT' | 'CREDIT' | 'REFUND' | 'REVERSAL' | 'TERMS';
  amount: Prisma.Decimal.Value | null;
  dueDate: Date | null;
  reversalOfId?: string | null;
  actorId: string;
  evidence: unknown;
  label: string;
};

async function insertRecord(tx: Prisma.TransactionClient, input: RawRecord) {
  const id = randomUUID();
  const evidenceJson = JSON.stringify(input.evidence);
  const amount = input.amount === 'NaN'
    ? Prisma.sql`CAST('NaN' AS numeric)`
    : input.amount === null
      ? Prisma.sql`NULL`
      : Prisma.sql`CAST(${String(input.amount)} AS numeric)`;
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "settlement_records"
      ("id", "accountId", "kind", "accountVersion", "amount", "dueDate", "occurredAt",
       "externalSystem", "voucherNumber", "voucherLine", "reason", "evidence", "reversalOfId",
       "actorId", "commandId", "requestHash")
    VALUES (
      ${id}, ${input.accountId}, CAST(${input.kind} AS "SettlementRecordKind"), ${input.accountVersion},
      ${amount}, ${input.dueDate}, ${new Date(Date.now() - 1000)},
      ${'DB-GUARD'}, ${`${tag}-${input.label}`}, ${'1'}, ${`Database guard ${input.label}`},
      ${evidenceJson}::jsonb, ${input.reversalOfId ?? null}, ${input.actorId},
      ${randomUUID()}, ${sha256(`${tag}:${input.label}`)}
    )
  `);
}

async function expectRejected(
  label: string,
  ids: string[],
  expected: { postgresCode: string; message: RegExp },
  run: (tx: Prisma.TransactionClient) => Promise<void>,
) {
  const before = await state(ids);
  let error: unknown;
  let constraintsReached = false;
  const unexpectedCommit = new Error(`${label} unexpectedly passed its database guard`);
  try {
    await db.$transaction(async (tx) => {
      await run(tx);
      constraintsReached = true;
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      // A successful guard check would otherwise commit the deliberately
      // invalid fixture before the assertion below can run.  Force the
      // transaction to roll back and keep the failure visible to this test.
      throw unexpectedCommit;
    });
  } catch (caught) {
    error = caught;
  }
  assert.notEqual(error, unexpectedCommit, `${label} was not rejected by a database constraint`);
  assert(error, `${label} unexpectedly committed`);
  const failure = databaseFailure(error);
  assert.equal(failure.postgresCode, expected.postgresCode, `${label} did not return the expected PostgreSQL SQLSTATE`);
  assert.match(failure.postgresMessage, expected.message, `${label} error did not identify the intended guard`);
  const after = await state(ids);
  assert.deepEqual(after, before, `${label} changed account state despite rollback`);
  failureDetails.push({ label, ...failure });
  checks.push(`${label}${constraintsReached ? ' (deferred constraints)' : ' (statement constraint)'}`);
}

const pgCheckViolation = (message: RegExp) => ({ postgresCode: '23514', message });

try {
  const preferred = await loadAccount(preferredAccountId);
  const candidates = preferred && preferred.records.some((record) => record.kind === 'PAYMENT')
    ? [preferred]
    : await db.settlementAccount.findMany({
      where: { records: { some: { kind: 'PAYMENT' } } },
      orderBy: { updatedAt: 'desc' },
      include: { records: { orderBy: { accountVersion: 'asc' } } },
    });
  let target: SettlementAccountWithRecords | undefined;
  let targetEvidence: { actorId: string; fingerprint: EvidenceFingerprint } | null = null;
  for (const candidate of candidates) {
    const evidence = await usableEvidence(candidate);
    if (evidence) {
      target = candidate;
      targetEvidence = evidence;
      break;
    }
  }
  assert(target && targetEvidence, 'Need an AR settlement account with a PAYMENT and current actor-owned evidence');

  const otherCandidates = await db.settlementAccount.findMany({
    // The cross-account reversal guard only needs a second account with a
    // current, actor-owned proof.  Requiring that account to already have a
    // PAYMENT would make this check depend on an AR-only fixture even though
    // the target payment is deliberately from the first account.
    where: { id: { not: target.id } },
    orderBy: { updatedAt: 'desc' },
    include: { records: { orderBy: { accountVersion: 'asc' } } },
  });
  let other: SettlementAccountWithRecords | undefined;
  let otherEvidence: { actorId: string; fingerprint: EvidenceFingerprint } | null = null;
  for (const candidate of otherCandidates) {
    const evidence = await usableEvidence(candidate);
    if (evidence) {
      other = candidate;
      otherEvidence = evidence;
      break;
    }
  }
  assert(other && otherEvidence, 'Need a second settlement account with current evidence for cross-account reversal');
  const ids = [target.id, other.id];
  const targetPayment = target.records.find((record) => record.kind === 'PAYMENT');
  assert(targetPayment && targetPayment.amount, 'Target account must contain a PAYMENT amount');
  const otherActor = await db.user.findFirst({ where: { id: { not: targetEvidence.actorId } }, select: { id: true } });
  assert(otherActor, 'Need a second user for the wrong-actor evidence case');

  const validEvidence = targetEvidence.fingerprint;
  const nextVersion = target.version + 1;
  const base = (label: string, overrides: Partial<RawRecord> = {}): RawRecord => ({
    accountId: target.id,
    accountVersion: nextVersion,
    kind: 'PAYMENT',
    amount: '0.0100',
    dueDate: null,
    actorId: targetEvidence!.actorId,
    evidence: [validEvidence],
    label,
    ...overrides,
  });

  await expectRejected('cash amount NULL', ids, pgCheckViolation(/settlement_records_values_check|amount/i),
    async (tx) => insertRecord(tx, base('null-amount', { amount: null })));

  await expectRejected('cash amount NaN', ids, pgCheckViolation(/settlement_records_values_check|NaN|amount/i),
    async (tx) => insertRecord(tx, base('nan-amount', { amount: 'NaN' })));

  await expectRejected('empty evidence', ids, pgCheckViolation(/evidence|settlement_records_values_check/i),
    async (tx) => insertRecord(tx, base('empty-evidence', { evidence: [] })));

  await expectRejected('blank voucher reference', ids, pgCheckViolation(/settlement_records_values_check|voucher/i),
    async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "settlement_records"
          ("id", "accountId", "kind", "accountVersion", "amount", "dueDate", "occurredAt",
           "externalSystem", "voucherNumber", "voucherLine", "reason", "evidence", "actorId", "commandId", "requestHash")
        VALUES (${randomUUID()}, ${target!.id}, CAST('PAYMENT' AS "SettlementRecordKind"), ${nextVersion},
          CAST(${ '0.0100' } AS numeric), NULL, ${new Date(Date.now() - 1000)}, ${'DB-GUARD'}, ${`${tag}-blank-voucher`}, ${''},
          ${'Database guard blank voucher'}, ${JSON.stringify([validEvidence])}::jsonb, ${targetEvidence!.actorId},
          ${randomUUID()}, ${sha256(`${tag}:blank-voucher`)})
      `);
    });

  await expectRejected('evidence missing status fingerprint', ids, pgCheckViolation(/evidence|status|fingerprint/i),
    async (tx) => insertRecord(tx, base('missing-status', { evidence: [{ id: validEvidence.id, version: validEvidence.version, sha256: validEvidence.sha256 }] })));

  await expectRejected('evidence wrong version', ids, pgCheckViolation(/evidence|stale|version|unavailable/i),
    async (tx) => insertRecord(tx, base('wrong-version', { evidence: [{ ...validEvidence, version: validEvidence.version + 1 }] })));

  await expectRejected('evidence wrong actor', ids, pgCheckViolation(/evidence|unowned|actor|account/i),
    async (tx) => insertRecord(tx, base('wrong-actor', { actorId: otherActor!.id })));

  await expectRejected('cross-account reversal', ids, pgCheckViolation(/reversal|same account/i),
    async (tx) => insertRecord(tx, {
      accountId: other!.id,
      accountVersion: other!.version + 1,
      kind: 'REVERSAL',
      amount: targetPayment.amount,
      dueDate: null,
      reversalOfId: targetPayment.id,
      actorId: otherEvidence!.actorId,
      evidence: [otherEvidence!.fingerprint],
      label: 'cross-account-reversal',
    }));

  const overCredit = decimal(target.initialAmount).plus('0.0100').toFixed(4);
  await expectRejected('credit exceeds initial amount', ids,
    pgCheckViolation(/Effective credits exceed settlement initial amount/),
    async (tx) => {
      await tx.settlementAccount.update({ where: { id: target!.id }, data: { version: { increment: 1 } } });
      await insertRecord(tx, base('over-credit', { kind: 'CREDIT', amount: overCredit }));
    });

  const effectivePayments = effectiveSum(target, 'PAYMENT');
  const overRefund = effectivePayments.plus('0.0100').toFixed(4);
  await expectRejected('refund exceeds effective payments', ids,
    pgCheckViolation(/Effective refunds exceed effective payments/),
    async (tx) => {
      await tx.settlementAccount.update({ where: { id: target!.id }, data: { version: { increment: 1 } } });
      await insertRecord(tx, base('over-refund', { kind: 'REFUND', amount: overRefund }));
    });

  await expectRejected('dueDate projection tamper', ids,
    pgCheckViolation(/Settlement account dueDate must match the latest OPEN or TERMS record/),
    async (tx) => {
      await tx.settlementAccount.update({ where: { id: target!.id }, data: { dueDate: new Date('2099-01-01T00:00:00.000Z') } });
    });

  const final = await state(ids);
  assert(final.every((account) => account.records.length > 0 && account.version === account.records.length));
  console.log(JSON.stringify({
    success: true,
    tag,
    database: databaseUrl.pathname.slice(1),
    targetAccountId: target.id,
    preferredAccountUsed: target.id === preferredAccountId,
    otherAccountId: other.id,
    checks,
    failureDetails,
    final,
  }, null, 2));
} finally {
  await db.$disconnect();
}
