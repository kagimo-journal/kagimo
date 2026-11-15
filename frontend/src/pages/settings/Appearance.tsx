import { desktop } from '../../desktop/bridge';
import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { XIcon } from '../../components/Icons';
import { ConfirmDialog } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import { useMediaQuery } from '../../lib/hooks';
import { loadPlaces } from '../../location/geocode';
import { type LocationSetting, useSettings } from '../../state/settings';
import { mix } from '../../theme/color';
import { importThemeFile, ThemeImportError } from '../../theme/import';
import { allThemes, DEFAULT_DARK, DEFAULT_LIGHT, findTheme, type Mode, type Theme, type ThemeKind } from '../../theme/themes';
import { loadWritingFont, WRITING_FONTS, WRITING_LEADINGS, WRITING_SIZES, type WritingFontId, type WritingSettings } from '../../theme/writing';
import { SettingsPage, useSubPage } from './SettingsPage';

const MODES: { value: Mode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const LOCATIONS: { value: LocationSetting; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'city', label: 'City' },
  { value: 'neighbourhood', label: 'Neighbourhood' },
];

const MAPPING = [
  { vs: 'editor.background', b16: 'base00', token: 'Paper' },
  { vs: 'sideBar.background', b16: 'base01', token: 'Surface' },
  { vs: 'editor.foreground', b16: 'base05', token: 'Ink' },
  { vs: 'descriptionForeground', b16: 'base04', token: 'Muted' },
  { vs: 'panel.border', b16: 'base02', token: 'Hairline' },
  { vs: 'button.background', b16: 'base0D', token: 'Accent' },
  { vs: 'errorForeground', b16: 'base08', token: 'Danger' },
];

function Segmented<T extends string>({ label, value, options, onChange, small }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; small?: boolean }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + options.length) % options.length;
    onChange(options[n].value);
    refs.current[n]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={`segmented${small ? ' sm' : ''}`}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Old tab links (`/settings/appearance#writing`) now have sub-pages of their own. */
const OLD_TABS: Record<string, string> = { '#writing': 'typeface', '#entry-details': 'entry-details' };

const FONT_GROUPS = ['Classic serifs', 'Modern serifs', 'Sans & mono'] as const;
const SAMPLE = 'The river was higher than I expected.';

/** Writing face picker: a radiogroup of sample lines, each set in its own face. */
function FontPicker({ value, onChange }: { value: WritingFontId; onChange: (id: WritingFontId) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  // Every face's CSS is loaded only once the picker is (nearly) on screen.
  useEffect(() => {
    const el = box.current;
    const loadAll = () => WRITING_FONTS.forEach((f) => void loadWritingFont(f.id));
    if (!el || typeof IntersectionObserver === 'undefined') return loadAll();
    const io = new IntersectionObserver(
      (seen) => {
        if (!seen.some((e) => e.isIntersecting)) return;
        io.disconnect();
        loadAll();
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const onKey = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + WRITING_FONTS.length) % WRITING_FONTS.length;
    onChange(WRITING_FONTS[n].id);
    refs.current[n]?.focus();
  };

  return (
    <div ref={box} role="radiogroup" aria-label="Typeface" className="font-picker">
      {FONT_GROUPS.map((group) => (
        <div key={group} className="font-group" role="presentation">
          <span className="eyebrow" aria-hidden>{group}</span>
          <div className="font-grid" role="presentation">
            {WRITING_FONTS.map((f, i) =>
              f.group !== group ? null : (
                <button
                  key={f.id}
                  ref={(el) => {
                    refs.current[i] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={value === f.id}
                  tabIndex={value === f.id ? 0 : -1}
                  className="font-option"
                  onClick={() => onChange(f.id)}
                  onKeyDown={(e) => onKey(e, i)}
                >
                  <span className="font-name">{f.name}</span>
                  <span className="font-sample" style={{ fontFamily: f.family }} aria-hidden>
                    {SAMPLE}
                  </span>
                </button>
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function ThemeCard({ theme, selected, onPick, onRemove }: { theme: Theme; selected: boolean; onPick: () => void; onRemove?: () => void }) {
  const t = theme.tokens;
  const previewMuted = mix(t.muted, t.paper, 0.35);
  const tag = theme.id === DEFAULT_LIGHT || theme.id === DEFAULT_DARK ? 'Default' : theme.builtIn ? '' : 'Imported';
  return (
    <div className="theme-card">
      <button type="button" className="pick" aria-pressed={selected} onClick={onPick} aria-label={`${theme.name}${tag ? ` (${tag})` : ''}`}>
        <div className="theme-swatch" style={{ background: t.paper }} aria-hidden>
          <span style={{ width: '70%', height: 8, background: t.ink }} />
          <span style={{ width: '90%', height: 5, background: previewMuted }} />
          <span style={{ width: '60%', height: 5, background: previewMuted }} />
          <span style={{ width: 28, height: 10, borderRadius: 5, background: t.accent, marginTop: 'auto' }} />
        </div>
        <div className="theme-name">
          <span>{theme.name}</span>
          {tag && <span className="tag">{tag}</span>}
        </div>
      </button>
      {onRemove && (
        <button type="button" className="remove" aria-label={`Delete theme ${theme.name}`} onClick={onRemove}>
          <XIcon size={10} />
        </button>
      )}
    </div>
  );
}

export default function Appearance() {
  const { settings, update } = useSettings();
  const toast = useToast();
  const location = useLocation();
  const { sub, redirect } = useSubPage('appearance');
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Theme | null>(null);
  const [placesMissing, setPlacesMissing] = useState(false);
  const [geoDenied, setGeoDenied] = useState(false);


  const themes = allThemes(settings.customThemes);
  const light = findTheme(settings.lightTheme, settings.customThemes, 'light');
  const dark = findTheme(settings.darkTheme, settings.customThemes, 'dark');
  const activeName =
    settings.mode === 'dark' ? dark.name : settings.mode === 'light' ? light.name : `${systemDark ? dark.name : light.name} (system is ${systemDark ? 'dark' : 'light'})`;

  const setWriting = (patch: Partial<WritingSettings>) => update((s) => ({ ...s, writing: { ...s.writing, ...patch } }));

  const pick = (kind: ThemeKind, id: string) => update((s) => (kind === 'light' ? { ...s, lightTheme: id } : { ...s, darkTheme: id }));

  const importFile = async (file: File) => {
    setImportError(null);
    if (file.size > 2_000_000) return setImportError('That file is too large to be a theme.');
    try {
      const theme = importThemeFile(file.name, await file.text());
      update((s) => ({
        ...s,
        customThemes: [...s.customThemes, theme],
        ...(theme.kind === 'light' ? { lightTheme: theme.id } : { darkTheme: theme.id }),
      }));
      toast.show(`Imported “${theme.name}” as a ${theme.kind} theme.`);
    } catch (e) {
      setImportError(e instanceof ThemeImportError ? e.message : "We couldn't read that file as a theme.");
    }
  };

  const removeTheme = () => {
    if (!removing) return;
    const id = removing.id;
    update((s) => ({
      ...s,
      customThemes: s.customThemes.filter((t) => t.id !== id),
      lightTheme: s.lightTheme === id ? DEFAULT_LIGHT : s.lightTheme,
      darkTheme: s.darkTheme === id ? DEFAULT_DARK : s.darkTheme,
    }));
    setRemoving(null);
  };

  const setLocation = (v: LocationSetting) => {
    update((s) => ({ ...s, details: { ...s.details, location: v } }));
    if (v === 'off') return;
    // Ask for permission now, so new entries don't prompt mid-sentence. The position is discarded.
    navigator.geolocation?.getCurrentPosition(
      () => setGeoDenied(false),
      (err) => setGeoDenied(err.code === err.PERMISSION_DENIED),
      { maximumAge: 600000, timeout: 15000 },
    );
    void loadPlaces().then((d) => setPlacesMissing(!d));
  };

  const setWeather = (on: boolean) => {
    update((s) => ({ ...s, details: { ...s.details, weather: on } }));
    if (!on) return;
    navigator.geolocation?.getCurrentPosition(
      () => setGeoDenied(false),
      (err) => setGeoDenied(err.code === err.PERMISSION_DENIED),
      { maximumAge: 600000, timeout: 15000 },
    );
  };

  const grid = (kind: ThemeKind) => (
    <div className="stack" style={{ gap: 10 }}>
      <span className="eyebrow">{kind === 'light' ? 'Light' : 'Dark'}</span>
      <div className="theme-grid">
        {themes
          .filter((t) => t.kind === kind)
          .map((t) => (
            <ThemeCard
              key={t.id}
              theme={t}
              selected={(kind === 'light' ? light.id : dark.id) === t.id}
              onPick={() => pick(kind, t.id)}
              onRemove={t.builtIn ? undefined : () => setRemoving(t)}
            />
          ))}
      </div>
    </div>
  );

  if (redirect) return redirect;
  if (!sub && OLD_TABS[location.hash]) return <Navigate to={`/settings/appearance/${OLD_TABS[location.hash]}`} replace />;

  let page: React.ReactNode;
  if (sub === 'import') {
    page = (
      <SettingsPage title="Import a theme">
        <div className="row" style={{ flexWrap: 'wrap', gap: 24, alignItems: 'stretch' }}>
          <div
            className={`import-box${dragging ? ' dragging' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files[0];
              if (f) void importFile(f);
            }}
          >
            <p className="lede" style={{ fontSize: 14, lineHeight: 1.55 }}>
              Drop a VS Code colour theme (<span className="mono" style={{ fontSize: 13 }}>.json</span>) or a base16 scheme (
              <span className="mono" style={{ fontSize: 13 }}>.yaml</span>). We read its colours and fit them to the journal. Text that's too faint is
              darkened until it's easy to read.
            </p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileInput.current?.click()}>
              Choose file…
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,.jsonc,.yaml,.yml,application/json,text/yaml"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void importFile(f);
              }}
            />
            {importError && <p className="error-text" role="alert">{importError}</p>}
          </div>
          <div className="mapping">
            <span className="eyebrow">How colours map</span>
            <div className="mapping-grid" role="table" aria-label="How imported colours map to journal colours">
              <span className="muted" role="columnheader">VS Code key</span>
              <span className="muted" role="columnheader">base16</span>
              <span className="muted" role="columnheader">Kagimo</span>
              {MAPPING.map((r) => (
                <div key={r.token} role="row" style={{ display: 'contents' }}>
                  <span className="mono" role="cell">{r.vs}</span>
                  <span className="mono" role="cell">{r.b16}</span>
                  <span role="cell" style={{ fontWeight: 500 }}>{r.token}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </SettingsPage>
    );
  } else if (sub === 'typeface') {
    page = (
      <SettingsPage title="Typeface" lede="The typeface of your entries, on every device you use.">
        <FontPicker value={settings.writing.font} onChange={(font) => setWriting({ font })} />
        <p className="hint">
          Every typeface is stored on this server; nothing is fetched from a font service. All are licensed under the{' '}
          <a href="https://openfontlicense.org/" target="_blank" rel="noopener noreferrer">SIL Open Font License 1.1</a>.
        </p>
      </SettingsPage>
    );
  } else if (sub === 'text') {
    page = (
      <SettingsPage title="Text size" lede="The size and line spacing of your entries, on every device you use.">
        <div className="settings-box">
          <div className="settings-row">
            <span className="label-stack">
              <span className="t">Text size</span>
              <span className="d">Slightly smaller on phones.</span>
            </span>
            <Segmented label="Text size" small value={settings.writing.size} options={WRITING_SIZES} onChange={(size) => setWriting({ size })} />
          </div>
          <div className="settings-row">
            <span className="label-stack">
              <span className="t">Line spacing</span>
            </span>
            <Segmented label="Line spacing" small value={settings.writing.leading} options={WRITING_LEADINGS} onChange={(leading) => setWriting({ leading })} />
          </div>
        </div>
        <div className="writing-preview" aria-label="Preview">
          <p className="writing-preview-title">A long walk after the rain</p>
          <p>
            The river was higher than I expected, brown and fast under the footbridge. I stood there longer than I meant to, watching
            the light go, and thought about nothing in particular.
          </p>
        </div>
      </SettingsPage>
    );
  } else if (sub === 'entry-details') {
    page = (
      <SettingsPage
        title="Entry details"
        lede="Added to each new entry automatically, and encrypted with it. You can remove any detail from a single entry."
      >
        <div className="settings-box">
          <label className="settings-row">
            <span className="label-stack">
              <span className="t">Date and time</span>
              <span className="d">From your device's clock and time zone.</span>
            </span>
            <input
              type="checkbox"
              checked={settings.details.datetime}
              onChange={(e) => update((s) => ({ ...s, details: { ...s.details, datetime: e.target.checked } }))}
            />
          </label>
          {/* The desktop app can't tell where the computer is, so it offers neither place nor weather. */}
          {!desktop && <div className="settings-row">
            <span className="label-stack" style={{ maxWidth: 380 }}>
              <span className="t" id="loc-label">Location</span>
              <span className="d">Your browser will ask for permission once. Places are looked up on this device; coordinates aren't kept.</span>
            </span>
            <Segmented label="Location detail" small value={settings.details.location} options={LOCATIONS} onChange={setLocation} />
          </div>}
          {!desktop && <label className="settings-row">
            <span className="label-stack" style={{ maxWidth: 380 }}>
              <span className="t">Weather</span>
              <span className="d">
                A little icon and a word or two, like "Partly cloudy". Your browser asks Open-Meteo for it with your position rounded to about
                11&nbsp;km; this server never sees it.
              </span>
            </span>
            <input type="checkbox" checked={settings.details.weather} onChange={(e) => setWeather(e.target.checked)} />
          </label>}
          <label className="settings-row">
            <span className="label-stack" style={{ maxWidth: 380 }}>
              <span className="t">Divider when you come back</span>
              <span className="d">
                Writing more at the end of an entry after a few hours away adds a section divider, with the time beside it.
              </span>
            </span>
            <input
              type="checkbox"
              checked={settings.returnDividers}
              onChange={(e) => update((s) => ({ ...s, returnDividers: e.target.checked }))}
            />
          </label>
        </div>
        {!desktop && (settings.details.location !== 'off' || settings.details.weather) && geoDenied && (
          <p className="hint" role="status">Location permission is blocked in this browser, so new entries won't get a place or weather.</p>
        )}
        {!desktop && settings.details.location !== 'off' && placesMissing && (
          <p className="hint" role="status">Place data isn't installed on this server, so new entries won't get a place.</p>
        )}
        <p className="hint">
          Place names from <a href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer">GeoNames</a>, licensed under{' '}
          <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>. The place list is downloaded
          in full, so the server never learns where you are.
        </p>
        {settings.details.weather && (
          <p className="hint">
            Weather data by <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo</a>, licensed under{' '}
            <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>.
          </p>
        )}
      </SettingsPage>
    );
  } else {
    page = (
      <SettingsPage
        title="Theme"
        lede={
          <>
            Pick one theme for light and one for dark. Now showing: <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>{activeName}</strong>
          </>
        }
      >
        <div className="row" style={{ gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <Segmented label="Mode" value={settings.mode} options={MODES} onChange={(m) => update((s) => ({ ...s, mode: m }))} />
          <span className="hint">System follows your device's light and dark setting.</span>
        </div>
        {grid('light')}
        {grid('dark')}
      </SettingsPage>
    );
  }

  return (
    <>
      {page}
      <ConfirmDialog
        open={!!removing}
        title="Delete this theme?"
        body={<>“{removing?.name}” will be removed. If it's in use, the default theme takes its place.</>}
        confirmLabel="Delete theme"
        danger
        onConfirm={removeTheme}
        onCancel={() => setRemoving(null)}
      />
    </>
  );
}
