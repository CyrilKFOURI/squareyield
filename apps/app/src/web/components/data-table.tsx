// Dense sortable table: sticky header, hairline rows, numbers right-aligned in tabular figures.
import type { ReactNode } from 'react';

import { InfoTip } from './panel';

export type Column<R> = {
  key: string;
  label: string;
  numeric?: boolean;
  info?: string;
  render: (row: R) => ReactNode;
  sortable?: boolean;
};

type DataTableProps<R> = {
  columns: Column<R>[];
  rows: R[];
  rowKey: (row: R) => string;
  sort?: { key: string; dir: 'asc' | 'desc' };
  onSort?: (key: string) => void;
  onRowClick?: (row: R) => void;
  selected?: string | null;
  maxHeight?: number | string;
  empty?: ReactNode;
};

export const DataTable = <R,>({
  columns,
  rows,
  rowKey,
  sort,
  onSort,
  onRowClick,
  selected,
  maxHeight,
  empty,
}: DataTableProps<R>) => (
  <div className="cy-table-wrap" style={{ maxHeight }}>
    <table className="cy-table">
      <thead>
        <tr>
          {columns.map((column) => (
            <th
              key={column.key}
              className={column.numeric ? 'num' : undefined}
              aria-sort={sort?.key === column.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
              {onSort && column.sortable !== false ? (
                <button type="button" onClick={() => onSort(column.key)}>
                  {column.label}
                  {sort?.key === column.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                </button>
              ) : (
                column.label
              )}
              {column.info && <InfoTip k={column.info} />}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const key = rowKey(row);
          return (
            <tr
              key={key}
              className={selected === key ? 'selected' : undefined}
              data-href={onRowClick ? 'row' : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}>
              {columns.map((column) => (
                <td key={column.key} className={column.numeric ? 'num' : undefined}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
    {rows.length === 0 && empty}
  </div>
);
