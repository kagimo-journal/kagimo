import type { ReactNode } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useNeedsPassword } from '../../components/security/SetPassword';
import { useIdentity } from '../../state/identity';
import { isSubPage, settingsSections } from './nav';

/** One settings sub-page: its title, a line on what it's for, then the controls. */
export function SettingsPage({ title, lede, children }: { title: ReactNode; lede?: ReactNode; children?: ReactNode }) {
  return (
    <>
      <div className="settings-page-head">
        <h1 className="page-title">{title}</h1>
        {lede && <p className="lede">{lede}</p>}
      </div>
      {children}
    </>
  );
}

/**
 * The open sub-page of a section (`''` for the first), or a redirect to the section when the URL
 * names one that doesn't exist (or doesn't apply right now, e.g. "Delete journal" once synced).
 */
export function useSubPage(section: string): { sub: string; redirect: ReactNode | null } {
  const { sub } = useParams();
  const { synced } = useIdentity();
  const needsPassword = useNeedsPassword();
  const ok = isSubPage(settingsSections({ synced, needsPassword }), section, sub);
  return { sub: ok ? (sub ?? '') : '', redirect: ok ? null : <Navigate to={`/settings/${section}`} replace /> };
}
