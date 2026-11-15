import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { formatBytes } from '../lib/format';
import { useAuth } from '../state/auth';
import { useSyncStatus } from '../sync/engine';
import { formatAmount, freeFullText, longDate, paywall } from './paywallState';

const DISMISS_KEY = 'kagimo.subscribeBanner.dismissed';

function dismissedThisSession(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The call to subscribe: a strip across the top of the app for signed-in accounts on the free
 * plan. It can be hidden for the rest of the browser session, except once the free space is
 * full, when it turns into a warning that stays until they subscribe or free up space.
 */
export function SubscribeBanner() {
  const { me, config, refresh } = useAuth();
  const { pathname } = useLocation();
  const sync = useSyncStatus();
  const [dismissed, setDismissed] = useState(dismissedThisSession);
  const lastRefresh = useRef(0);

  const b = me?.billing;
  const plan = config?.billing;
  const free = !!b?.enabled && b.plan === 'free' && me?.status === 'active';

  // Keep "x of 20 MB" current: re-read the account after syncs, at most once a minute.
  useEffect(() => {
    if (!free || sync.phase === 'syncing' || Date.now() - lastRefresh.current < 60_000) return;
    lastRefresh.current = Date.now();
    void refresh().catch(() => {});
  }, [free, sync.lastSyncAt, sync.phase, refresh]);

  if (!free || !b || !plan?.enabled) return null;
  if (pathname.startsWith('/billing') || pathname === '/signin' || pathname === '/signup') return null;
  const full = b.full || sync.phase === 'full';
  if (dismissed && !full) return null;

  const price = plan.prices.find((p) => p.interval === 'month') ?? plan.prices[0];
  const from = price ? `${formatAmount(price)}/${price.interval}` : '';

  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* hidden until reload */
    }
    setDismissed(true);
  };

  return (
    <div className={`subscribe-banner${full ? ' full' : ''}`} role={full ? 'alert' : 'status'}>
      <span className="subscribe-banner-text">
        {full ? (
          <>
            <strong>{freeFullText(b)}</strong> New writing stays on this device until you subscribe.
          </>
        ) : (
          <>
            Free sync until {longDate(b.freeUntil)} · {formatBytes(b.usedBytes)} of {formatBytes(b.freeBytes)} synced.{' '}
            <span className="subscribe-banner-more">
              Get {formatBytes(plan.paidBytes)}{from && ` from ${from}`}.
            </span>
          </>
        )}
      </span>
      <span className="subscribe-banner-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => paywall.open('settings')}>
          Subscribe
        </button>
        {!full && (
          <button type="button" className="btn btn-ghost btn-sm subscribe-banner-close" onClick={dismiss} aria-label="Hide for now">
            ×
          </button>
        )}
      </span>
    </div>
  );
}
