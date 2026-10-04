import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '../session';
import { ErrorState, Icon, Spinner } from './ui';

const NAV = [
  { to: '/', label: 'Dashboard', icon: 'dashboard' as const, end: true },
  { to: '/upload', label: 'Upload Agreement', icon: 'upload' as const, end: false },
  { to: '/subawards', label: 'Subawards', icon: 'list' as const, end: false },
  { to: '/audit', label: 'Audit Trail', icon: 'audit' as const, end: false },
];

export function Layout() {
  const { health, me, demoUsers, loading, waiting, error, switchUser, reload } = useSession();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setNavOpen(false), [location.pathname]);
  // Escape closes the mobile navigation drawer and returns focus to its toggle.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setNavOpen(false);
        document.querySelector<HTMLButtonElement>('.nav-toggle')?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="topbar">
        <button className="icon-btn nav-toggle" onClick={() => setNavOpen((o) => !o)} aria-label="Toggle navigation" aria-expanded={navOpen}>
          <Icon name="menu" />
        </button>
        <div className="brand">
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="#fff" fillOpacity="0.12" />
            <path d="M8 22.5 13.5 17l4 4L24 12" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="24" cy="12" r="2.4" fill="#7cc4a4" />
          </svg>
          <div>
            <div className="brand-name">GrantTrail AI</div>
            <div className="brand-sub">Subaward Reporting Assistant</div>
          </div>
        </div>
        <div className="topbar-org">Riverbend Housing Coalition</div>
        <div className="topbar-user">
          {health?.modes.auth === 'dev' && me ? (
            <label className="user-switch">
              <span className="user-switch-label">Signed in as</span>
              <select value={me.email} onChange={(e) => switchUser(e.target.value)} aria-label="Switch demo user">
                {demoUsers.map((u) => (
                  <option key={u.email} value={u.email}>
                    {u.fullName} — {u.roleLabel}
                  </option>
                ))}
              </select>
            </label>
          ) : me ? (
            <span className="user-chip">
              {me.fullName} · {me.roleLabel}
            </span>
          ) : null}
        </div>
      </header>

      {health?.demoMode && (
        <aside className="demo-banner" aria-label="Demo mode notice">
          <strong>DEMO MODE</strong>
          <span>
            Extraction is <em>simulated</em> by a rule-based extractor (Claude is not called); all organizations and data are fictional.
            {health.publicDemo && <> This is a public demo without sign-in, so please don’t upload real agreements.</>}
          </span>
        </aside>
      )}

      <div className="shell-body">
        <nav className={`sidebar ${navOpen ? 'open' : ''}`} aria-label="Primary">
          <ul>
            {NAV.map((n) => (
              <li key={n.to}>
                <NavLink to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : undefined)}>
                  <Icon name={n.icon} />
                  <span>{n.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
          <div className="sidebar-foot">
            <div className="principle">
              <span>AI extracts.</span>
              <span>Code validates.</span>
              <span>Humans approve.</span>
            </div>
            {health && (
              <dl className="env-list">
                <div>
                  <dt>Extraction</dt>
                  <dd>{health.modes.ai === 'demo' ? 'Demo simulator' : 'Claude'}</dd>
                </div>
                <div>
                  <dt>Database</dt>
                  <dd>{health.modes.database === 'pglite' ? 'Embedded Postgres' : 'PostgreSQL'}</dd>
                </div>
                <div>
                  <dt>Storage</dt>
                  <dd>{health.modes.storage === 's3' ? 'Amazon S3' : 'Local disk'}</dd>
                </div>
              </dl>
            )}
          </div>
        </nav>
        {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}

        <main id="main" className="main" tabIndex={-1}>
          {loading && !me ? (
            <Spinner label={waiting ? 'Waiting for the GrantTrail server to start…' : 'Starting GrantTrail…'} />
          ) : error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : me && me.permissions.length === 0 ? (
            <div className="state-block">
              <Icon name="shield" size={30} />
              <h3>No access in this release</h3>
              <p>
                {me.fullName} is a <strong>{me.roleLabel}</strong> user. Partner agency access — for correcting your own organization’s
                information — is planned for a future release. Switch to a Riverbend staff user to continue.
              </p>
            </div>
          ) : (
            <Outlet />
          )}
        </main>
      </div>
    </div>
  );
}
