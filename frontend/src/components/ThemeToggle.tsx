import { useMediaQuery } from '../lib/hooks';
import { useSettings } from '../state/settings';
import { MoonIcon, SunIcon } from './Icons';

/** One-tap switch between the light and dark theme (leaves "match system" behind). */
export function ThemeToggle({ size = 18 }: { size?: number }) {
  const { settings, update } = useSettings();
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const dark = settings.mode === 'system' ? systemDark : settings.mode === 'dark';
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <button type="button" className="icon-btn" aria-label={label} title={label} onClick={() => update((s) => ({ ...s, mode: dark ? 'light' : 'dark' }))}>
      {dark ? <SunIcon size={size} /> : <MoonIcon size={size} />}
    </button>
  );
}
