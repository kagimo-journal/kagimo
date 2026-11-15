import type { Download } from '../../api/types';
import { formatBytes } from '../../lib/format';

export const PLATFORM_NAMES: Record<Download['platform'], string> = { linux: 'Linux', mac: 'macOS', windows: 'Windows' };

/** The system this browser runs on, when the desktop app could run there. */
export function visitorPlatform(userAgent: string): Download['platform'] | null {
  if (/Android|iPhone|iPad|iPod/i.test(userAgent)) return null;
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'mac';
  if (/Linux|X11/i.test(userAgent)) return 'linux';
  return null;
}

/**
 * The desktop app, when this server offers it (/api/config `downloads`): a button for the
 * visitor's own system, and plain links for the others.
 */
export function DesktopDownload({ downloads }: { downloads: Download[] | undefined }) {
  if (!downloads?.length) return null;
  const mine = visitorPlatform(typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const main = downloads.find((d) => d.platform === mine);
  const others = downloads.filter((d) => d !== main);
  const href = (d: Download) => d.url ?? `/download/${encodeURIComponent(d.name)}`;
  return (
    <div className="landing-download">
      {main && (
        <a href={href(main)} download={main.name} className="btn btn-secondary">
          Download for {PLATFORM_NAMES[main.platform]}
          <span className="landing-download-size">{formatBytes(main.size)}</span>
        </a>
      )}
      <p className="landing-fine">
        {main ? 'The desktop app keeps your journal in a folder you choose.' : 'There is a desktop app too, which keeps your journal in a folder you choose.'}
        {others.length > 0 && (
          <>
            {' '}
            {main ? 'Also for' : 'Download for'}{' '}
            {others.map((d, i) => (
              <span key={d.name}>
                {i > 0 && (i === others.length - 1 ? ' and ' : ', ')}
                <a href={href(d)} download={d.name}>
                  {PLATFORM_NAMES[d.platform]}
                </a>
              </span>
            ))}
            .
          </>
        )}
      </p>
    </div>
  );
}
