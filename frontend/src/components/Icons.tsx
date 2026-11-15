import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 16, strokeWidth = 1.75, ...rest }: P) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
    ...rest,
  };
}

export const KeyIcon = (p: P) => (
  <svg {...base(p)}><circle cx="8" cy="15" r="4" /><path d="M10.8 12.2 20 3" /><path d="M16 7l3 3" /><path d="M18 5l2 2" /></svg>
);
export const LockIcon = (p: P) => (
  <svg {...base(p)}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
);
export const ShieldIcon = (p: P) => (
  <svg {...base(p)}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /></svg>
);
export const CheckIcon = (p: P) => (
  <svg {...base(p)}><path d="M5 12l5 5L20 7" /></svg>
);
export const CircleIcon = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="8" /></svg>
);
export const ClockIcon = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);
export const PlusIcon = (p: P) => (
  <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>
);
export const SearchIcon = (p: P) => (
  <svg {...base(p)}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
);
export const SettingsIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
export const SidebarIcon = (p: P) => (
  <svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
);
export const DotsIcon = ({ size = 18, ...rest }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable={false} {...rest}>
    <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
  </svg>
);
export const PinIcon = (p: P) => (
  <svg {...base({ strokeWidth: 2, ...p })}><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z" /><circle cx="12" cy="10" r="2.5" /></svg>
);
export const XIcon = (p: P) => (
  <svg {...base({ strokeWidth: 2.5, ...p })}><path d="M6 6l12 12M18 6 6 18" /></svg>
);
export const ImageIcon = (p: P) => (
  <svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5L6 20" /></svg>
);
export const LinkIcon = (p: P) => (
  <svg {...base(p)}><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" /></svg>
);
export const ListIcon = (p: P) => (
  <svg {...base(p)}><path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" /></svg>
);
export const ChevronLeftIcon = (p: P) => (
  <svg {...base(p)}><path d="M15 18l-6-6 6-6" /></svg>
);
export const TrashIcon = (p: P) => (
  <svg {...base(p)}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
);
export const PhoneIcon = (p: P) => (
  <svg {...base(p)}><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 18h2" /></svg>
);
export const ChevronDownIcon = (p: P) => (
  <svg {...base(p)}><path d="M6 9l6 6 6-6" /></svg>
);
export const HighlightIcon = (p: P) => (
  <svg {...base(p)}><path d="M14.5 4.5l5 5L11 18H6v-5z" /><path d="M4 21h16" /></svg>
);
export const AlignLeftIcon = (p: P) => (
  <svg {...base(p)}><path d="M4 6h16M4 10h10M4 14h16M4 18h10" /></svg>
);
export const AlignCenterIcon = (p: P) => (
  <svg {...base(p)}><path d="M4 6h16M7 10h10M4 14h16M7 18h10" /></svg>
);
export const ChevronRightIcon = (p: P) => (
  <svg {...base(p)}><path d="M9 18l6-6-6-6" /></svg>
);
export const BookIcon = (p: P) => (
  <svg {...base(p)}><path d="M4 19.5V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2.5z" /><path d="M6 17h13" /></svg>
);
export const FlameIcon = (p: P) => (
  <svg {...base(p)}><path d="M12 22c4 0 7-2.7 7-6.8 0-3.1-1.8-5.4-3.4-7.1-.5 1.6-1.4 2.7-2.6 3.2C13.4 7.6 12 4.4 9.5 2c.3 3.2-1.2 5.3-2.8 7.2C5.4 10.8 5 12.6 5 15.2 5 19.3 8 22 12 22z" /><path d="M12 22c-1.7 0-3-1.2-3-3 0-1.6 1-2.6 2-3.6.2 1 .8 1.6 1.6 1.8.2-.9.7-1.6 1.4-2.2.6 1 1 2 1 3 0 2.2-1.3 4-3 4z" /></svg>
);
export const SunIcon = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
);
export const MoonIcon = (p: P) => (
  <svg {...base(p)}><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>
);
export const CloudIcon = (p: P) => (
  <svg {...base(p)}><path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4.75 4.75 0 0 1-.25 9.5H7z" /></svg>
);
export const SignOutIcon = (p: P) => (
  <svg {...base(p)}><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" /><path d="M10 16l-4-4 4-4" /><path d="M6 12h10" /></svg>
);
export const SignInIcon = (p: P) => (
  <svg {...base(p)}><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" /><path d="M10 8l4 4-4 4" /><path d="M14 12H4" /></svg>
);
