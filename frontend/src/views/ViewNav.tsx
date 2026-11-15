import { useMemo, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { useEntries } from '../editor/entriesStore';
import { useIdentity } from '../state/identity';
import { hasViews } from './journalData';
import './views.css';

/** Timeline and Books are offered once entries exist on two or more different days. */
export function useViewsAvailable(): boolean {
  const { items } = useEntries();
  return useMemo(() => hasViews(items), [items]);
}

const VIEWS = [
  { to: '/', label: 'Write', match: (p: string) => p === '/' || p.startsWith('/e/') },
  { to: '/timeline', label: 'Timeline', match: (p: string) => p.startsWith('/timeline') },
  { to: '/books', label: 'Books', match: (p: string) => p.startsWith('/books') },
];

/**
 * Write · Timeline · Books. `tabs` is the header/sidebar style from the boards; `segmented` is the
 * compact control on the mobile list. Renders nothing until there is more than Write to offer.
 */
export function ViewNav({ variant = 'tabs', className = '' }: { variant?: 'tabs' | 'segmented'; className?: string }) {
  const available = useViewsAvailable();
  const { pathname } = useLocation();
  if (!available) return null;
  return (
    <nav aria-label="Views" className={`view-nav ${variant} ${className}`}>
      {VIEWS.map((v) => {
        const current = v.match(pathname);
        return (
          <Link key={v.to} to={v.to} className="view-link" aria-current={current ? 'page' : undefined}>
            {v.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** The username with a small avatar initial; opens Settings. */
export function UserChip({ compact = false }: { compact?: boolean }) {
  const me = useIdentity();
  const initial = (me.displayName.match(/[a-z0-9]/i)?.[0] ?? '?').toLowerCase();
  return (
    <Link to="/settings" className={`user-chip${compact ? ' compact' : ''}`} title="Settings">
      <span className="avatar" aria-hidden>
        {initial}
      </span>
      <span className="user-name">{me.displayName}</span>
      <span className="visually-hidden">, settings</span>
    </Link>
  );
}

/** The slim header of the Timeline and Books views. */
export function AppHeader({ actions }: { actions?: ReactNode }) {
  return (
    <header className="app-header">
      <div className="app-header-start">
        <Brand />
        <ViewNav />
      </div>
      <div className="app-header-end">
        {actions}
        <UserChip />
      </div>
    </header>
  );
}
