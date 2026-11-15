import { NEW_TAB } from '../../desktop/bridge';
import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { errorMessage } from '../../api/client';
import { billing as billingApi } from '../../api/endpoints';
import type { Billing } from '../../api/types';
import { freeFullText, longDate, openInNewTab, paywall, priceLabel } from '../../billing/paywallState';
import { ShieldIcon } from '../../components/Icons';
import { Spinner } from '../../components/Spinner';
import { formatBytes } from '../../lib/format';
import { useAuth } from '../../state/auth';

function summary(b: Billing): { title: string; text: string } {
  const used = b.limitBytes > 0 ? ` ${formatBytes(b.usedBytes)} of ${formatBytes(b.limitBytes)} used.` : '';
  switch (b.plan) {
    case 'admin':
      return { title: 'Administrator', text: 'Administrators can always sync as much as they like.' };
    case 'comped':
      return { title: 'Complimentary', text: `This account has the subscription's sync space at no cost.${used}` };
    case 'unlimited':
      return { title: 'Unlimited', text: "This server doesn't charge for Kagimo." };
    case 'subscribed':
      if (b.status === 'past_due')
        return { title: 'Payment problem', text: "Stripe couldn't take the latest payment and will try again. Update your card to keep syncing." };
      if (b.cancelAtPeriodEnd)
        return { title: 'Subscribed until ' + longDate(b.periodEnd), text: `Your subscription won't renew. After that date new writing stays on your devices instead of syncing, and everything already synced stays yours to read, edit and export.` };
      if (b.full)
        return { title: 'Subscribed', text: `You've reached the ${formatBytes(b.limitBytes)} fair-use limit. Delete some entries to make room; new changes wait on this device meanwhile.` };
      return { title: 'Subscribed', text: `Renews on ${longDate(b.periodEnd)}.${used}` };
    case 'free':
      return {
        title: 'Free',
        text: b.full
          ? `${freeFullText(b)} You can still write: new changes stay on this device until you subscribe, and everything already synced stays yours to read, edit and export.`
          : `Sync is free until ${longDate(b.freeUntil)}. ${formatBytes(b.usedBytes)} of ${formatBytes(b.freeBytes)} free sync space used.`,
      };
  }
}

export default function Subscription() {
  const { me } = useAuth();
  // Plans belong to a sync account; without one there's nothing to show.
  if (!me?.billing.enabled) return <Navigate to="/settings/sync" replace />;
  return <SubscriptionPage billing={me.billing} />;
}

function SubscriptionPage({ billing: b }: { billing: Billing }) {
  const { config, refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const price = priceLabel(config?.billing);

  // Pick up changes made in the customer portal when the user comes back to this tab.
  const sync = useCallback(async () => {
    if (!b.hasCustomer || document.visibilityState !== 'visible') return;
    try {
      await billingApi.sync();
      await refresh();
    } catch {
      /* shown state stays as it was */
    }
  }, [b.hasCustomer, refresh]);

  useEffect(() => {
    void sync();
    window.addEventListener('focus', sync);
    return () => window.removeEventListener('focus', sync);
  }, [sync]);

  const manage = async () => {
    setBusy(true);
    setError(null);
    try {
      const { opened, url } = await openInNewTab(billingApi.portal);
      setFallbackUrl(opened ? null : url);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const { title, text } = summary(b);
  const canManage = b.hasCustomer && (b.plan === 'subscribed' || b.plan === 'free');

  return (
    <>
      <h1 className="page-title">Subscription</h1>
      <div className="card" style={{ maxWidth: 620, gap: 16 }}>
        <div className="stack" style={{ gap: 6 }}>
          <span className="eyebrow">Your plan</span>
          <span style={{ fontSize: 18, fontWeight: 600 }}>{title}</span>
          <p className="hint" style={{ margin: 0 }}>{text}</p>
        </div>
        {error && <p className="error-text" role="alert">{error}</p>}
        {fallbackUrl && (
          <p className="notice">
            <span>
              Your browser blocked the new tab.{' '}
              <a href={fallbackUrl} target="_blank" rel="noopener noreferrer">Open the billing page</a>.
            </span>
          </p>
        )}
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          {b.plan === 'free' && (
            <button type="button" className="btn btn-primary" onClick={() => paywall.open('settings')}>
              Subscribe · {price}
            </button>
          )}
          {canManage && (
            <button type="button" className={`btn ${b.plan === 'free' ? 'btn-ghost' : 'btn-secondary'}`} onClick={() => void manage()} disabled={busy}>
              {busy && <Spinner />}
              {b.plan === 'free' ? 'Billing history' : 'Manage billing'}
            </button>
          )}
        </div>
        {canManage && <p className="hint" style={{ margin: 0 }}>Opens Stripe in {NEW_TAB}, where you can change your card, download receipts or cancel.</p>}
      </div>
      <div className="notice" style={{ maxWidth: 620, marginTop: 16 }}>
        <ShieldIcon size={18} />
        <span>Payments are handled by Stripe. Kagimo never sees your card, and Stripe never sees your journal.</span>
      </div>
    </>
  );
}
