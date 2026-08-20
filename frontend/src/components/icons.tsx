/**
 * Icon set.
 *
 * Inline stroke icons on a 24-grid, drawn to one weight so they sit together.
 * Inline rather than a library because it keeps the bundle small and offline —
 * and emoji, the usual shortcut, immediately makes an interface look generated.
 *
 * All of them inherit `currentColor`, so an icon takes the colour of whatever
 * text or chip it sits in.
 */

import type { ReactElement, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 20, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/* -- core actions --------------------------------------------------------- */
export const IconPlay = (p: IconProps) => (
  <Base {...p}><path d="M7 4.5v15l12-7.5-12-7.5Z" fill="currentColor" stroke="none" /></Base>
);
export const IconStop = (p: IconProps) => (
  <Base {...p}><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" /></Base>
);
export const IconArrowRight = (p: IconProps) => (
  <Base {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Base>
);
export const IconCheck = (p: IconProps) => (
  <Base {...p}><path d="M4 12.5l5 5L20 6.5" /></Base>
);
export const IconPlus = (p: IconProps) => (
  <Base {...p}><path d="M12 5v14M5 12h14" /></Base>
);
export const IconClose = (p: IconProps) => (
  <Base {...p}><path d="M6 6l12 12M18 6L6 18" /></Base>
);

/* -- domain --------------------------------------------------------------- */
export const IconEar = (p: IconProps) => (
  <Base {...p}>
    <path d="M8.5 19c0-2.5-1-3-2-4.5A6.5 6.5 0 0 1 12 4a6 6 0 0 1 6 6c0 3-3 3.5-3 6" />
    <path d="M15 16c0 2-1.2 3.5-3 3.5" />
    <path d="M9.5 10a2.5 2.5 0 1 1 5 0c0 1.4-1.2 1.8-1.2 3" />
  </Base>
);
export const IconWave = (p: IconProps) => (
  <Base {...p}><path d="M2 12h2.5l2-6 3 12 2.5-9 2 6 1.5-3H22" /></Base>
);
export const IconHeadphones = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
    <rect x="2.5" y="13.5" width="4.5" height="7" rx="2" />
    <rect x="17" y="13.5" width="4.5" height="7" rx="2" />
  </Base>
);
export const IconChart = (p: IconProps) => (
  <Base {...p}><path d="M4 19V5M4 19h16" /><path d="M8 16l3.5-5 3 3L20 7" /></Base>
);
export const IconCalendar = (p: IconProps) => (
  <Base {...p}>
    <rect x="3.5" y="5" width="17" height="16" rx="3" /><path d="M3.5 10h17M8 3v4M16 3v4" />
  </Base>
);
export const IconChat = (p: IconProps) => (
  <Base {...p}><path d="M20 15a3 3 0 0 1-3 3H8l-4 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v9Z" /></Base>
);
export const IconClipboard = (p: IconProps) => (
  <Base {...p}>
    <path d="M9 4h6v3H9z" /><path d="M9 5.5H7a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5a2 2 0 0 0-2-2h-2" />
    <path d="M9 12h6M9 16h4" />
  </Base>
);
export const IconMoon = (p: IconProps) => (
  <Base {...p}><path d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5Z" /></Base>
);
export const IconSun = (p: IconProps) => (
  <Base {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Base>
);
export const IconContrast = (p: IconProps) => (
  <Base {...p}><circle cx="12" cy="12" r="9" /><path d="M12 3v18a9 9 0 0 0 0-18Z" fill="currentColor" stroke="none" /></Base>
);

/* -- status --------------------------------------------------------------- */
export const IconAlert = (p: IconProps) => (
  <Base {...p}><path d="M12 3.5 2.5 20h19L12 3.5Z" /><path d="M12 10v4.5M12 17.5v.01" /></Base>
);
export const IconShield = (p: IconProps) => (
  <Base {...p}><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z" /><path d="M9 12l2 2 4-4" /></Base>
);
export const IconSpark = (p: IconProps) => (
  <Base {...p}><path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4L12 3Z" /></Base>
);
export const IconInfo = (p: IconProps) => (
  <Base {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8v.01" /></Base>
);
export const IconTrend = (p: IconProps) => (
  <Base {...p}><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></Base>
);
export const IconMoodSmile = (p: IconProps) => (
  <Base {...p}><circle cx="12" cy="12" r="9" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5v.01M15 9.5v.01" /></Base>
);
export const IconUser = (p: IconProps) => (
  <Base {...p}><circle cx="12" cy="8.5" r="3.8" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></Base>
);
export const IconDownload = (p: IconProps) => (
  <Base {...p}><path d="M12 4v11M8 11l4 4 4-4M4.5 19.5h15" /></Base>
);
export const IconHelp = (p: IconProps) => (
  <Base {...p}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.6 2.6 0 1 1 3.4 2.5c-.6.2-.9.8-.9 1.5M12 16.5v.01" /></Base>
);
export const IconChevronRight = (p: IconProps) => (
  <Base {...p}><path d="M9 5l7 7-7 7" /></Base>
);
export const IconPhone = (p: IconProps) => (
  <Base {...p}>
    <path d="M6.5 3.5h3l1.5 4-2 1.4a12 12 0 0 0 6.1 6.1l1.4-2 4 1.5v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2Z" />
  </Base>
);
export const IconGlobe = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" /><path d="M3 12h18" />
    <path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z" />
  </Base>
);
export const IconFile = (p: IconProps) => (
  <Base {...p}>
    <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9l-6-6Z" />
    <path d="M13 3v6h6M9 13h6M9 17h4" />
  </Base>
);
export const IconTarget = (p: IconProps) => (
  <Base {...p}><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /></Base>
);
export const IconBed = (p: IconProps) => (
  <Base {...p}><path d="M3 18V7M3 12h18v6M3 18h18" /><circle cx="7.5" cy="9.5" r="2" /><path d="M11 12V9.5h6.5A3.5 3.5 0 0 1 21 13" /></Base>
);
export const IconVolume = (p: IconProps) => (
  <Base {...p}><path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4v-5Z" /><path d="M15.5 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" /></Base>
);
/** Volume with the waves struck through — muted. */
export const IconVolumeOff = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4v-5Z" />
    <path d="M16 10l4 4M20 10l-4 4" />
  </Base>
);
/** Two bars. Paired with IconPlay on the same control, so the widths match. */
export const IconPause = (p: IconProps) => (
  <Base {...p}>
    <rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" />
    <rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" />
  </Base>
);
/** Circular arrow — replay from the start. */
export const IconReplay = (p: IconProps) => (
  <Base {...p}>
    <path d="M20 12a8 8 0 1 1-2.5-5.8" />
    <path d="M20 4v4.5h-4.5" />
  </Base>
);
export const IconVideo = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="6" width="12.5" height="12" rx="2" />
    <path d="M15.5 10.5 21 7.5v9l-5.5-3v-3Z" />
  </Base>
);
export const IconUsers = (p: IconProps) => (
  <Base {...p}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Base>
);

export const IconSettings = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </Base>
);

/** Map used by the nav so route icons stay in one place. */
export const NAV_ICONS: Record<string, (p: IconProps) => ReactElement> = {
  "/": IconChart,
  "/assessment": IconClipboard,
  "/rehabilitation": IconWave,
  "/support": IconChat,
  "/community": IconUsers,
  // Not IconUser: a clinician scoped to a patient sees Caseload and Doctor
  // consultation in the same rail, and two identical glyphs there is a misread
  // waiting to happen. The calendar is what this screen is actually about.
  "/consultation": IconCalendar,
  "/results": IconTrend,
  "/clinic": IconUser,
  "/guide": IconHelp,
  "/settings": IconSettings,
};
