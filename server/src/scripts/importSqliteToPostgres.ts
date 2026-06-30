import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import prisma from '../lib/prisma.js';

type ColumnMeta = {
  dataType: string;
  udtName: string;
};

type ForeignKeyRow = {
  table: string;
};

type TableNameRow = {
  name: string;
};

type CountRow = {
  count: bigint | number;
};

const SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;

if (!SQLITE_DB_PATH) {
  throw new Error('Missing SQLITE_DB_PATH environment variable');
}

const sqliteDbPath = resolve(SQLITE_DB_PATH);

if (!existsSync(sqliteDbPath)) {
  throw new Error(`SQLite database not found: ${sqliteDbPath}`);
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function loadSqliteTables(db: DatabaseSync) {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as TableNameRow[];

  return rows.map((row) => row.name);
}

function loadDependencies(db: DatabaseSync, tables: string[]) {
  const tableSet = new Set(tables);
  const deps = new Map<string, Set<string>>();

  for (const table of tables) {
    const escapedTable = table.replace(/'/g, "''");
    const fkRows = db.prepare(`PRAGMA foreign_key_list('${escapedTable}')`).all() as ForeignKeyRow[];
    const tableDeps = new Set<string>();

    for (const row of fkRows) {
      if (row.table !== table && tableSet.has(row.table)) {
        tableDeps.add(row.table);
      }
    }

    deps.set(table, tableDeps);
  }

  return deps;
}

function topologicalSort(tables: string[], deps: Map<string, Set<string>>) {
  const remainingDeps = new Map<string, Set<string>>();
  const reverseDeps = new Map<string, Set<string>>();

  for (const table of tables) {
    const tableDeps = new Set(deps.get(table) ?? []);
    remainingDeps.set(table, tableDeps);

    for (const dep of tableDeps) {
      const dependants = reverseDeps.get(dep) ?? new Set<string>();
      dependants.add(table);
      reverseDeps.set(dep, dependants);
    }
  }

  const ready = tables.filter((table) => (remainingDeps.get(table)?.size ?? 0) === 0).sort();
  const ordered: string[] = [];

  while (ready.length > 0) {
    const table = ready.shift()!;
    ordered.push(table);

    for (const dependant of reverseDeps.get(table) ?? []) {
      const dependantDeps = remainingDeps.get(dependant);
      if (!dependantDeps) continue;
      dependantDeps.delete(table);
      if (dependantDeps.size === 0) {
        ready.push(dependant);
        ready.sort();
      }
    }
  }

  if (ordered.length !== tables.length) {
    const unresolved = tables.filter((table) => !ordered.includes(table)).sort();
    console.warn(`Dependency cycle detected, appending unresolved tables in alphabetical order: ${unresolved.join(', ')}`);
    ordered.push(...unresolved);
  }

  return ordered;
}

async function loadPostgresColumnMeta() {
  const rows = await prisma.$queryRawUnsafe<Array<{
    table_name: string;
    column_name: string;
    data_type: string;
    udt_name: string;
  }>>(`
    SELECT table_name, column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);

  const tableMeta = new Map<string, Map<string, ColumnMeta>>();

  for (const row of rows) {
    const columns = tableMeta.get(row.table_name) ?? new Map<string, ColumnMeta>();
    columns.set(row.column_name, {
      dataType: row.data_type,
      udtName: row.udt_name,
    });
    tableMeta.set(row.table_name, columns);
  }

  return tableMeta;
}

function normalizeValue(value: unknown, meta?: ColumnMeta) {
  if (value === null || value === undefined) {
    return null;
  }

  if (meta && (meta.dataType === 'date' || meta.dataType.includes('timestamp'))) {
    const normalizeEpoch = (epochValue: number) => {
      const milliseconds = epochValue >= 1_000_000_000_000 ? epochValue : epochValue >= 1_000_000_000 ? epochValue * 1000 : epochValue;
      const iso = new Date(milliseconds).toISOString();
      return meta.dataType === 'date' ? iso.slice(0, 10) : iso;
    };

    if (value instanceof Date) {
      return meta.dataType === 'date' ? value.toISOString().slice(0, 10) : value.toISOString();
    }

    if (typeof value === 'number') {
      return normalizeEpoch(value);
    }

    if (typeof value === 'bigint') {
      return normalizeEpoch(Number(value));
    }

    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
      return normalizeEpoch(Number(value.trim()));
    }
  }

  if (meta?.dataType === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'bigint') return value !== 0n;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 't', 'yes', 'y'].includes(normalized)) return true;
      if (['0', 'false', 'f', 'no', 'n', ''].includes(normalized)) return false;
    }
  }

  if (typeof value === 'bigint') {
    return Number(value);
  }

  return value;
}

function buildPlaceholder(index: number, meta?: ColumnMeta) {
  const base = `$${index + 1}`;

  if (!meta) {
    return base;
  }

  if (meta.dataType === 'date') {
    return `${base}::date`;
  }

  if (meta.dataType.includes('timestamp')) {
    return `${base}::timestamp`;
  }

  if (meta.dataType === 'boolean') {
    return `${base}::boolean`;
  }

  return base;
}

async function ensureTargetIsEmpty(tables: string[]) {
  for (const table of tables) {
    const rows = await prisma.$queryRawUnsafe<CountRow[]>(`SELECT COUNT(*)::bigint AS count FROM ${quoteIdentifier(table)}`);
    const count = Number(rows[0]?.count ?? 0);

    if (count > 0) {
      throw new Error(`Target PostgreSQL table is not empty: ${table} (${count} rows)`);
    }
  }
}

async function importTable(
  db: DatabaseSync,
  table: string,
  tableMeta: Map<string, Map<string, ColumnMeta>>,
) {
  const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all() as Record<string, unknown>[];
  if (rows.length === 0) {
    console.log(`- ${table}: 0 rows`);
    return;
  }

  const columnsMeta = tableMeta.get(table) ?? new Map<string, ColumnMeta>();
  const columns = Object.keys(rows[0]);
  const quotedColumns = columns.map(quoteIdentifier).join(', ');

  for (const row of rows) {
    const values = columns.map((column) => normalizeValue(row[column], columnsMeta.get(column)));
    const placeholders = columns.map((column, index) => buildPlaceholder(index, columnsMeta.get(column))).join(', ');
    const sql = `INSERT INTO ${quoteIdentifier(table)} (${quotedColumns}) VALUES (${placeholders})`;
    await prisma.$executeRawUnsafe(sql, ...values);
  }

  console.log(`- ${table}: ${rows.length} rows`);
}

async function verifyCounts(db: DatabaseSync, tables: string[]) {
  for (const table of tables) {
    const sqliteCountRow = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get() as CountRow;
    const postgresCountRows = await prisma.$queryRawUnsafe<CountRow[]>(
      `SELECT COUNT(*)::bigint AS count FROM ${quoteIdentifier(table)}`,
    );

    const sqliteCount = Number(sqliteCountRow.count ?? 0);
    const postgresCount = Number(postgresCountRows[0]?.count ?? 0);

    if (sqliteCount !== postgresCount) {
      throw new Error(`Count mismatch for ${table}: sqlite=${sqliteCount}, postgres=${postgresCount}`);
    }
  }
}

async function main() {
  console.log(`Reading SQLite database: ${sqliteDbPath}`);
  const sqlite = new DatabaseSync(sqliteDbPath, { open: true, readOnly: true });

  try {
    const tables = loadSqliteTables(sqlite);
    const dependencies = loadDependencies(sqlite, tables);
    const orderedTables = topologicalSort(tables, dependencies);

    console.log(`Discovered ${orderedTables.length} tables`);
    console.log(`Import order: ${orderedTables.join(', ')}`);

    await ensureTargetIsEmpty(orderedTables);
    const tableMeta = await loadPostgresColumnMeta();

    for (const table of orderedTables) {
      await importTable(sqlite, table, tableMeta);
    }

    await verifyCounts(sqlite, orderedTables);
    console.log('SQLite to PostgreSQL import finished successfully');
  } finally {
    sqlite.close();
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
