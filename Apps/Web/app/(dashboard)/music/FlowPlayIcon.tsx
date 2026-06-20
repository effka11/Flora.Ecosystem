type FlowPlayIconProps = {
  className?: string;
  playing?: boolean;
};

const PLAY_PATH =
  "M9.5 7.2v9.6c0 .62.67 1.01 1.2.65l7.8-4.8c.53-.33.53-1.07 0-1.4l-7.8-4.85a.78.78 0 0 0-1.2.64z";

const PAUSE_PATH = "M9.35 7.2h2.35v9.6H9.35V7.2zm5.05 0h2.35v9.6h-2.35V7.2z";

/** Только мягкий ореол — без дублирования контура, знак рисуется отдельно. */
const GLOW_FILTER = (
  <filter
    id="flow-play-glow"
    x="-80%"
    y="-80%"
    width="260%"
    height="260%"
    colorInterpolationFilters="sRGB"
  >
    <feGaussianBlur in="SourceGraphic" stdDeviation="2.8" result="blur" />
    <feComponentTransfer in="blur" result="fade">
      <feFuncA type="gamma" amplitude="1" exponent="2.85" offset="0" />
    </feComponentTransfer>
    <feColorMatrix
      in="fade"
      type="matrix"
      values="1 0 0 0 0
              0 1 0 0 0
              0 0 1 0 0
              0 0 0 0.5 0"
    />
  </filter>
);

function TransportMark({ path, state }: { path: string; state: "play" | "pause" }) {
  return (
    <g data-state={state}>
      <path data-part="halo" d={path} fill="currentColor" filter="url(#flow-play-glow)" />
      <path data-part="mark" d={path} fill="currentColor" />
    </g>
  );
}

export function FlowPlayIcon({ className, playing = false }: FlowPlayIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      data-playing={playing ? "" : undefined}
      aria-hidden
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>{GLOW_FILTER}</defs>
      <TransportMark path={PLAY_PATH} state="play" />
      <TransportMark path={PAUSE_PATH} state="pause" />
    </svg>
  );
}
