import type { SVGProps } from "react";

export function FlowArt(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 800 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMaxYMid slice"
      {...props}
    >
      <g stroke="url(#flow-art-grad)" strokeLinecap="round" strokeLinejoin="round">
        <path
          d="M 100,250 C 300,100 400,20 500,100 C 600,180 700,80 850,120"
          strokeWidth="1"
          opacity="0.3"
        />
        <path
          d="M 50,220 C 250,120 380,40 480,120 C 580,200 680,100 850,140"
          strokeWidth="1.5"
          opacity="0.5"
        />
        <path
          d="M 0,190 C 200,140 360,60 460,140 C 560,220 660,120 850,160"
          strokeWidth="2"
          opacity="0.7"
        />
        <path
          d="M -50,160 C 150,160 340,80 440,160 C 540,240 640,140 850,180"
          strokeWidth="1"
          opacity="0.4"
        />
        <path
          d="M -100,130 C 100,180 320,100 420,180 C 520,260 620,160 850,200"
          strokeWidth="0.5"
          opacity="0.2"
        />
      </g>
      
      {/* Subtle glow layer */}
      <g stroke="url(#flow-art-grad)" strokeLinecap="round" strokeLinejoin="round" filter="url(#flow-glow)" opacity="0.5">
        <path
          d="M 0,190 C 200,140 360,60 460,140 C 560,220 660,120 850,160"
          strokeWidth="4"
        />
        <path
          d="M 50,220 C 250,120 380,40 480,120 C 580,200 680,100 850,140"
          strokeWidth="3"
        />
      </g>

      <defs>
        <linearGradient id="flow-art-grad" x1="0" y1="0" x2="800" y2="0" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--flora-green-light)" stopOpacity="0" />
          <stop offset="0.4" stopColor="var(--flora-green-light)" stopOpacity="0.3" />
          <stop offset="0.8" stopColor="var(--flora-green-light)" stopOpacity="0.8" />
          <stop offset="1" stopColor="var(--flora-green-light)" stopOpacity="0.6" />
        </linearGradient>
        <filter id="flow-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="6" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>
    </svg>
  );
}
