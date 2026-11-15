import type { ReactNode } from 'react';
import type { WeatherKind } from './weather';

const SUN = 'var(--weather-sun)';
const MOON = 'var(--weather-moon)';
const CLOUD = 'var(--weather-cloud)';
const WATER = 'var(--weather-water)';
const BOLT = 'var(--weather-bolt)';

/** A rounded little cloud; `dy` shifts it down. */
const cloud = (dy = 0) => (
  <path d="M7.5 18h9a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.6-1A4 4 0 0 0 7.5 18z" fill={CLOUD} transform={dy ? `translate(0 ${dy})` : undefined} />
);
const smallSun = (
  <g>
    <circle cx="8.5" cy="8.5" r="3.5" fill={SUN} stroke="none" />
    <path d="M8.5 2.5v1M2.5 8.5h1M4.3 4.3l.7.7M12.7 4.3l-.7.7" stroke={SUN} />
  </g>
);
const smallMoon = <path d="M15.5 4a8 8 0 1 0 4.5 12A6.5 6.5 0 0 1 15.5 4z" fill={MOON} stroke="none" transform="translate(0 -1) scale(0.6)" />;
const drops = (n: number, len: number) => (
  <g stroke={WATER}>
    {[8.5, 12.5, 16.5].slice(0, n).map((x) => (
      <path key={x} d={`M${x} 19.5l-.8 ${len}`} />
    ))}
  </g>
);

const SHAPES: Record<WeatherKind, ReactNode> = {
  sun: (
    <g>
      <circle cx="12" cy="12" r="4.5" fill={SUN} stroke="none" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" stroke={SUN} />
    </g>
  ),
  moon: <path d="M15.5 4a8 8 0 1 0 4.5 12A6.5 6.5 0 0 1 15.5 4z" fill={MOON} stroke="none" />,
  partly: (
    <g>
      {smallSun}
      {cloud(1)}
    </g>
  ),
  'partly-night': (
    <g>
      {smallMoon}
      {cloud(1)}
    </g>
  ),
  cloud: cloud(-1),
  fog: (
    <g>
      {cloud(-4)}
      <path d="M5 18h14M7 21h10" stroke="currentColor" />
    </g>
  ),
  drizzle: (
    <g>
      {cloud(-3)}
      {drops(3, 1.4)}
    </g>
  ),
  rain: (
    <g>
      {cloud(-3)}
      {drops(3, 2.6)}
    </g>
  ),
  snow: (
    <g>
      {cloud(-3)}
      <g fill={WATER} stroke="none">
        <circle cx="8.5" cy="20" r="1.1" />
        <circle cx="12.5" cy="21.5" r="1.1" />
        <circle cx="16.5" cy="20" r="1.1" />
      </g>
    </g>
  ),
  storm: (
    <g>
      {cloud(-3)}
      <path d="M12.5 16l-2 3.5h3l-2 3.5" stroke={BOLT} />
    </g>
  ),
};

/** A small, soft weather glyph. Colours come from --weather-* tokens so themes can tune them. */
export function WeatherIcon({ kind, size = 16 }: { kind: WeatherKind; size?: number }) {
  return (
    <svg
      className="weather-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
    >
      {SHAPES[kind]}
    </svg>
  );
}
