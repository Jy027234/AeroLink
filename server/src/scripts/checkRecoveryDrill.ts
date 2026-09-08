import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

type CommandResult = {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
};

type FileEntry = {
  objectKey: string;
  sizeBytes: number;
  sha256: string;
};

type FileManifest = {
  entries: FileEntry[];
  fileCount: number;
  totalBytes: number;
  manifestSha256: string;
};

type DrillOptions = {
  container: string;
  user: string;
  adminDatabase: string;
  drillDatabase: string;
  restoreDatabase: string;
  runId: string;
  workDir: string;
  keep: boolean;
  serverDir: string;
};

type ContainerInfo = {
  image: string;
  version: string;
  hostPort: number;
  password: string;
};

type AppIds = {
  user: string;
  customer: string;
  supplier: string;
  inventoryItem: string;
  inventoryDetail: string;
  rfq: string;
  supplierQuote: string;
  quotation: string;
  approval: string;
  order: string;
  inventoryTransaction: string;
  storedObjects: string[];
};

type ReconciliationResult = {
  status?: string;
  [key: string]: unknown;
};

type ApplicationSnapshot = {
  migrationCount: number;
  users: Array<Record<string, unknown>>;
  customers: Array<Record<string, unknown>>;
  suppliers: Array<Record<string, unknown>>;
  inventory: Array<Record<string, unknown>>;
  inventoryItems: Array<Record<string, unknown>>;
  inventoryDetails: Array<Record<string, unknown>>;
  inventoryTransactions: Array<Record<string, unknown>>;
  rfqs: Array<Record<string, unknown>>;
  supplierQuotes: Array<Record<string, unknown>>;
  quotations: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  orders: Array<Record<string, unknown>>;
  storedObjects: Array<Record<string, unknown>>;
  inventoryReconciliation: ReconciliationResult;
  moneyReconciliation: ReconciliationResult;
};

const FIXTURE_CONTENT = [
  {
    name: 'inspection.txt',
    mimeType: 'text/plain',
    content: 'D09 synthetic inspection evidence for a PostgreSQL recovery drill.\n',
  },
  {
    name: 'quote.txt',
    mimeType: 'text/plain',
    content: 'D09 synthetic quotation attachment for a PostgreSQL recovery drill.\n',
  },
] as const;

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function runCommand(
  command: string,
  args: string[],
  input?: Buffer | string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      cwd: options.cwd,
      env: options.env,
      shell: options.shell,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    }));

    if (input === undefined) child.stdin.end();
    else child.stdin.end(typeof input === 'string' ? Buffer.from(input) : input);
  });
}

async function runDocker(options: DrillOptions, args: string[], input?: Buffer | string): Promise<Buffer> {
  const result = await runCommand('docker', args, input);
  if (result.code !== 0) {
    const details = result.stderr.toString('utf8').trim();
    throw new Error(`docker ${args.join(' ')} failed${details ? `: ${details}` : ''}`);
  }
  return result.stdout;
}

async function psql(options: DrillOptions, database: string, sql: string, input?: string): Promise<Buffer> {
  const args = [
    'exec', '-i', options.container,
    'psql', '-X', '-v', 'ON_ERROR_STOP=1',
    '-U', options.user,
    '-d', database,
  ];
  if (input === undefined) args.push('-At', '-c', sql);
  else args.push('-f', '-');
  return runDocker(options, args, input);
}

async function pgDump(options: DrillOptions, database: string): Promise<Buffer> {
  return runDocker(options, [
    'exec', '-i', options.container,
    'pg_dump', '--format=custom', '--no-owner', '--no-acl',
    '-U', options.user,
    '-d', database,
  ]);
}

async function pgRestore(options: DrillOptions, database: string, dump: Buffer): Promise<void> {
  await runDocker(options, [
    'exec', '-i', options.container,
    'pg_restore', '--exit-on-error', '--no-owner', '--no-acl',
    '-U', options.user,
    '-d', database,
  ], dump);
}

function parseOptions(): DrillOptions {
  const container = process.env.D09_PG_CONTAINER?.trim();
  if (!container) {
    throw new Error('D09_PG_CONTAINER is required; choose an isolated postgres:16 test container');
  }
  if (!/(review|test|drill|recovery)/i.test(container)) {
    throw new Error('D09_PG_CONTAINER must identify an isolated review/test/drill container');
  }

  const user = process.env.D09_PG_USER?.trim() || 'aerolink_test';
  const adminDatabase = process.env.D09_PG_ADMIN_DB?.trim() || 'aerolink_review';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(user)) throw new Error('D09_PG_USER contains invalid characters');
  if (!/^(aerolink_review|aerolink_recovery_admin_[a-z0-9_]+)$/.test(adminDatabase)) {
    throw new Error('D09_PG_ADMIN_DB must be the isolated review database or an aerolink_recovery_admin_* database');
  }

  const runId = `${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`;
  const workDir = path.resolve(
    process.env.D09_WORK_DIR?.trim() || path.join(os.tmpdir(), `aerolink-d09-recovery-${runId}`),
  );
  const serverDir = locateServerDir();
  const repoRoot = path.dirname(serverDir);
  if (isPathInside(repoRoot, workDir)) {
    throw new Error('D09_WORK_DIR must be outside the repository');
  }

  return {
    container,
    user,
    adminDatabase,
    drillDatabase: `aerolink_recovery_drill_${runId}`,
    restoreDatabase: `aerolink_recovery_restore_${runId}`,
    runId,
    workDir,
    keep: process.env.D09_KEEP === 'true',
    serverDir,
  };
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function locateServerDir(): string {
  const cwd = path.resolve(process.cwd());
  const candidates = [cwd, path.join(cwd, 'server')];
  const serverDir = candidates.find((candidate) => (
    fsSync.existsSync(path.join(candidate, 'package.json'))
    && fsSync.existsSync(path.join(candidate, 'prisma', 'schema.prisma'))
  ));
  if (!serverDir) throw new Error('D09 must run from the repository or server directory containing prisma/schema.prisma');
  return serverDir;
}

function databaseUrl(info: ContainerInfo, options: DrillOptions, database: string): string {
  return `postgresql://${encodeURIComponent(options.user)}:${encodeURIComponent(info.password)}`
    + `@127.0.0.1:${info.hostPort}/${database}?schema=public`;
}

function commandSummary(result: CommandResult): string {
  const output = `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`.trim();
  return output.length > 2000 ? output.slice(-2000) : output;
}

async function runPrisma(
  options: DrillOptions,
  args: string[],
  url: string,
): Promise<CommandResult> {
  const result = await runCommand(
    process.execPath,
    [path.join(options.serverDir, 'node_modules', 'prisma', 'build', 'index.js'), ...args],
    undefined,
    {
      cwd: options.serverDir,
      env: { ...process.env, DATABASE_URL: url },
    },
  );
  if (result.code !== 0) {
    const details = commandSummary(result);
    throw new Error(`prisma ${args.join(' ')} failed${details ? `: ${details}` : ''}`);
  }
  return result;
}

async function inspectContainer(options: DrillOptions): Promise<ContainerInfo> {
  const image = (await runDocker(options, [
    'inspect', '--format', '{{.Config.Image}}', options.container,
  ])).toString('utf8').trim();
  if (!/^postgres:16(?:[-.:].*)?$/.test(image)) {
    throw new Error(`D09 requires a postgres:16 container; got ${image || 'unknown image'}`);
  }

  const portsJson = (await runDocker(options, [
    'inspect', '--format', '{{json .NetworkSettings.Ports}}', options.container,
  ])).toString('utf8').trim();
  const ports = JSON.parse(portsJson) as Record<string, Array<{ HostPort?: string }> | null>;
  const hostPortValue = ports['5432/tcp']?.[0]?.HostPort;
  const hostPort = Number(hostPortValue);
  if (!Number.isInteger(hostPort) || hostPort <= 0) {
    throw new Error('D09 requires the isolated PostgreSQL container to expose port 5432 to localhost for Prisma verification');
  }

  const envJson = (await runDocker(options, [
    'inspect', '--format', '{{json .Config.Env}}', options.container,
  ])).toString('utf8').trim();
  const env = JSON.parse(envJson) as string[];
  const password = process.env.D09_PG_PASSWORD?.trim()
    || env.find((entry) => entry.startsWith('POSTGRES_PASSWORD='))?.slice('POSTGRES_PASSWORD='.length)
    || '';
  if (!password) {
    throw new Error('D09_PG_PASSWORD is required when the isolated PostgreSQL container does not expose POSTGRES_PASSWORD');
  }

  const version = (await psql(options, options.adminDatabase, 'SELECT version();')).toString('utf8').trim();
  if (!/^PostgreSQL 16\./.test(version)) throw new Error(`D09 requires PostgreSQL 16; got ${version}`);
  return { image, version, hostPort, password };
}

export async function claimOwnedWorkDir(workDir: string): Promise<void> {
  try {
    await fs.mkdir(workDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`D09_WORK_DIR must be a new directory; refusing to reuse or remove ${workDir}`);
    }
    throw error;
  }
}

function assertOwnedPath(workDir: string, candidate: string): void {
  if (!isPathInside(workDir, candidate) || path.resolve(workDir) === path.resolve(candidate)) {
    throw new Error(`D09 path escapes the owned work directory: ${candidate}`);
  }
}

async function listFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const result: string[] = [];
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(rootDir, fullPath));
    else if (entry.isFile()) result.push(fullPath);
  }
  return result;
}

async function buildFileManifest(rootDir: string): Promise<FileManifest> {
  const files = await listFiles(rootDir);
  const entries: FileEntry[] = [];
  for (const filePath of files) {
    const content = await fs.readFile(filePath);
    const objectKey = path.relative(rootDir, filePath).split(path.sep).join('/');
    entries.push({ objectKey, sizeBytes: content.byteLength, sha256: sha256(content) });
  }
  entries.sort((left, right) => left.objectKey.localeCompare(right.objectKey));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  return {
    entries,
    fileCount: entries.length,
    totalBytes,
    manifestSha256: sha256(JSON.stringify(entries)),
  };
}

async function writeFixtures(rootDir: string, runId: string): Promise<Array<{ objectKey: string; mimeType: string }>> {
  const fixtures = FIXTURE_CONTENT.map((fixture) => ({
    ...fixture,
    objectKey: `attachments/${runId}/${fixture.name}`,
  }));
  for (const fixture of fixtures) {
    const fixturePath = path.join(rootDir, ...fixture.objectKey.split('/'));
    await fs.mkdir(path.dirname(fixturePath), { recursive: true });
    await fs.writeFile(fixturePath, fixture.content, 'utf8');
  }
  return fixtures.map(({ objectKey, mimeType }) => ({ objectKey, mimeType }));
}

function idsFor(runId: string): AppIds {
  const prefix = `d09-${runId}`;
  return {
    user: `${prefix}-user`,
    customer: `${prefix}-customer`,
    supplier: `${prefix}-supplier`,
    inventoryItem: `${prefix}-inventory-item`,
    inventoryDetail: `${prefix}-inventory-detail`,
    rfq: `${prefix}-rfq`,
    supplierQuote: `${prefix}-supplier-quote`,
    quotation: `${prefix}-quotation`,
    approval: `${prefix}-approval`,
    order: `${prefix}-order`,
    inventoryTransaction: `${prefix}-inventory-transaction`,
    storedObjects: [`${prefix}-stored-object-inspection`, `${prefix}-stored-object-quote`],
  };
}

async function seedApplicationData(
  prisma: any,
  options: DrillOptions,
  ids: AppIds,
  fileEntries: FileEntry[],
  fixtureMetadata: Array<{ objectKey: string; mimeType: string }>,
): Promise<void> {
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  const requiredDate = new Date('2030-01-01T00:00:00.000Z');
  const quoteAmount = '401.0000';
  const userEmail = `d09-${options.runId}-operator@example.invalid`;
  const customerEmail = `d09-${options.runId}-customer@example.invalid`;
  const supplierEmail = `d09-${options.runId}-supplier@example.invalid`;

  await prisma.user.create({
    data: {
      id: ids.user,
      email: userEmail,
      name: 'D09 Synthetic Operator',
      password: 'd09-synthetic-password-hash',
      role: 'ADMIN',
      department: 'recovery-drill',
      isActive: true,
      createdAt,
      updatedAt: createdAt,
    },
  });
  await prisma.customer.create({
    data: {
      id: ids.customer,
      name: 'D09 Synthetic Customer',
      contactName: 'D09 Synthetic Contact',
      email: customerEmail,
      phone: '+1-202-555-0109',
      status: 'ACTIVE',
      createdAt,
      updatedAt: createdAt,
    },
  });
  await prisma.supplier.create({
    data: {
      id: ids.supplier,
      name: 'D09 Synthetic Supplier',
      contactName: 'D09 Synthetic Supplier Contact',
      email: supplierEmail,
      phone: '+1-202-555-0110',
      status: 'active',
      createdAt,
      updatedAt: createdAt,
    },
  });
  await prisma.inventoryItem.create({
    data: {
      id: ids.inventoryItem,
      partNumber: `D09-SYNTH-${options.runId}`,
      description: 'D09 synthetic aircraft part',
      partCategory: 'CONSUMABLE',
      trackingType: 'BATCH',
      unitOfMeasure: 'EA',
      manufacturer: 'D09 Synthetic OEM',
      createdAt,
      updatedAt: createdAt,
    },
  });
  await prisma.inventoryDetail.create({
    data: {
      id: ids.inventoryDetail,
      inventoryItem: { connect: { id: ids.inventoryItem } },
      supplier: { connect: { id: ids.supplier } },
      batchNumber: `D09-BATCH-${options.runId}`,
      quantity: 3,
      conditionCode: 'NE',
      status: 'AVAILABLE',
      location: 'D09-TEST-WAREHOUSE',
      warehouse: 'D09-TEST',
      shelf: 'D09-A1',
      certificateType: 'NONE',
      unitCost: 125.5,
      type: 'OWN',
      createdAt,
      updatedAt: createdAt,
    },
  });
  // The legacy row is intentionally paired by id with the canonical detail.
  // Its frozen quantity is 2; the +1 ledger event below explains the live 3.
  await prisma.inventory.create({
    data: {
      id: ids.inventoryDetail,
      partNumber: `D09-SYNTH-${options.runId}`,
      description: 'D09 synthetic aircraft part legacy snapshot',
      quantity: 2,
      location: 'D09-TEST-WAREHOUSE',
      unitCost: 125.5,
      supplier: { connect: { id: ids.supplier } },
      createdAt,
      updatedAt: createdAt,
    },
  });
  await prisma.rFQ.create({
    data: {
      id: ids.rfq,
      rfqNumber: `RFQ-D09-${options.runId}`,
      customer: { connect: { id: ids.customer } },
      creator: { connect: { id: ids.user } },
      partNumber: `D09-SYNTH-${options.runId}`,
      quantity: 2,
      uom: 'EA',
      conditionCode: 'NE',
      description: 'D09 synthetic recovery drill RFQ',
      certificateRequired: true,
      requiredDate,
      urgency: 'STANDARD',
      status: 'ORDERED',
      createdAt,
    },
  });
  await prisma.supplierQuote.create({
    data: {
      id: ids.supplierQuote,
      rfq: { connect: { id: ids.rfq } },
      supplier: { connect: { id: ids.supplier } },
      partNumber: `D09-SYNTH-${options.runId}`,
      description: 'D09 synthetic supplier quote',
      quantity: 2,
      unitPrice: 200.5,
      totalPrice: 401,
      unitPriceDecimal: '200.5000',
      totalPriceDecimal: quoteAmount,
      leadTimeDays: 5,
      validUntil: requiredDate,
      status: 'accepted',
      isWinner: true,
      createdAt,
      updatedAt: createdAt,
    },
  });
  await prisma.quotation.create({
    data: {
      id: ids.quotation,
      quoteNumber: `QUO-D09-${options.runId}`,
      rfq: { connect: { id: ids.rfq } },
      customer: { connect: { id: ids.customer } },
      creator: { connect: { id: ids.user } },
      approver: { connect: { id: ids.user } },
      partNumber: `D09-SYNTH-${options.runId}`,
      quantity: 2,
      unitPrice: 200.5,
      totalPrice: 401,
      costPrice: 251,
      margin: 150,
      unitPriceDecimal: '200.5000',
      totalPriceDecimal: quoteAmount,
      costPriceDecimal: '251.0000',
      status: 'APPROVED',
      approvedAt: createdAt,
      expiryDate: requiredDate,
      createdAt,
    },
  });
  await prisma.approval.create({
    data: {
      id: ids.approval,
      quotation: { connect: { id: ids.quotation } },
      approver: { connect: { id: ids.user } },
      level: 'ADMIN',
      requiredLevel: 'ADMIN',
      policyVersion: 'D09-synthetic-policy',
      reviewedVersion: 1,
      snapshotJson: JSON.stringify({ synthetic: true, totalPrice: quoteAmount }),
      action: 'APPROVE',
      comment: 'D09 synthetic approval record',
      createdAt,
    },
  });
  await prisma.order.create({
    data: {
      id: ids.order,
      orderNumber: `ORD-D09-${options.runId}`,
      soNumber: `SO-D09-${options.runId}`,
      quotation: { connect: { id: ids.quotation } },
      customer: { connect: { id: ids.customer } },
      partNumber: `D09-SYNTH-${options.runId}`,
      quantity: 2,
      totalAmount: 401,
      totalAmountDecimal: quoteAmount,
      status: 'SO_CREATED',
      createdAt,
      deliveryDate: requiredDate,
      certificateRequired: true,
      outboundQuantity: 0,
      outboundStatus: 'PENDING',
    },
  });
  await prisma.inventoryTransaction.create({
    data: {
      id: ids.inventoryTransaction,
      inventoryDetail: { connect: { id: ids.inventoryDetail } },
      order: { connect: { id: ids.order } },
      quotationId: ids.quotation,
      type: 'ADJUSTMENT',
      quantity: 1,
      beforeQuantity: 2,
      afterQuantity: 3,
      referenceNo: `ORD-D09-${options.runId}`,
      referenceType: 'ORDER',
      notes: 'D09 synthetic ledger adjustment',
      createdBy: ids.user,
      createdAt,
    },
  });
  for (const [index, fileEntry] of fileEntries.entries()) {
    const fixture = fixtureMetadata.find((item) => item.objectKey === fileEntry.objectKey);
    if (!fixture) throw new Error(`Missing metadata for fixture ${fileEntry.objectKey}`);
    await prisma.storedObject.create({
      data: {
        id: ids.storedObjects[index],
        objectKey: fileEntry.objectKey,
        version: 1,
        sha256: fileEntry.sha256,
        sizeBytes: fileEntry.sizeBytes,
        mimeType: fixture.mimeType,
        originalName: path.posix.basename(fileEntry.objectKey),
        domain: 'recovery-drill',
        resourceId: ids.order,
        ownerId: ids.user,
        status: 'AVAILABLE',
        metadata: { synthetic: true, runId: options.runId },
        createdAt,
        updatedAt: createdAt,
      },
    });
  }
}

function decimalText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asNumber(value: unknown): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`Expected a numeric database value, got ${String(value)}`);
  return result;
}

async function readApplicationSnapshot(
  prisma: any,
  ids: AppIds,
  reconcileInventory: (legacy: any[], canonical: any[], transactional: string[]) => any,
  reconcileMoney: (records: any[]) => any,
): Promise<ApplicationSnapshot> {
  const [
    users,
    customers,
    suppliers,
    inventory,
    inventoryItems,
    inventoryDetails,
    inventoryTransactions,
    rfqs,
    supplierQuotes,
    quotations,
    approvals,
    orders,
    storedObjects,
    migrationRows,
  ] = await Promise.all([
    prisma.user.findMany({ where: { id: ids.user }, select: { id: true, email: true, role: true, isActive: true } }),
    prisma.customer.findMany({ where: { id: ids.customer }, select: { id: true, name: true, email: true, status: true } }),
    prisma.supplier.findMany({ where: { id: ids.supplier }, select: { id: true, name: true, email: true, status: true } }),
    prisma.inventory.findMany({ where: { id: ids.inventoryDetail }, select: { id: true, partNumber: true, quantity: true, unitCost: true } }),
    prisma.inventoryItem.findMany({ where: { id: ids.inventoryItem }, select: { id: true, partNumber: true, description: true, unitOfMeasure: true } }),
    prisma.inventoryDetail.findMany({ where: { id: ids.inventoryDetail }, select: { id: true, inventoryItemId: true, quantity: true, unitCost: true, status: true } }),
    prisma.inventoryTransaction.findMany({ where: { id: ids.inventoryTransaction }, select: { id: true, inventoryDetailId: true, orderId: true, quotationId: true, type: true, quantity: true, beforeQuantity: true, afterQuantity: true } }),
    prisma.rFQ.findMany({ where: { id: ids.rfq }, select: { id: true, rfqNumber: true, customerId: true, createdBy: true, partNumber: true, quantity: true, status: true } }),
    prisma.supplierQuote.findMany({ where: { id: ids.supplierQuote }, select: { id: true, rfqId: true, supplierId: true, partNumber: true, quantity: true, unitPrice: true, totalPrice: true, unitPriceDecimal: true, totalPriceDecimal: true, status: true, isWinner: true } }),
    prisma.quotation.findMany({ where: { id: ids.quotation }, select: { id: true, quoteNumber: true, rfqId: true, customerId: true, createdBy: true, approvedBy: true, partNumber: true, quantity: true, unitPrice: true, totalPrice: true, costPrice: true, unitPriceDecimal: true, totalPriceDecimal: true, costPriceDecimal: true, status: true } }),
    prisma.approval.findMany({ where: { id: ids.approval }, select: { id: true, quotationId: true, approverId: true, level: true, action: true, reviewedVersion: true } }),
    prisma.order.findMany({ where: { id: ids.order }, select: { id: true, orderNumber: true, soNumber: true, quotationId: true, customerId: true, partNumber: true, quantity: true, totalAmount: true, totalAmountDecimal: true, status: true } }),
    prisma.storedObject.findMany({ where: { domain: 'recovery-drill', resourceId: ids.order }, orderBy: { objectKey: 'asc' }, select: { id: true, objectKey: true, version: true, sha256: true, sizeBytes: true, mimeType: true, originalName: true, domain: true, resourceId: true, ownerId: true, status: true, metadata: true } }),
    prisma.$queryRawUnsafe('SELECT COUNT(*)::int AS count FROM "_prisma_migrations"'),
  ]);

  const migrationCount = asNumber(migrationRows[0]?.count);
  const normalizedSupplierQuotes = supplierQuotes.map((row: any) => ({
    id: row.id,
    rfqId: row.rfqId,
    supplierId: row.supplierId,
    partNumber: row.partNumber,
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    totalPrice: row.totalPrice,
    unitPriceDecimal: decimalText(row.unitPriceDecimal),
    totalPriceDecimal: decimalText(row.totalPriceDecimal),
    status: row.status,
    isWinner: row.isWinner,
  }));
  const normalizedQuotations = quotations.map((row: any) => ({
    id: row.id,
    quoteNumber: row.quoteNumber,
    rfqId: row.rfqId,
    customerId: row.customerId,
    createdBy: row.createdBy,
    approvedBy: row.approvedBy,
    partNumber: row.partNumber,
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    totalPrice: row.totalPrice,
    costPrice: row.costPrice,
    unitPriceDecimal: decimalText(row.unitPriceDecimal),
    totalPriceDecimal: decimalText(row.totalPriceDecimal),
    costPriceDecimal: decimalText(row.costPriceDecimal),
    status: row.status,
  }));
  const normalizedOrders = orders.map((row: any) => ({
    id: row.id,
    orderNumber: row.orderNumber,
    soNumber: row.soNumber,
    quotationId: row.quotationId,
    customerId: row.customerId,
    partNumber: row.partNumber,
    quantity: row.quantity,
    totalAmount: row.totalAmount,
    totalAmountDecimal: decimalText(row.totalAmountDecimal),
    status: row.status,
  }));

  const inventoryReconciliationRaw = reconcileInventory(
    inventory.map((row: any) => ({ id: row.id, partNumber: row.partNumber, quantity: row.quantity })),
    inventoryDetails.map((row: any) => ({ id: row.id, partNumber: inventoryItems.find((item: any) => item.id === row.inventoryItemId)?.partNumber || '', quantity: row.quantity })),
    inventoryTransactions.map((row: any) => row.inventoryDetailId),
  );
  const inventoryReconciliation: ReconciliationResult = {
    ...inventoryReconciliationRaw,
    status: Array.isArray(inventoryReconciliationRaw.mismatches) && inventoryReconciliationRaw.mismatches.length === 0
      ? 'PASS'
      : 'FAIL',
  };
  const moneyReconciliation = reconcileMoney([
    ...normalizedSupplierQuotes.map((row: any) => ({
      entity: 'supplierQuote',
      id: row.id,
      fields: [
        { name: 'unitPrice', legacyValue: row.unitPrice, decimalValue: row.unitPriceDecimal },
        { name: 'totalPrice', legacyValue: row.totalPrice, decimalValue: row.totalPriceDecimal },
      ],
    })),
    ...normalizedQuotations.map((row: any) => ({
      entity: 'quotation',
      id: row.id,
      fields: [
        { name: 'unitPrice', legacyValue: row.unitPrice, decimalValue: row.unitPriceDecimal },
        { name: 'totalPrice', legacyValue: row.totalPrice, decimalValue: row.totalPriceDecimal },
        { name: 'costPrice', legacyValue: row.costPrice, decimalValue: row.costPriceDecimal },
      ],
    })),
    ...normalizedOrders.map((row: any) => ({
      entity: 'order',
      id: row.id,
      fields: [
        { name: 'totalAmount', legacyValue: row.totalAmount, decimalValue: row.totalAmountDecimal },
      ],
    })),
  ]);

  return {
    migrationCount,
    users,
    customers,
    suppliers,
    inventory,
    inventoryItems,
    inventoryDetails,
    inventoryTransactions,
    rfqs,
    supplierQuotes: normalizedSupplierQuotes,
    quotations: normalizedQuotations,
    approvals,
    orders: normalizedOrders,
    storedObjects,
    inventoryReconciliation,
    moneyReconciliation,
  };
}

function storedObjectManifest(rows: Array<Record<string, unknown>>): FileEntry[] {
  return rows
    .map((row) => ({
      objectKey: String(row.objectKey),
      sizeBytes: asNumber(row.sizeBytes),
      sha256: String(row.sha256),
    }))
    .sort((left, right) => left.objectKey.localeCompare(right.objectKey));
}

async function createDatabase(options: DrillOptions, database: string): Promise<void> {
  await psql(options, options.adminDatabase, `CREATE DATABASE ${quoteIdentifier(database)};`);
}

async function dropDatabase(options: DrillOptions, database: string): Promise<void> {
  try {
    await psql(options, options.adminDatabase, `DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE);`);
  } catch (error) {
    console.warn(`Could not clean up ${database}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  const options = parseOptions();
  const createdDatabases: string[] = [];
  const sourceDir = path.join(options.workDir, 'source-uploads');
  const backupDir = path.join(options.workDir, 'backup-files');
  const restoredDir = path.join(options.workDir, 'restored-uploads');
  const dumpPath = path.join(options.workDir, 'database.dump');
  const reportPath = path.join(options.workDir, 'recovery-report.json');
  let sourcePrisma: any;
  let restoredPrisma: any;
  let ownedWorkDir = false;

  try {
    await claimOwnedWorkDir(options.workDir);
    ownedWorkDir = true;
    assertOwnedPath(options.workDir, sourceDir);
    assertOwnedPath(options.workDir, backupDir);
    assertOwnedPath(options.workDir, restoredDir);
    assertOwnedPath(options.workDir, dumpPath);
    assertOwnedPath(options.workDir, reportPath);
    const info = await inspectContainer(options);
    const adminUrl = databaseUrl(info, options, options.adminDatabase);
    // The pure reconciliation modules instantiate the shared client on import.
    // Give that client a valid isolated URL, while all reads below use explicit clients.
    process.env.DATABASE_URL = adminUrl;
    const [{ PrismaClient }, { reconcileLegacyInventorySnapshot }, { reconcileMoneyShadows }] = await Promise.all([
      import('@prisma/client'),
      import('../lib/inventoryReconciliation.js'),
      import('../lib/moneyReconciliation.js'),
    ]);

    const sourceUrl = databaseUrl(info, options, options.drillDatabase);
    const restoreUrl = databaseUrl(info, options, options.restoreDatabase);
    await createDatabase(options, options.drillDatabase);
    createdDatabases.push(options.drillDatabase);
    await runPrisma(options, ['migrate', 'deploy', '--schema', 'prisma/schema.prisma'], sourceUrl);
    const sourceMigrationStatus = commandSummary(await runPrisma(
      options,
      ['migrate', 'status', '--schema', 'prisma/schema.prisma'],
      sourceUrl,
    ));

    await fs.mkdir(sourceDir, { recursive: true });
    const fixtureMetadata = await writeFixtures(sourceDir, options.runId);
    const sourceFiles = await buildFileManifest(sourceDir);
    const ids = idsFor(options.runId);

    sourcePrisma = new PrismaClient({ datasources: { db: { url: sourceUrl } } });
    await sourcePrisma.$connect();
    await seedApplicationData(sourcePrisma, options, ids, sourceFiles.entries, fixtureMetadata);
    const sourceDatabase = await readApplicationSnapshot(
      sourcePrisma,
      ids,
      reconcileLegacyInventorySnapshot,
      reconcileMoneyShadows,
    );
    if (sourceDatabase.migrationCount < 1) throw new Error('Source database has no Prisma migration history');
    if (sourceDatabase.inventoryReconciliation.status !== 'PASS') {
      throw new Error('Source inventory reconciliation failed');
    }
    if (sourceDatabase.moneyReconciliation.status !== 'PASS') {
      throw new Error('Source monetary shadow reconciliation failed');
    }
    if (JSON.stringify(storedObjectManifest(sourceDatabase.storedObjects)) !== JSON.stringify(sourceFiles.entries)) {
      throw new Error('Source StoredObject metadata does not match the source file manifest');
    }

    await fs.cp(sourceDir, backupDir, { recursive: true });
    const backupFiles = await buildFileManifest(backupDir);
    if (JSON.stringify(backupFiles) !== JSON.stringify(sourceFiles)) throw new Error('File backup manifest differs from source');

    const dump = await pgDump(options, options.drillDatabase);
    await fs.writeFile(dumpPath, dump, { mode: 0o600 });

    assertOwnedPath(options.workDir, sourceDir);
    await fs.rm(sourceDir, { recursive: true, force: true });
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'tampered-after-backup.txt'), 'This file must not appear after restore.\n', 'utf8');

    await sourcePrisma.$disconnect();
    sourcePrisma = undefined;
    await createDatabase(options, options.restoreDatabase);
    createdDatabases.push(options.restoreDatabase);
    await pgRestore(options, options.restoreDatabase, dump);
    const restoredMigrationStatus = commandSummary(await runPrisma(
      options,
      ['migrate', 'status', '--schema', 'prisma/schema.prisma'],
      restoreUrl,
    ));
    restoredPrisma = new PrismaClient({ datasources: { db: { url: restoreUrl } } });
    await restoredPrisma.$connect();
    const restoredDatabase = await readApplicationSnapshot(
      restoredPrisma,
      ids,
      reconcileLegacyInventorySnapshot,
      reconcileMoneyShadows,
    );
    await fs.cp(backupDir, restoredDir, { recursive: true });
    const restoredFiles = await buildFileManifest(restoredDir);
    const databaseRowsRestored = JSON.stringify(sourceDatabase) === JSON.stringify(restoredDatabase);
    const fileBytesRestored = JSON.stringify(sourceFiles) === JSON.stringify(restoredFiles);
    const attachmentMetadataRestored = JSON.stringify(sourceFiles.entries) === JSON.stringify(storedObjectManifest(restoredDatabase.storedObjects));
    const sourceMutationExcluded = !(await fs.access(path.join(restoredDir, 'tampered-after-backup.txt')).then(() => true).catch(() => false));
    if (!databaseRowsRestored) throw new Error('Restored PostgreSQL application rows differ from the source snapshot');
    if (!fileBytesRestored) throw new Error('Restored file manifest differs from the source snapshot');
    if (!attachmentMetadataRestored) throw new Error('Restored StoredObject metadata differs from the source file manifest');
    if (!sourceMutationExcluded) throw new Error('A file written after backup was present in the restored files');

    const dumpContent = await fs.readFile(dumpPath);
    const report = {
      status: 'PASS',
      runId: options.runId,
      postgres: {
        container: options.container,
        image: info.image,
        version: info.version,
        hostPort: info.hostPort,
        adminDatabase: options.adminDatabase,
      },
      migrations: {
        source: sourceMigrationStatus,
        restored: restoredMigrationStatus,
        sourceCount: sourceDatabase.migrationCount,
        restoredCount: restoredDatabase.migrationCount,
      },
      databases: { source: options.drillDatabase, restored: options.restoreDatabase },
      databaseDump: { path: dumpPath, sizeBytes: dumpContent.byteLength, sha256: sha256(dumpContent) },
      application: { source: sourceDatabase, restored: restoredDatabase },
      files: { source: sourceFiles, backup: backupFiles, restored: restoredFiles },
      checks: {
        productSchemaReadBack: sourceDatabase.users.length === 1
          && sourceDatabase.rfqs.length === 1
          && sourceDatabase.quotations.length === 1
          && sourceDatabase.orders.length === 1,
        migrationHistoryRestored: sourceDatabase.migrationCount === restoredDatabase.migrationCount,
        databaseRowsRestored,
        inventoryReconciliationPassed: sourceDatabase.inventoryReconciliation.status === 'PASS'
          && restoredDatabase.inventoryReconciliation.status === 'PASS',
        moneyReconciliationPassed: sourceDatabase.moneyReconciliation.status === 'PASS'
          && restoredDatabase.moneyReconciliation.status === 'PASS',
        attachmentMetadataRestored,
        fileBytesRestored,
        sourceMutationExcluded,
      },
      generatedAt: new Date().toISOString(),
    };
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({
      ...report,
      reportPath: options.keep ? reportPath : null,
      cleanup: options.keep ? 'retained' : 'databases-and-files-removed',
    }, null, 2)}\n`);
  } finally {
    if (sourcePrisma) await sourcePrisma.$disconnect().catch(() => undefined);
    if (restoredPrisma) await restoredPrisma.$disconnect().catch(() => undefined);
    if (!options.keep && ownedWorkDir) {
      for (const database of createdDatabases.reverse()) await dropDatabase(options, database);
      await fs.rm(options.workDir, { recursive: true, force: true });
    } else if (options.keep && ownedWorkDir) {
      console.log(`D09 drill artifacts kept at ${options.workDir}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}
