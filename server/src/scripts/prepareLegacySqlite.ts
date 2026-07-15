import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type TableInfoRow = {
  name: string;
};

const SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const BACKFILL_SQL_PATH = process.env.BACKFILL_SQL_PATH ?? resolve(process.cwd(), '../deploy/sqlite-legacy-backfill.sql');

if (!SQLITE_DB_PATH) {
  throw new Error('Missing SQLITE_DB_PATH environment variable');
}

const sqliteDbPath = resolve(SQLITE_DB_PATH);
const backfillSqlPath = resolve(BACKFILL_SQL_PATH);

if (!existsSync(sqliteDbPath)) {
  throw new Error(`SQLite database not found: ${sqliteDbPath}`);
}

if (!existsSync(backfillSqlPath)) {
  throw new Error(`Backfill SQL file not found: ${backfillSqlPath}`);
}

const requiredColumns: Array<{ table: string; column: string; definition: string }> = [
  { table: 'customers', column: 'registeredAddress', definition: 'TEXT' },
  { table: 'quotations', column: 'incoterm', definition: 'TEXT' },
  { table: 'quotations', column: 'commonNote', definition: 'TEXT' },
  { table: 'inventory', column: 'conditionCode', definition: "TEXT DEFAULT 'NE'" },
  { table: 'inventory', column: 'certificateType', definition: "TEXT DEFAULT 'NONE'" },
];

const legacySourceColumns: Array<{ table: string; columns: string[] }> = [
  { table: 'customers', columns: ['address'] },
  { table: 'quotations', columns: ['deliveryTerms', 'paymentTerms'] },
  { table: 'inventory', columns: ['status', 'certificateStatus'] },
];

function getColumnNames(db: DatabaseSync, table: string) {
  const escapedTable = table.replace(/'/g, "''");
  const rows = db.prepare(`PRAGMA table_info('${escapedTable}')`).all() as TableInfoRow[];
  return new Set(rows.map((row) => row.name));
}

function ensureRequiredColumns(db: DatabaseSync) {
  for (const item of requiredColumns) {
    const columns = getColumnNames(db, item.table);
    if (columns.has(item.column)) {
      continue;
    }

    db.exec(`ALTER TABLE "${item.table}" ADD COLUMN "${item.column}" ${item.definition}`);
    console.log(`Added column ${item.table}.${item.column}`);
  }
}

function shouldRunBackfill(db: DatabaseSync) {
  const missing: string[] = [];
  let foundAnyLegacyColumn = false;

  for (const item of legacySourceColumns) {
    const columns = getColumnNames(db, item.table);

    for (const column of item.columns) {
      if (columns.has(column)) {
        foundAnyLegacyColumn = true;
      } else {
        missing.push(`${item.table}.${column}`);
      }
    }
  }

  if (!foundAnyLegacyColumn) {
    console.log('No legacy source columns found; skipping backfill SQL');
    return false;
  }

  if (missing.length > 0) {
    throw new Error(`Legacy SQLite schema is partially migrated; missing source columns: ${missing.join(', ')}`);
  }

  return true;
}

function printSummary(db: DatabaseSync) {
  const summary = {
    registeredAddress: db.prepare("select count(*) as c from customers where registeredAddress is not null and trim(registeredAddress) <> ''").get(),
    incoterm: db.prepare("select count(*) as c from quotations where incoterm is not null and trim(incoterm) <> ''").get(),
    commonNote: db.prepare("select count(*) as c from quotations where commonNote is not null and trim(commonNote) <> ''").get(),
    conditionCode: db.prepare("select count(*) as c from inventory where conditionCode is not null and trim(conditionCode) <> ''").get(),
    certificateType: db.prepare("select count(*) as c from inventory where certificateType is not null and trim(certificateType) <> ''").get(),
  };

  console.log(JSON.stringify(summary));
}

function main() {
  console.log(`Preparing SQLite database: ${sqliteDbPath}`);
  const db = new DatabaseSync(sqliteDbPath);

  try {
    ensureRequiredColumns(db);
    if (shouldRunBackfill(db)) {
      db.exec(readFileSync(backfillSqlPath, 'utf8'));
    }
    printSummary(db);
  } finally {
    db.close();
  }
}

main();
