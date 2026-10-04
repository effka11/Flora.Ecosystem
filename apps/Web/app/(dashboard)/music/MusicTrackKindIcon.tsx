import type { ReactNode } from "react";
import type { MusicTrackKindId } from "@/app/(dashboard)/music/musicTrackKinds";

type MusicTrackKindIconProps = {
  kind: MusicTrackKindId;
  className?: string;
  size?: number;
};

const STROKE = 1.5;

function IconShell({
  className,
  size,
  children
}: {
  className?: string;
  size?: number;
  children: ReactNode;
}) {
  return (
    <svg
      className={className}
      {...(size !== undefined ? { width: size, height: size } : {})}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** Stroke 24×24, единый stroke 1.5. */
export function MusicTrackKindIcon({ kind, className, size }: MusicTrackKindIconProps) {
  switch (kind) {
    case "song":
      return (
        <IconShell className={className} size={size}>
          <path d="M12 17.5V5.5c3-.4 5.5 2.2 5 5.2M12 17.5c0 1.6-1.3 2.9-2.9 2.9s-2.9-1.3-2.9-2.9 1.3-2.9 2.9-2.9 2.9 1.3 2.9 2.9z" />
        </IconShell>
      );
    case "podcast":
      return (
        <IconShell className={className} size={size}>
          <path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />
        </IconShell>
      );
    case "mic":
      return (
        <IconShell className={className} size={size}>
          <rect x="9" y="4" width="6" height="9" rx="3" />
          <path d="M6.5 12.2a5.5 5.5 0 0 0 11 0" />
          <path d="M9.5 20H14.5" />
          <path strokeLinecap="butt" d="M12 18.4V20" />
        </IconShell>
      );
    case "mixer":
      return (
        <IconShell className={className} size={size}>
          <line x1="4" y1="21" x2="4" y2="14" />
          <line x1="4" y1="10" x2="4" y2="3" />
          <line x1="12" y1="21" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12" y2="3" />
          <line x1="20" y1="21" x2="20" y2="16" />
          <line x1="20" y1="12" x2="20" y2="3" />
          <line x1="1" y1="14" x2="7" y2="14" />
          <line x1="9" y1="8" x2="15" y2="8" />
          <line x1="17" y1="16" x2="23" y2="16" />
        </IconShell>
      );
    case "idea":
      return (
        <IconShell className={className} size={size}>
          <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.9 1.2 1.5 1.5 2.5" />
          <path d="M9 18h6" />
          <path d="M10 22h4" />
        </IconShell>
      );
    case "live":
      return (
        <IconShell className={className} size={size}>
          <path d="M23 7l-7 5 7 5V7z" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </IconShell>
      );
    case "demo":
      return (
        <IconShell className={className} size={size}>
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <line x1="10" y1="9" x2="8" y2="9" />
        </IconShell>
      );
    case "art":
      return (
        <IconShell className={className} size={size}>
          <path d="M13.5 6.5v.01" />
          <path d="M17.5 10.5v.01" />
          <path d="M8.5 7.5v.01" />
          <path d="M6.5 12.5v.01" />
          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
        </IconShell>
      );
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
