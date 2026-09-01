import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { DataProvider, useData } from './data/DataContext';
import { signOut, useSession } from './auth/useSession';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Transactions } from './pages/Transactions';
import { Reports } from './pages/Reports';
import { Categories } from './pages/Categories';
import { Accounts } from './pages/Accounts';
import { Assets } from './pages/Assets';
import { Recurring } from './pages/Recurring';
import { Import } from './pages/Import';
import { Ledger } from './pages/Ledger';
import { DepreciationRegister } from './pages/Register';
import { useAutoPost } from './data/useAutoPost';
import { APP_NAME } from './config';

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

const ICONS = {
  home: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  chart: 'M4 20V10M10 20V4M16 20v-7M21 20H3',
  asset: 'M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
};

function Shell({ children }: { children: React.ReactNode }) {
  const { error } = useData();
  useAutoPost();
  const links = [
    { to: '/', label: 'Dashboard' },
    { to: '/transactions', label: 'Transactions' },
    { to: '/recurring', label: 'Recurring' },
    { to: '/reports', label: 'Reports' },
    { to: '/ledger', label: 'General ledger' },
    { to: '/categories', label: 'Categories' },
    { to: '/accounts', label: 'Accounts' },
    { to: '/assets', label: 'Assets' },
    { to: '/register', label: 'Depreciation' },
    { to: '/import', label: 'Import' },
  ];
  return (
    <>
      <header className="topbar">
        <div className="wordmark">
          <span className="r">R</span> Money
        </div>
        <nav>
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.to === '/'} className={({ isActive }) => `navlink${isActive ? ' active' : ''}`}>
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="spacer" />
        <button className="btn small" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      <main className="main">
        {error && <div className="error-banner">Couldn't load data: {error}</div>}
        {children}
      </main>
      <nav className="tabbar">
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
          <Icon d={ICONS.home} />
          Home
        </NavLink>
        <NavLink to="/transactions" className={({ isActive }) => (isActive ? 'active' : '')}>
          <Icon d={ICONS.list} />
          Transactions
        </NavLink>
        <NavLink to="/reports" className={({ isActive }) => (isActive ? 'active' : '')}>
          <Icon d={ICONS.chart} />
          Reports
        </NavLink>
        <NavLink to="/assets" className={({ isActive }) => (isActive ? 'active' : '')}>
          <Icon d={ICONS.asset} />
          Assets
        </NavLink>
        <NavLink to="/more" className={({ isActive }) => (isActive ? 'active' : '')}>
          <Icon d={ICONS.more} />
          More
        </NavLink>
      </nav>
    </>
  );
}

function More() {
  return (
    <div className="stack">
      <h1>More</h1>
      <div className="card stack">
        <NavLink className="btn" style={{ width: '100%' }} to="/ledger">
          General ledger & T-accounts
        </NavLink>
        <NavLink className="btn" style={{ width: '100%' }} to="/register">
          Depreciation register
        </NavLink>
        <NavLink className="btn" style={{ width: '100%' }} to="/recurring">
          Recurring transactions
        </NavLink>
        <NavLink className="btn" style={{ width: '100%' }} to="/import">
          Import bank statement
        </NavLink>
        <NavLink className="btn" style={{ width: '100%' }} to="/categories">
          Categories & budgets
        </NavLink>
        <NavLink className="btn" style={{ width: '100%' }} to="/accounts">
          Accounts
        </NavLink>
        <button className="btn" style={{ width: '100%' }} onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
      <p className="small muted" style={{ textAlign: 'center' }}>
        {APP_NAME} — the books for TSAMAYA (PTY) LTD. Data lives in your own Supabase project; use Reports → Full
        backup for an offline copy to hand your accountant.
      </p>
    </div>
  );
}

function NotMember() {
  return (
    <div className="center-screen">
      <div className="card auth-card">
        <h2>Signed in, but this isn't your ledger</h2>
        <p className="small muted" style={{ margin: '10px 0 14px' }}>
          This account isn't on the members list for {APP_NAME}.
        </p>
        <button className="btn" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const { loading, session, member } = useSession();

  if (loading) {
    return (
      <div className="center-screen">
        <div className="muted">Loading…</div>
      </div>
    );
  }
  if (!session) return <Login />;
  if (member === false) return <NotMember />;
  if (member == null) {
    return (
      <div className="center-screen">
        <div className="muted">Checking access…</div>
      </div>
    );
  }

  return (
    <DataProvider>
      <HashRouter>
        <Shell>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/transactions" element={<Transactions />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/categories" element={<Categories />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/assets" element={<Assets />} />
            <Route path="/recurring" element={<Recurring />} />
            <Route path="/import" element={<Import />} />
            <Route path="/ledger" element={<Ledger />} />
            <Route path="/register" element={<DepreciationRegister />} />
            <Route path="/more" element={<More />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Shell>
      </HashRouter>
    </DataProvider>
  );
}
