/**
 * The settings menu. Each section is a top-level link; its sub-pages are listed under it in the side
 * nav while it's open. Every sub-page holds one group of settings, short enough to fit on a screen.
 * The first sub-page lives at the section's own address, so `/settings/sync` etc. keep working.
 */
import { desktop } from '../../desktop/bridge';

export type SubPage = { path: string; label: string };
export type Section = { path: string; label: string; subs: SubPage[] };

export function settingsSections({
  synced,
  needsPassword,
  billing = false,
  downloads = false,
}: {
  synced: boolean;
  needsPassword: boolean;
  billing?: boolean;
  /** The server offers desktop app installers (shown in a browser only). */
  downloads?: boolean;
}): Section[] {
  return [
    {
      path: 'sync',
      label: 'Sync & backup',
      subs: [
        { path: '', label: 'Sync' },
        { path: 'device', label: desktop ? 'Journal folder' : 'On this device' },
        ...(synced ? [{ path: 'server', label: 'What the server sees' }] : []),
        { path: 'sent', label: 'What this device sent' },
        synced ? { path: 'remove', label: 'Remove from this device' } : { path: 'delete', label: 'Delete journal' },
      ],
    },
    {
      path: 'security',
      label: 'Security',
      subs: needsPassword
        ? [{ path: '', label: 'Password' }]
        : [
            { path: '', label: 'Auto-lock' },
            { path: 'pin', label: 'PIN unlock' },
            { path: 'passphrase', label: 'Passphrase' },
            { path: 'recovery-key', label: 'Recovery key' },
            ...(synced
              ? [
                  { path: 'passkeys', label: 'Passkeys' },
                  { path: 'authenticator', label: 'Authenticator app' },
                ]
              : [{ path: 'sign-in', label: 'Two-factor sign-in' }]),
          ],
    },
    {
      path: 'appearance',
      label: 'Appearance',
      subs: [
        { path: '', label: 'Theme' },
        { path: 'import', label: 'Import a theme' },
        { path: 'typeface', label: 'Typeface' },
        { path: 'text', label: 'Text size' },
        { path: 'entry-details', label: 'Entry details' },
      ],
    },
    { path: 'export', label: 'Export', subs: [] },
    ...(billing ? [{ path: 'subscription', label: 'Subscription', subs: [] }] : []),
    ...(downloads && !desktop ? [{ path: 'desktop', label: 'Desktop app', subs: [] }] : []),
  ];
}

/** Whether `sub` (the optional URL segment) names one of the section's sub-pages. */
export function isSubPage(sections: Section[], section: string, sub: string | undefined): boolean {
  return !!sections.find((s) => s.path === section)?.subs.some((p) => p.path === (sub ?? ''));
}
