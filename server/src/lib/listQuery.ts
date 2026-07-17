import type { Response } from 'express';
import { AppError } from '../middleware/errorHandler.js';

export type SortDirection = 'asc' | 'desc';

type QueryRecord = Record<string, unknown>;

function queryText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function positiveInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(queryText(value) || '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

export interface ListQueryOptions<TSort extends string> {
  allowedSorts: readonly TSort[];
  defaultSort: TSort;
  defaultDirection?: SortDirection;
  defaultLimit?: number;
  maxLimit?: number;
}

export interface ParsedListQuery<TSort extends string> {
  page: number;
  limit: number;
  skip: number;
  sort: TSort;
  direction: SortDirection;
}

/**
 * Parses collection pagination and sort parameters with an allow-list.  This
 * keeps untrusted URL query values out of Prisma's dynamic orderBy objects.
 */
export function parseListQuery<TSort extends string>(
  query: QueryRecord,
  options: ListQueryOptions<TSort>,
): ParsedListQuery<TSort> {
  const maxLimit = options.maxLimit ?? 100;
  const limit = positiveInteger(query.limit, options.defaultLimit ?? 20, maxLimit);
  const page = positiveInteger(query.page, 1, Number.MAX_SAFE_INTEGER);
  const requestedSort = queryText(query.sort);
  const sort = requestedSort && options.allowedSorts.includes(requestedSort as TSort)
    ? requestedSort as TSort
    : options.defaultSort;
  const requestedDirection = queryText(query.direction ?? query.dir)?.toLowerCase();
  const direction: SortDirection = requestedDirection === 'asc' || requestedDirection === 'desc'
    ? requestedDirection
    : options.defaultDirection ?? 'desc';

  return {
    page,
    limit,
    skip: (page - 1) * limit,
    sort,
    direction,
  };
}

export const DEFAULT_FILTERED_EXPORT_ROWS = 1000;
export const MAX_FILTERED_EXPORT_ROWS = 5000;

export interface ControlledExportWindow {
  scope: 'page' | 'filtered';
  page: number;
  limit: number;
  skip: number;
  take: number;
  rowLimit: number;
}

/**
 * Full filtered exports require an explicit confirmation and are capped.  A
 * page export reuses normal pagination boundaries, so no endpoint ever treats
 * the first response page as the complete collection.
 */
export function parseControlledExportWindow(query: QueryRecord): ControlledExportWindow {
  const scope = queryText(query.scope) === 'filtered' ? 'filtered' : 'page';
  const page = positiveInteger(query.page, 1, Number.MAX_SAFE_INTEGER);
  const limit = positiveInteger(query.limit, 20, 100);
  const rowLimit = positiveInteger(query.maxRows, DEFAULT_FILTERED_EXPORT_ROWS, MAX_FILTERED_EXPORT_ROWS);

  if (scope === 'filtered' && queryText(query.confirm) !== 'full') {
    throw new AppError(
      '导出全部筛选结果需要显式确认，请传入 confirm=full',
      400,
      'EXPORT_CONFIRMATION_REQUIRED',
    );
  }

  return scope === 'filtered'
    ? { scope, page, limit, skip: 0, take: rowLimit, rowLimit }
    : { scope, page, limit, skip: (page - 1) * limit, take: limit, rowLimit: limit };
}

export type CsvCell = string | number | boolean | Date | null | undefined;

export interface CsvColumn<Row> {
  header: string;
  value: (row: Row) => CsvCell;
}

function csvCell(value: CsvCell): string {
  let normalized = value instanceof Date
    ? value.toISOString()
    : value === null || value === undefined
      ? ''
      : String(value);

  // Guard spreadsheet consumers against formula interpretation when opening a
  // CSV file directly in Excel or similar applications.
  if (/^[=+\-@]/.test(normalized)) normalized = `'${normalized}`;
  return `"${normalized.replace(/"/g, '""')}"`;
}

export function toCsv<Row>(columns: readonly CsvColumn<Row>[], rows: readonly Row[]): string {
  const header = columns.map((column) => csvCell(column.header)).join(',');
  const body = rows.map((row) => columns.map((column) => csvCell(column.value(row))).join(','));
  return `\uFEFF${[header, ...body].join('\n')}`;
}

export function sendCsv<Row>(
  res: Response,
  filename: string,
  columns: readonly CsvColumn<Row>[],
  rows: readonly Row[],
  metadata: { scope: ControlledExportWindow['scope']; rowLimit: number },
): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Export-Scope', metadata.scope);
  res.setHeader('X-Export-Row-Limit', String(metadata.rowLimit));
  res.send(toCsv(columns, rows));
}
