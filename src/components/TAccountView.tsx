import { fmtDate, fmtMoney } from '../lib/format';
import type { TAccount, TAccountEntry } from '../logic/ledger';

const TYPE_LABEL: Record<string, string> = {
  asset: 'Asset',
  liability: 'Liability',
  equity: 'Equity',
  income: 'Income',
  expense: 'Expense',
};

function Side({
  title,
  opening,
  entries,
  carried,
  total,
  padTo,
}: {
  title: string;
  opening: number;
  entries: TAccountEntry[];
  carried: number;
  total: number;
  padTo: number;
}) {
  // Blank rows keep the two columns the same height, the way a written-up
  // ledger page lines its sides up.
  const filler = Math.max(0, padTo - entries.length - (opening ? 1 : 0) - (carried ? 1 : 0));
  return (
    <div className="side">
      <h4>{title}</h4>
      <table>
        <tbody>
          {opening > 0 && (
            <tr className="cd">
              <td className="tdate"></td>
              <td className="tdetail">Balance b/d</td>
              <td className="num">{fmtMoney(opening)}</td>
            </tr>
          )}
          {entries.map((e, i) => (
            <tr key={i}>
              <td className="tdate">{fmtDate(e.date).replace(/ \d{4}$/, '')}</td>
              <td className="tdetail">{e.detail || '—'}</td>
              <td className="num">{fmtMoney(e.amount)}</td>
            </tr>
          ))}
          {carried > 0 && (
            <tr className="cd">
              <td className="tdate"></td>
              <td className="tdetail">Balance c/d</td>
              <td className="num">{fmtMoney(carried)}</td>
            </tr>
          )}
          {Array.from({ length: filler }, (_, i) => (
            <tr className="filler" key={`f${i}`}>
              <td colSpan={3}></td>
            </tr>
          ))}
          <tr className="tot">
            <td className="tdate"></td>
            <td></td>
            <td className="num">{fmtMoney(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * A ledger account in the classic two-sided presentation: debits left, credits
 * right, the closing balance carried down on the short side so both columns
 * total the same figure.
 */
export function TAccountView({ t }: { t: TAccount }) {
  const grand = Math.max(t.totalDebit + t.closingDebit, t.totalCredit + t.closingCredit);
  const padTo = Math.max(t.debits.length + (t.openingDebit ? 1 : 0), t.credits.length + (t.openingCredit ? 1 : 0));
  const net = t.totalDebit - t.totalCredit;
  return (
    <div className="taccount">
      <header>
        <strong>{t.name}</strong>
        <span className="pill">{TYPE_LABEL[t.type] ?? t.type}</span>
        <div className="spacer" style={{ flex: 1 }} />
        <span className="small muted">
          {net === 0 ? 'nil balance' : `${fmtMoney(Math.abs(net))} ${net > 0 ? 'Dr' : 'Cr'}`}
        </span>
      </header>
      <div className="sides">
        <Side title="Debit" opening={t.openingDebit} entries={t.debits} carried={t.closingDebit} total={grand} padTo={padTo} />
        <Side title="Credit" opening={t.openingCredit} entries={t.credits} carried={t.closingCredit} total={grand} padTo={padTo} />
      </div>
    </div>
  );
}
