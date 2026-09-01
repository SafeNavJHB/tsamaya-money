import { downloadBlob } from './download';

export type CsvCell = string | number | null | undefined;

function esc(cell: CsvCell): string {
  if (cell == null) return '';
  if (typeof cell === 'number') return String(cell); // dot decimals, no grouping
  const s = String(cell);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(headers: string[], rows: CsvCell[][]): string {
  const lines = [headers.map(esc).join(',')];
  for (const row of rows) lines.push(row.map(esc).join(','));
  return lines.join('\r\n') + '\r\n';
}

export function exportCsv(filename: string, headers: string[], rows: CsvCell[][]): void {
  // BOM so Excel opens it as UTF-8 without an import wizard
  const blob = new Blob(['﻿' + rowsToCsv(headers, rows)], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, filename);
}
