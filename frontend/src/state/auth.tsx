import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { isApiError, NetworkError, setSecondFactorHandler, setUnauthorizedHandler } from '../api/client';
import { auth as authApi, getConfig, getMe } from '../api/endpoints';
import type { Config, Me } from '../api/types';
import { desktop } from '../desktop/bridge';
import { currentVault, refreshVaultFromMe, useVault } from '../local/vault';
import { refreshSyncPhase, sessionRestored } from '../sync/engine';

/**
 * The server session, which only matters for sync (SPEC §10): the journal itself never waits for
 * it. `me` is the sync account when this device is signed in to one.
 */
interface AuthState {
  /** undefined while loading, null when it couldn't be fetched (offline). */
  config: Config | null | undefined;
  /** undefined while loading, null when signed out or offline. */
  me: Me | null | undefined;
  setMe: (me: Me | null) => void;
  refresh: () => Promise<Me | null>;
  /** Re-reads the server's configuration (the desktop app, after pointing it at another server). */
  reloadConfig: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

const RETURNING_KEY = 'kagimo.returning';

/** Whether this browser has had a signed-in account before (a non-sensitive UI hint, no identity). */
export function isReturningBrowser(): boolean {
  try {
    return localStorage.getItem(RETURNING_KEY) === '1';
  } catch {
    return false;
  }
}

function markReturningBrowser() {
  try {
    localStorage.setItem(RETURNING_KEY, '1');
  } catch {
    /* storage blocked: first-time visitors just keep landing on sign-up */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<Config | null | undefined>(undefined);
  const [me, setMeState] = useState<Me | null | undefined>(undefined);

  const setMe = useCallback((next: Me | null) => {
    if (next) {
      markReturningBrowser();
      // The device's copy of the account's keys and status follows the server's.
      void refreshVaultFromMe(next).then((changed) => {
        if (currentVault()?.account?.userId === String(next.id)) sessionRestored(changed);
      });
    }
    setMeState(next);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const m = await getMe();
      setMe(m);
      return m;
    } catch (e) {
      if (isApiError(e, undefined, 401) || isApiError(e, undefined, 403)) {
        setMe(null);
        return null;
      }
      if (e instanceof NetworkError || isApiError(e, 'unavailable')) {
        // Offline: the journal works regardless; sync tries again later.
        setMeState((cur) => (cur === undefined ? null : cur));
        return null;
      }
      throw e;
    }
  }, [setMe]);

  const vault = useVault();
  const vaultId = vault?.id;
  /**
   * The desktop app has no server of its own, so it stays silent until there's a reason to talk to
   * one: the journal syncs, or the person opens the sign-in or sync set-up form (which re-read the
   * configuration themselves, see ServerChoice).
   */
  const silent = !!desktop && vault !== undefined && !vault?.account;
  const reloadConfig = useCallback(() => getConfig().then(setConfig, () => setConfig(null)), []);
  // In a browser this runs once, at the start; the desktop app waits to know its journal.
  const configWhen = !desktop ? 'now' : vault === undefined ? 'wait' : silent ? 'never' : 'now';
  useEffect(() => {
    if (configWhen === 'now') void reloadConfig();
    else if (configWhen === 'never') setConfig((cur) => (cur === undefined ? null : cur));
  }, [reloadConfig, configWhen]);
  useEffect(() => {
    // Once the device's journal is known: a synced one (or none yet, for a session from before
    // journals lived on devices) asks the server who is signed in.
    if (vault === undefined) return;
    if (silent) return setMeState((cur) => (cur === undefined ? null : cur));
    refresh().catch(() => setMeState(null));
  }, [refresh, vault === undefined, vaultId, silent]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setMe(null);
      refreshSyncPhase();
    });
    return () => setUnauthorizedHandler(null);
  }, [setMe]);

  // 403 second_factor_required: the account has no passkey or TOTP (any more); Sync settings
  // explain it once /api/me is current (SPEC §5.1).
  useEffect(() => {
    let inFlight = false;
    setSecondFactorHandler(() => {
      if (inFlight) return;
      inFlight = true;
      void refresh()
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    });
    return () => setSecondFactorHandler(null);
  }, [refresh]);

  /** Ends the server session (the journal on this device is not touched). */
  const signOut = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setMe(null);
    }
  }, [setMe]);

  const value = useMemo(() => ({ config, me, setMe, refresh, reloadConfig, signOut }), [config, me, setMe, refresh, reloadConfig, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

/**
 * Whether this visitor has been here before: this browser has signed in, or carries the server's
 * device cookie. Public pages then lead with "Sign in" instead of "Start writing".
 */
export function useReturningVisitor(): boolean {
  const { config } = useAuth();
  return isReturningBrowser() || !!config?.returning;
}

/** For pages behind the session guard: `me` is guaranteed. */
export function useMe(): Me {
  const { me } = useAuth();
  if (!me) throw new Error('useMe without a session');
  return me;
}
