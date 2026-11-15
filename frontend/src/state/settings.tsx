import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../api/client';
import { decryptSettings, encryptSettings } from '../crypto/content';
import { isPinWrap, type PinWrap } from '../crypto/pin';
import { setIdleTimeout, setPinUnlock } from '../crypto/session';
import { emitLocal, getSettingsRecord, onLocalEvent, saveLocalSettings } from '../local/repo';
import { useVault } from '../local/vault';
import { applyTheme, buildStoredTheme } from '../theme/apply';
import { DEFAULT_DARK, DEFAULT_LIGHT, isValidTheme, type CustomTheme, type Mode } from '../theme/themes';
import { DEFAULT_WRITING, normaliseWriting, type WritingSettings } from '../theme/writing';
import { useUnlocked } from './lock';

export type LocationSetting = 'off' | 'city' | 'neighbourhood';

/** Plaintext settings payload (SPEC §4); stored encrypted with AAD `settings:<userId>`. */
export interface Settings {
  v: 1;
  mode: Mode;
  lightTheme: string;
  darkTheme: string;
  customThemes: CustomTheme[];
  /** `weather` is missing in settings saved before it existed (reads as off). */
  details: { datetime: boolean; location: LocationSetting; weather: boolean };
  /** Writing typography; global, not per theme. Missing in settings saved before it existed. */
  writing: WritingSettings;
  /** Year book covers, keyed by year ("2025"). Missing in settings saved before it existed. */
  books: Record<string, BookCover>;
  /** Minutes without activity before the journal locks; 0 = never. Missing reads as 5. */
  autoLock: AutoLock;
  /** PIN unlock; null when off. Missing in settings saved before it existed. */
  pin: PinSetting | null;
  /**
   * Coming back to an entry after a few hours and writing on at its end adds a section divider with
   * the time. Missing in settings saved before it existed (reads as on).
   */
  returnDividers: boolean;
  /**
   * Counts the changes made to these settings. A device refuses a copy from the server that is
   * older than the one it has (sync/engine.ts), so a replayed old blob can't bring back an old
   * PIN, auto-lock choice or location setting. Missing in settings saved before it existed.
   */
  n: number;
}

/**
 * The master key wrapped under the PIN, and how long the journal may be inactive before the PIN
 * stops working and the passphrase is needed. Safe to keep here: settings are sealed under the
 * content key, so reading this needs the journal unlocked already.
 */
export interface PinSetting extends PinWrap {
  fullUnlockAfter: PinGrace;
}

export const PIN_GRACE_OPTIONS = [
  { minutes: 15, label: '15 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 240, label: '4 hours' },
  { minutes: 720, label: '12 hours' },
  { minutes: 1440, label: '1 day' },
] as const;

export type PinGrace = (typeof PIN_GRACE_OPTIONS)[number]['minutes'];
export const DEFAULT_PIN_GRACE: PinGrace = 60;

function normalisePin(v: unknown): PinSetting | null {
  if (!isPinWrap(v)) return null;
  const grace = PIN_GRACE_OPTIONS.find((o) => o.minutes === (v as Partial<PinSetting>).fullUnlockAfter)?.minutes ?? DEFAULT_PIN_GRACE;
  return { salt: v.salt, nonce: v.nonce, ct: v.ct, fullUnlockAfter: grace };
}

/** Hands the PIN setting to the in-memory key store, which uses it when the journal locks. */
function applyPin(pin: PinSetting | null) {
  setPinUnlock(pin ? { wrap: { salt: pin.salt, nonce: pin.nonce, ct: pin.ct }, graceMs: pin.fullUnlockAfter * 60_000 } : null);
}

export const AUTO_LOCK_OPTIONS = [
  { minutes: 1, label: '1 minute' },
  { minutes: 5, label: '5 minutes' },
  { minutes: 15, label: '15 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 0, label: 'Never' },
] as const;

export type AutoLock = (typeof AUTO_LOCK_OPTIONS)[number]['minutes'];
export const DEFAULT_AUTO_LOCK: AutoLock = 5;

function normaliseAutoLock(v: unknown): AutoLock {
  return AUTO_LOCK_OPTIONS.find((o) => o.minutes === v)?.minutes ?? DEFAULT_AUTO_LOCK;
}

const AUTO_LOCK_PREF = 'kagimo.autoLock';

/**
 * The last auto-lock choice, kept in plain storage too (it isn't sensitive) so it applies from the
 * moment of unlocking, before the encrypted settings are read.
 */
export function storedAutoLock(): AutoLock {
  try {
    const raw = localStorage.getItem(AUTO_LOCK_PREF);
    return raw === null ? DEFAULT_AUTO_LOCK : normaliseAutoLock(Number(raw));
  } catch {
    return DEFAULT_AUTO_LOCK;
  }
}

/** Applies the auto-lock choice to the in-memory key store. */
export function applyAutoLock(minutes: AutoLock) {
  setIdleTimeout(minutes === 0 ? null : minutes * 60_000);
  try {
    localStorage.setItem(AUTO_LOCK_PREF, String(minutes));
  } catch {
    /* storage blocked: the default applies until settings are decrypted */
  }
}

if (typeof window !== 'undefined') {
  const m = storedAutoLock();
  setIdleTimeout(m === 0 ? null : m * 60_000);
}

export const CLOTHS = [
  { id: 'ink', name: 'Ink blue', hex: '#2F4F6B', foil: '#E9DFC8' },
  { id: 'oxblood', name: 'Oxblood', hex: '#6B2F2A', foil: '#E9DFC8' },
  { id: 'bottle', name: 'Bottle green', hex: '#33503F', foil: '#E9DFC8' },
  { id: 'ochre', name: 'Ochre', hex: '#8C6A2F', foil: '#E9DFC8' },
  { id: 'plum', name: 'Plum', hex: '#4A3D57', foil: '#E9DFC8' },
  { id: 'linen', name: 'Linen', hex: '#D9CFBE', foil: '#4A3F33' },
] as const;

export type ClothId = (typeof CLOTHS)[number]['id'];

export interface BookCover {
  title: string;
  cloth: ClothId;
}

export const BOOK_TITLE_MAX = 80;

/** A year's cover: the stored one, or an untitled cover in a cloth picked from the year. */
export function coverFor(books: Settings['books'], year: number): BookCover {
  return books[String(year)] ?? { title: '', cloth: CLOTHS[((year % CLOTHS.length) + CLOTHS.length) % CLOTHS.length].id };
}

export function normaliseBooks(raw: unknown): Record<string, BookCover> {
  const out: Record<string, BookCover> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [year, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{4}$/.test(year) || !v || typeof v !== 'object') continue;
    const { title, cloth } = v as { title?: unknown; cloth?: unknown };
    const c = CLOTHS.find((x) => x.id === cloth);
    out[year] = { title: typeof title === 'string' ? title.slice(0, BOOK_TITLE_MAX) : '', cloth: c ? c.id : 'ink' };
  }
  return out;
}

export const DEFAULT_SETTINGS: Settings = {
  v: 1,
  mode: 'system',
  lightTheme: DEFAULT_LIGHT,
  darkTheme: DEFAULT_DARK,
  customThemes: [],
  details: { datetime: true, location: 'off', weather: false },
  writing: DEFAULT_WRITING,
  books: {},
  autoLock: DEFAULT_AUTO_LOCK,
  pin: null,
  returnDividers: true,
  n: 0,
};

function normalise(raw: Partial<Settings> | null | undefined): Settings {
  const r = raw ?? {};
  const mode: Mode = r.mode === 'light' || r.mode === 'dark' ? r.mode : 'system';
  const loc = r.details?.location;
  return {
    v: 1,
    mode,
    lightTheme: typeof r.lightTheme === 'string' ? r.lightTheme : DEFAULT_LIGHT,
    darkTheme: typeof r.darkTheme === 'string' ? r.darkTheme : DEFAULT_DARK,
    customThemes: Array.isArray(r.customThemes) ? r.customThemes.filter(isValidTheme) : [],
    details: {
      datetime: r.details?.datetime !== false,
      location: loc === 'city' || loc === 'neighbourhood' ? loc : 'off',
      weather: r.details?.weather === true,
    },
    writing: normaliseWriting(r.writing),
    books: normaliseBooks(r.books),
    autoLock: normaliseAutoLock(r.autoLock),
    pin: normalisePin(r.pin),
    returnDividers: r.returnDividers !== false,
    n: typeof r.n === 'number' && Number.isSafeInteger(r.n) && r.n >= 0 ? r.n : 0,
  };
}

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  /** Set when the encrypted settings couldn't be loaded; saving is disabled so they aren't overwritten. */
  loadError: string | null;
  saveError: string | null;
  update: (fn: (s: Settings) => Settings) => void;
}

const SettingsContext = createContext<SettingsState | null>(null);

function themeFrom(s: Settings) {
  return buildStoredTheme(s.mode, s.lightTheme, s.darkTheme, s.customThemes, s.writing);
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const vault = useVault();
  const unlocked = useUnlocked();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadErrorRef = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vaultId = vault?.id ?? null;
  /** The id bound into the settings AAD (SPEC §3). */
  const aadId = vault?.aadId ?? null;
  /** Bumped when sync brings newer settings from another device. */
  const [generation, setGeneration] = useState(0);

  useEffect(() => onLocalEvent((e) => e.type === 'settings' && e.origin === 'sync' && setGeneration((g) => g + 1)), []);

  useEffect(() => {
    if (generation === 0) setLoaded(false);
    if (!unlocked || !vaultId || !aadId) return;
    let cancelled = false;
    (async () => {
      try {
        const rec = await getSettingsRecord(vaultId);
        const s = normalise(rec?.sealed ? await decryptSettings<Partial<Settings>>(aadId, rec.sealed) : null);
        if (cancelled) return;
        loadErrorRef.current = null;
        setLoadError(null);
        setSettings(s);
        applyTheme(themeFrom(s));
        applyAutoLock(s.autoLock);
        applyPin(s.pin);
      } catch (e) {
        if (cancelled) return;
        const msg = `Couldn't load your settings (${errorMessage(e)}). Changes won't be saved until you reload.`;
        loadErrorRef.current = msg;
        setLoadError(msg);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [unlocked, vaultId, aadId, generation]);

  const persist = useCallback(
    (s: Settings) => {
      if (!vaultId || !aadId || loadErrorRef.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        try {
          await saveLocalSettings(vaultId, await encryptSettings(aadId, s));
          emitLocal({ type: 'settings', origin: 'local' });
          setSaveError(null);
        } catch (e) {
          setSaveError(`Couldn't save settings: ${errorMessage(e)}`);
        }
      }, 400);
    },
    [vaultId, aadId],
  );

  const update = useCallback(
    (fn: (s: Settings) => Settings) => {
      setSettings((cur) => {
        const next = { ...normalise(fn(cur)), n: cur.n + 1 };
        applyTheme(themeFrom(next));
        applyAutoLock(next.autoLock);
        applyPin(next.pin);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const value = useMemo(() => ({ settings, loaded, loadError, saveError, update }), [settings, loaded, loadError, saveError, update]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsState {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings outside SettingsProvider');
  return ctx;
}
