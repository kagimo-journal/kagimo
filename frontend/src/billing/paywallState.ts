/**
 * Shared state for the upgrade dialog. Non-React code (the sync engine) can open it, and
 * anything can listen for "the account just became paid".
 */
import { desktop } from '../desktop/bridge';
import { useSyncExternalStore } from 'react';
import type { Billing, PlanInfo, Price } from '../api/types';

/** 'sync': the server refused a change because the free space is full. */
export type PaywallReason = 'sync' | 'settings';

let open: PaywallReason | null = null;
const listeners = new Set<() => void>();
const subscribedListeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export const paywall = {
  open(reason: PaywallReason) {
    if (open) return;
    open = reason;
    emit();
  },
  close() {
    open = null;
    emit();
  },
  /** Called once a payment has gone through. */
  subscribed() {
    subscribedListeners.forEach((l) => l());
  },
  onSubscribed(l: () => void): () => void {
    subscribedListeners.add(l);
    return () => subscribedListeners.delete(l);
  },
};

export function usePaywall(): PaywallReason | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
  );
}

/** True when the server takes nothing new from this account (free space or fair-use cap reached). */
export function isFull(b: Billing | undefined): boolean {
  return !!b && b.enabled && b.full;
}

/** "$5" */
export function formatAmount(p: Pick<Price, 'amount' | 'currency'>): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: p.currency.toUpperCase(),
    minimumFractionDigits: p.amount % 100 === 0 ? 0 : 2,
  }).format(p.amount / 100);
}

/** "$5 / month" */
export function formatPrice(p: Price): string {
  return `${formatAmount(p)} / ${p.interval}`;
}

/** "14 December 2026" */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Why a full free account takes nothing new: its free period ended, or its space filled. */
export function freeFullText(b: Pick<Billing, 'freeOver'>): string {
  return b.freeOver ? 'Your free sync period is over.' : 'Your free sync space is full.';
}

/** "$5 / month or $40 / year" */
export function priceLabel(plan: PlanInfo | undefined): string {
  if (!plan?.enabled) return '';
  return plan.prices.map(formatPrice).join(' or ');
}

/** "Save 33%": how much the yearly price saves over twelve months, or '' if it doesn't. */
export function yearlySaving(prices: Price[]): string {
  const m = prices.find((p) => p.interval === 'month');
  const y = prices.find((p) => p.interval === 'year');
  if (!m || !y || m.currency !== y.currency) return '';
  const pct = Math.round(100 * (1 - y.amount / (12 * m.amount)));
  return pct > 0 ? `Save ${pct}%` : '';
}

/**
 * Opens a Stripe page in a new tab. The journal's keys live only in this tab's memory, so
 * navigating this tab away would lock it. The tab is opened synchronously (inside the click)
 * so pop-up blockers allow it, then pointed at the URL once the server has made one.
 * Returns false if the browser blocked the tab, in which case the caller shows a link.
 */
export async function openInNewTab(getUrl: () => Promise<{ url: string }>): Promise<{ opened: boolean; url: string }> {
  if (desktop) {
    // The desktop app has no tabs: the page opens in the person's browser.
    const { url } = await getUrl();
    return { opened: await desktop.openExternal(url).then(() => true, () => false), url };
  }
  const tab = window.open('about:blank', '_blank');
  try {
    const { url } = await getUrl();
    if (tab && !tab.closed) {
      tab.opener = null;
      tab.location.href = url;
      return { opened: true, url };
    }
    return { opened: false, url };
  } catch (e) {
    tab?.close();
    throw e;
  }
}
