import type { CSSProperties } from "react";

export type IconName =
  | "sun"
  | "library"
  | "chart"
  | "settings"
  | "plus"
  | "arrow"
  | "chevron"
  | "close"
  | "search"
  | "upload"
  | "download"
  | "check"
  | "flame"
  | "clock"
  | "cards"
  | "more"
  | "edit"
  | "trash"
  | "pause"
  | "play"
  | "undo"
  | "wifi"
  | "logout"
  | "moon"
  | "spark"
  | "volume"
  | "copy"
  | "folder"
  | "help";
const paths: Record<IconName, React.ReactNode> = {
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
    </>
  ),
  library: (
    <>
      <rect x="3" y="4" width="5" height="16" rx="1.5" />
      <rect x="8" y="4" width="5" height="16" rx="1.5" />
      <path d="m15 5 4-1 4 15-4 1zM5 8h1m4 0h1" />
    </>
  ),
  chart: (
    <>
      <path d="M4 4v16h17M8 15v-4m5 4V7m5 8v-6" />
    </>
  ),
  settings: (
    <>
      <path
        d="m9.5 3-.7 2a8 8 0 0 0-1.7 1L5 5.6 2.5 10l1.5 1.5v2L2.5 15 5 19.4 7.1 19a8 8 0 0 0 1.7 1l.7 2h5l.7-2a8 8 0 0 0 1.7-1l2.1.4 2.5-4.4-1.5-1.5v-2L21.5 10 19 5.6 16.9 6a8 8 0 0 0-1.7-1l-.7-2z"
        transform="translate(0 -1) scale(1 .96)"
      />
      <circle cx="12" cy="11.5" r="3" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4" />
    </>
  ),
  check: <path d="m5 12 4.5 4.5L19 7" />,
  flame: (
    <path d="M13 2c1 5-3 5-2 9 2-1 3-2 3-4 4 4 5 6 5 9a7 7 0 1 1-14 0c0-4 3-6 3-9 1 2 1 3 2 3 0-3 1-5 3-8Z" />
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  cards: (
    <>
      <rect x="7" y="6" width="13" height="15" rx="2" />
      <path d="M16 3H6a2 2 0 0 0-2 2v12M10 11h7m-7 4h5" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  edit: (
    <>
      <path d="m15 4 5 5M4 20l5-1L21 7a2.1 2.1 0 0 0-5-5L4 14z" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
    </>
  ),
  pause: (
    <>
      <path d="M8 5v14M16 5v14" />
    </>
  ),
  play: <path d="m8 4 12 8-12 8z" />,
  undo: (
    <>
      <path
        d="M8 5 3 10l5 5M3 10h11a6 6 0 0 1 0 12"
        transform="translate(0 -2)"
      />
    </>
  ),
  wifi: (
    <>
      <path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0m-11 4a6 6 0 0 1 8 0" />
      <circle cx="12" cy="20" r=".7" />
    </>
  ),
  logout: (
    <>
      <path d="M10 4H4v16h6m5-13 5 5-5 5M9 12h11" />
    </>
  ),
  moon: <path d="M20 14A9 9 0 0 1 10 4 9 9 0 1 0 20 14Z" />,
  spark: (
    <>
      <path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z" />
    </>
  ),
  volume: (
    <>
      <path d="m11 4-6 5H2v6h3l6 5zM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M16 4V3H3v13h1" />
    </>
  ),
  folder: <path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3Z" />,
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 8a3 3 0 0 1 6 0c0 2-3 2-3 5m0 4h.01" />
    </>
  ),
};
export function Icon({
  name,
  size = 20,
  className = "",
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      {paths[name]}
    </svg>
  );
}
export function Brand({ small = false }: { small?: boolean }) {
  return <span className={`brand ${small ? "brand-small" : ""}`}>lll</span>;
}
