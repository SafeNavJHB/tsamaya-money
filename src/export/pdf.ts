// PDF reports via jsPDF + autotable, loaded on demand. One generic builder
// renders a titled document with any number of tables, right-aligned money
// columns, and an optional emphasised total row per table.
import { fmtMoney } from '../lib/format';

export interface PdfTableSpec {
  title?: string;
  headers: string[];
  rows: (string | number | null)[][];
  /** Column indexes rendered as right-aligned money. */
  moneyCols?: number[];
  /** When true the last row is emphasised (totals). */
  totalRow?: boolean;
}

export async function exportPdf(
  filename: string,
  docTitle: string,
  subtitle: string,
  tables: PdfTableSpec[],
): Promise<void> {
  const [{ jsPDF }, autoTableMod] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const autoTable = autoTableMod.default;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const margin = 48;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('TSAMAYA MONEY', margin, 44);
  doc.setFontSize(18);
  doc.setTextColor(20);
  doc.text(docTitle, margin, 66);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(90);
  doc.text(subtitle, margin, 82);
  const now = new Date();
  doc.setFontSize(8);
  doc.text(`Generated ${now.toISOString().slice(0, 10)}`, margin, 94);

  let y = 112;
  for (const t of tables) {
    if (t.title) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(20);
      doc.text(t.title, margin, y);
      y += 6;
    }
    const money = new Set(t.moneyCols ?? []);
    const body = t.rows.map((row) =>
      row.map((cell, i) => (typeof cell === 'number' && money.has(i) ? fmtMoney(cell) : cell == null ? '' : String(cell))),
    );
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [t.headers],
      body,
      styles: { font: 'helvetica', fontSize: 9, cellPadding: 4, textColor: 40 },
      headStyles: { fillColor: [37, 106, 191], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [247, 247, 245] },
      columnStyles: Object.fromEntries([...money].map((c) => [c, { halign: 'right' as const }])),
      didParseCell: (data) => {
        if (t.totalRow && data.section === 'body' && data.row.index === body.length - 1) {
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.fillColor = [232, 238, 247];
        }
      },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 28;
    if (y > doc.internal.pageSize.getHeight() - 120 && t !== tables[tables.length - 1]) {
      doc.addPage();
      y = 56;
    }
  }
  doc.save(filename);
}
