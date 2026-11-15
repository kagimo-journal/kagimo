import { desktop, NEW_TAB } from '../desktop/bridge';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, isApiError } from '../api/client';
import { billing as billingApi } from '../api/endpoints';
import type { Interval } from '../api/types';
import { Dialog } from '../components/Dialog';
import { CheckIcon } from '../components/Icons';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { formatBytes } from '../lib/format';
import { useAuth } from '../state/auth';
import { formatAmount, formatPrice, freeFullText, longDate, openInNewTab, paywall, usePaywall, yearlySaving } from './paywallState';

const POLL_MS = 3000;
const POLL_FOR_MS = 30 * 60 * 1000;

/** offer → Checkout in a new tab → waiting → done. */
type Step = 'offer' | 'waiting' | 'done';

/**
 * The upgrade dialog. Stripe's Checkout opens in a new tab: this tab holds the journal's keys and
 * must stay put, and none of Stripe's code ever runs in it. The dialog then asks the server to
 * re-check the subscription until Stripe confirms it.
 */
export function Paywall() {
  const reason = usePaywall();
  const { config, me, refresh } = useAuth();
  const toast = useToast();
  const [step, setStep] = useState<Step>('offer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [interval, setInterval_] = useState<Interval>('year');
  const startedAt = useRef(0);

  const plan = config?.billing;
  const prices = plan?.enabled ? plan.prices : [];
  const chosen = prices.find((p) => p.interval === interval) ?? prices[0];
  const free = formatBytes(me?.billing.freeBytes ?? (plan?.enabled ? plan.freeBytes : 0));
  const freeDays = plan?.enabled ? plan.freeDays : 30;
  const paidSpace = formatBytes(plan?.enabled ? plan.paidBytes : 0);
  const saving = yearlySaving(prices);

  useEffect(() => {
    if (reason) {
      setStep('offer');
      setError(null);
      setFallbackUrl(null);
    }
  }, [reason]);

  const check = useCallback(async () => {
    try {
      const b = await billingApi.sync();
      if (b.plan !== 'free') {
        await refresh();
        setStep('done');
        paywall.subscribed();
        return true;
      }
    } catch {
      /* offline or rate limited: try again next tick */
    }
    return false;
  }, [refresh]);

  useEffect(() => {
    if (step !== 'waiting') return;
    let stopped = false;
    const tick = () => {
      if (stopped || document.visibilityState !== 'visible') return;
      if (Date.now() - startedAt.current > POLL_FOR_MS) return;
      void check();
    };
    const id = setInterval(tick, POLL_MS);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      stopped = true;
      clearInterval(id);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [step, check]);

  const subscribe = async () => {
    if (!chosen) return;
    setError(null);
    setBusy(true);
    try {
      const { opened, url } = await openInNewTab(() => billingApi.checkout(chosen.interval));
      setFallbackUrl(opened ? null : url);
      startedAt.current = Date.now();
      setStep('waiting');
    } catch (e) {
      if (isApiError(e, 'already_subscribed')) {
        await check();
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (step === 'done') toast.show(`Thanks for subscribing. Your journal now has ${paidSpace} of sync space.`);
    paywall.close();
  };

  if (!plan?.enabled || !chosen) return null;

  const title =
    step === 'done'
      ? "You're subscribed"
      : step === 'waiting'
        ? desktop ? 'Finish in your browser' : 'Finish in the new tab'
        : 'Keep writing with Kagimo';

  let body;
  if (step === 'done') {
    body = (
      <div className="stack paywall" style={{ gap: 16 }}>
        <div className="badge-circle" style={{ alignSelf: 'center' }}>
          <CheckIcon size={26} strokeWidth={2} />
        </div>
        <p className="lede center-text">
          Thank you. Your subscription is active{me?.billing.full || reason === 'sync' ? ' and your journal is syncing again' : ''}.
        </p>
      </div>
    );
  } else if (step === 'waiting') {
    body = (
      <div className="stack paywall" style={{ gap: 16 }}>
        <p>
          Stripe's secure checkout opened in {NEW_TAB}. Pay there, then come back here. This window updates by itself, and your journal stays
          unlocked in the meantime.
        </p>
        {fallbackUrl && (
          <p className="notice">
            <span>
              Your browser blocked the new tab.{' '}
              <a href={fallbackUrl} target="_blank" rel="noopener noreferrer">
                Open checkout
              </a>
              .
            </span>
          </p>
        )}
        <p className="hint row" style={{ gap: 8 }} role="status">
          <Spinner /> Waiting for confirmation from Stripe…
        </p>
      </div>
    );
  } else {
    body = (
      <div className="stack paywall" style={{ gap: 16 }}>
        <p>
          {me?.billing.full
            ? freeFullText(me.billing)
            : me?.billing.freeUntil
              ? `Sync is free until ${longDate(me.billing.freeUntil)}, for up to ${free}.`
              : `Sync is free for the first ${freeDays} days, for up to ${free}.`}{' '}
          Subscribe for {paidSpace} of space, enough for a lifetime of daily writing.
          {me?.billing.full && ' Nothing is lost: new writing stays on this device and syncs as soon as you subscribe.'}
        </p>
        {prices.length > 1 && (
          <div className="plan-choice" role="radiogroup" aria-label="Billing period">
            {prices.map((p) => (
              <label key={p.interval} className={`plan-option${p.interval === chosen.interval ? ' selected' : ''}`}>
                <input type="radio" name="interval" value={p.interval} checked={p.interval === chosen.interval} onChange={() => setInterval_(p.interval)} />
                <span className="plan-option-name">{p.interval === 'year' ? 'Yearly' : 'Monthly'}</span>
                <span className="plan-option-price">
                  <strong>{formatAmount(p)}</strong> / {p.interval}
                </span>
                {p.interval === 'year' && saving && <span className="plan-option-note">{saving}</span>}
              </label>
            ))}
          </div>
        )}
        <ul className="checklist">
          <li><CheckIcon strokeWidth={2} />{paidSpace} for your entries, on all your devices</li>
          <li><CheckIcon strokeWidth={2} />Still end-to-end encrypted. Payment details go to Stripe, never to Kagimo</li>
          <li><CheckIcon strokeWidth={2} />Cancel any time. Your entries stay yours to read and export</li>
        </ul>
        <p className="hint" style={{ margin: 0 }}>
          Renews automatically until you cancel. By subscribing you agree to the{' '}
          <a href="/terms" target="_blank" rel="noopener">Terms of Service</a>.
        </p>
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>
    );
  }

  const actions =
    step === 'done' ? (
      <button type="button" className="btn btn-primary" onClick={close} disabled={busy}>
        {busy && <Spinner />}Continue writing
      </button>
    ) : step === 'waiting' ? (
      <>
        <button type="button" className="btn btn-ghost" onClick={close} disabled={busy}>Close</button>
        <button type="button" className="btn btn-secondary" onClick={() => void subscribe()} disabled={busy}>
          {busy && <Spinner />}Reopen checkout
        </button>
      </>
    ) : (
      <>
        <button type="button" className="btn btn-ghost" onClick={close} disabled={busy}>Not now</button>
        <button type="button" className="btn btn-primary" onClick={() => void subscribe()} disabled={busy}>
          {busy && <Spinner />}Continue · {formatPrice(chosen)}
        </button>
      </>
    );

  return (
    <Dialog open={!!reason} title={title} onClose={close} actions={actions} className="paywall-dialog">
      {body}
    </Dialog>
  );
}
