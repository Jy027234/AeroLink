import { describe, expect, it } from 'vitest';
import {
  MAX_FILTERED_EXPORT_ROWS,
  parseControlledExportWindow,
  parseListQuery,
  toCsv,
} from './listQuery.js';

describe('list query controls', () => {
  it('keeps a 1,000+ record offset and only accepts allow-listed sorting', () => {
    const parsed = parseListQuery(
      { page: '51', limit: '20', sort: 'createdAt', direction: 'asc' },
      {
        allowedSorts: ['createdAt', 'name'] as const,
        defaultSort: 'name',
        defaultDirection: 'desc',
      },
    );

    expect(parsed).toEqual({
      page: 51,
      limit: 20,
      skip: 1000,
      sort: 'createdAt',
      direction: 'asc',
    });

    expect(parseListQuery(
      { sort: 'DROP TABLE', direction: 'sideways' },
      { allowedSorts: ['name'] as const, defaultSort: 'name', defaultDirection: 'asc' },
    )).toMatchObject({ sort: 'name', direction: 'asc' });
  });

  it('requires explicit confirmation and caps filtered exports', () => {
    expect(() => parseControlledExportWindow({ scope: 'filtered' })).toThrow(
      '导出全部筛选结果需要显式确认',
    );

    expect(parseControlledExportWindow({
      scope: 'filtered',
      confirm: 'full',
      maxRows: '999999',
    })).toMatchObject({
      scope: 'filtered',
      skip: 0,
      take: MAX_FILTERED_EXPORT_ROWS,
      rowLimit: MAX_FILTERED_EXPORT_ROWS,
    });
  });

  it('prevents spreadsheet formula interpretation in CSV cells', () => {
    const csv = toCsv([{ header: 'Value', value: (row: { value: string }) => row.value }], [{ value: '=1+1' }]);
    expect(csv).toContain("'=1+1");
  });
});
