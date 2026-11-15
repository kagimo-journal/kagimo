import { Fragment } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { lock } from '../../crypto/session';
import { AccountButton } from '../../components/AccountButton';
import { useNeedsPassword } from '../../components/security/SetPassword';
import { SUPPORT_EMAIL } from '../../lib/support';
import { useAuth } from '../../state/auth';
import { useIdentity } from '../../state/identity';
import { useSettings } from '../../state/settings';
import { useSyncStatus } from '../../sync/engine';
import { LoadingScreen } from '../../components/Spinner';
import { settingsSections, type Section } from './nav';
import './settings.css';

const subHref = (s: Section, path: string) => `/settings/${s.path}${path ? `/${path}` : ''}`;

export default function SettingsLayout() {
  const me = useIdentity();
  const { me: account, config } = useAuth();
  const sync = useSyncStatus();
  const { saveError, loadError, loaded } = useSettings();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const needsPassword = useNeedsPassword();
  const sections = settingsSections({ synced: me.synced, needsPassword, billing: !!account?.billing.enabled, downloads: !!config?.downloads?.length });
  const open = sections.find((s) => pathname === `/settings/${s.path}` || pathname.startsWith(`/settings/${s.path}/`));
  const cls = ({ isActive }: { isActive: boolean }) => `settings-link${isActive ? ' active' : ''}`;
  const subCls = ({ isActive }: { isActive: boolean }) => `settings-sublink${isActive ? ' active' : ''}`;
  const syncBadge = !me.synced ? 'Off' : sync.conflicts || sync.phase === 'signed-out' || sync.phase === 'waiting' || sync.phase === 'error' || sync.phase === 'full' ? '!' : null;
  const subLinks = (s: Section) =>
    s.subs.map((p) => (
      <NavLink key={p.path} to={subHref(s, p.path)} end className={subCls}>
        {p.label}
      </NavLink>
    ));
  return (
    <div className="settings-shell">
      <nav aria-label="Settings" className="settings-nav">
        <Link to="/" className="settings-back">← Back to journal</Link>
        {sections.map((s) => (
          <Fragment key={s.path}>
            <NavLink to={`/settings/${s.path}`} className={cls}>
              {s.label}
              {s.path === 'sync' && syncBadge && (
                <span className={`settings-badge${syncBadge === '!' ? ' warn' : ''}`}>{syncBadge === '!' ? 'Check' : syncBadge}</span>
              )}
            </NavLink>
            {s === open && s.subs.length > 1 && (
              <div className="settings-subnav" role="group" aria-label={s.label}>
                {subLinks(s)}
              </div>
            )}
          </Fragment>
        ))}
        {me.isAdmin && <NavLink to="/admin" className={cls}>Admin</NavLink>}
        <Link to="/about" className="settings-link">How it works</Link>
        <Link to="/terms" className="settings-link">Terms</Link>
        <a href={`mailto:${SUPPORT_EMAIL}`} className="settings-link">Contact support</a>
        <div className="settings-nav-foot">
          {!needsPassword && (
            <button type="button" className="settings-link signout" onClick={() => void lock().then(() => navigate('/unlock'))}>
              Lock journal
            </button>
          )}
          <AccountButton variant="link" />
        </div>
      </nav>
      <main className="settings-main" id="main">
        <div className="settings-content">
          {open && open.subs.length > 1 && (
            <nav className="settings-subnav-row" aria-label={`${open.label} pages`}>
              {subLinks(open)}
            </nav>
          )}
          {(loadError || saveError) && (
            <div className="notice danger" role="alert">
              <span>{loadError ?? saveError}</span>
            </div>
          )}
          {loaded ? <Outlet /> : <LoadingScreen label="Decrypting settings…" />}
        </div>
      </main>
    </div>
  );
}
