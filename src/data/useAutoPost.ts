import { useEffect, useRef } from 'react';
import { useData } from './DataContext';
import { dueDates } from '../logic/recurring';
import { postDue } from '../pages/Recurring';
import { todayStr } from '../lib/format';

/**
 * Posts any auto-post series that has fallen due, once per app load.
 * This is deliberately client-side: there is no server, so "automatic" means
 * "the next time Kyle opens the app" — the Recurring screen says so.
 *
 * The ref guard matters because DataContext refreshes after each post, which
 * re-renders this hook with new data; without it the effect would re-enter
 * while the first pass is still running.
 */
export function useAutoPost(): void {
  const { recurring, loading, refresh } = useData();
  const ran = useRef(false);

  useEffect(() => {
    if (loading || ran.current) return;
    const today = todayStr();
    const owed = recurring
      .filter((r) => r.auto_post && !r.archived)
      .map((r) => ({ rule: r, dates: dueDates(r, today) }))
      .filter((d) => d.dates.length > 0);
    if (owed.length === 0) {
      ran.current = true; // nothing owed on this load; don't re-scan
      return;
    }
    ran.current = true;
    void (async () => {
      for (const { rule, dates } of owed) await postDue(rule, dates);
      await refresh();
    })();
  }, [recurring, loading, refresh]);
}
