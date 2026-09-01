import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

export interface AuthState {
  loading: boolean;
  session: Session | null;
  /** null while checking; false = signed in but not on the members list. */
  member: boolean | null;
}

export function useSession(): AuthState {
  const [state, setState] = useState<AuthState>({ loading: true, session: null, member: null });

  useEffect(() => {
    let alive = true;

    async function checkMember(session: Session | null) {
      if (!session) {
        if (alive) setState({ loading: false, session: null, member: null });
        return;
      }
      const { data, error } = await supabase.rpc('fin_is_member');
      if (!alive) return;
      setState({ loading: false, session, member: error ? false : data === true });
    }

    supabase.auth.getSession().then(({ data }) => void checkMember(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      void checkMember(session);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}

export async function signIn(email: string, password: string): Promise<string | null> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return error ? error.message : null;
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}
