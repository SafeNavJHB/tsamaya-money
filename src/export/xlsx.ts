// XLSX export via SheetJS, loaded on demand so the main bundle stays light.
// Numbers are written as real numbers with a #,##0.00 format — never as
// formatted strings — so Excel can sum them immediately.
import { downloadBlob } from './download';

export type SheetCell = string | number | null;

export interface SheetSpec {
  name: string;
  headers: string[];
  rows: SheetCell[][];
  /** Column indexes to format as money (#,##0.00). */
  moneyCols?: number[];
  /** Column widths in characters (optional, per column). */
  widths?: number[];
}

export async function exportXlsx(filename: string, sheets: SheetSpec[]): Promise<void> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  for (const spec of sheets) {
    const aoa: SheetCell[][] = [spec.headers, ...spec.rows];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (spec.moneyCols?.length) {
      for (let r = 1; r <= spec.rows.length; r++) {
        for (const c of spec.moneyCols) {
          const addr = XLSX.utils.encode_cell({ r, c });
          const cell = ws[addr];
          if (cell && typeof cell.v === 'number') cell.z = '#,##0.00';
        }
      }
    }
    ws['!cols'] = (spec.widths ?? spec.headers.map((h, i) => {
      let w = h.length;
      for (const row of spec.rows) {
        const v = row[i];
        if (v != null) w = Math.max(w, String(v).length);
      }
      return Math.min(w + 2, 40);
    })).map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, ws, spec.name.slice(0, 31));
  }
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  downloadBlob(
    new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    filename,
  );
}
