import type { SVGProps } from "react";

export function GenreArtPop(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 144 144" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" {...props}>
      <defs>
        <filter id="glow-pop" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>
      <g stroke="var(--genre-color)" strokeLinecap="round" strokeLinejoin="round" filter="url(#glow-pop)">
        <circle cx="110" cy="40" r="25" strokeWidth="1.5" opacity="0.4" />
        <circle cx="30" cy="110" r="15" strokeWidth="1" opacity="0.3" />
        <path d="M 10,80 C 50,120 90,20 140,60" strokeWidth="2" opacity="0.5" />
      </g>
    </svg>
  );
}

export function GenreArtHipHop(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 144 144" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" {...props}>
      <defs>
        <filter id="glow-hiphop" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>
      <g stroke="var(--genre-color)" strokeLinecap="round" strokeLinejoin="round" filter="url(#glow-hiphop)">
        <path d="M 10,120 L 40,50 L 70,100 L 100,40 L 140,80" strokeWidth="2" opacity="0.6" />
        <path d="M 20,130 L 50,60 L 80,110 L 110,50 L 150,90" strokeWidth="1" opacity="0.3" />
      </g>
    </svg>
  );
}

export function GenreArtRnB(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 144 144" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" {...props}>
      <defs>
        <filter id="glow-rnb" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>
      <g stroke="var(--genre-color)" strokeLinecap="round" strokeLinejoin="round" filter="url(#glow-rnb)">
        <path d="M -10,60 C 40,10 100,110 154,60" strokeWidth="2" opacity="0.6" />
        <path d="M -10,75 C 40,25 100,125 154,75" strokeWidth="1" opacity="0.3" />
      </g>
    </svg>
  );
}

export function GenreArtRock(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 144 144" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" {...props}>
      <defs>
        <filter id="glow-rock" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>
      <g stroke="var(--genre-color)" strokeLinecap="round" strokeLinejoin="round" filter="url(#glow-rock)">
        <path d="M 100,20 L 60,70 L 90,75 L 40,130" strokeWidth="2" opacity="0.6" />
        <path d="M 110,30 L 70,80 L 100,85 L 50,140" strokeWidth="1" opacity="0.3" />
      </g>
    </svg>
  );
}

export function GenreArtElectronics(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 144 144" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" {...props}>
      <defs>
        <filter id="glow-elec" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>
      <g stroke="var(--genre-color)" strokeLinecap="round" strokeLinejoin="round" filter="url(#glow-elec)">
        <path d="M -10,80 Q 30,30 72,80 T 154,80" strokeWidth="1.5" opacity="0.6" />
        <path d="M -10,95 Q 30,45 72,95 T 154,95" strokeWidth="1" opacity="0.3" />
      </g>
      <g fill="var(--genre-color)" opacity="0.5">
        <circle cx="30" cy="55" r="1.5" />
        <circle cx="114" cy="105" r="2" />
        <circle cx="72" cy="80" r="1" />
      </g>
    </svg>
  );
}

export function GenreArtFolk(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 144 144" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" {...props}>
      <defs>
        <filter id="glow-folk" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>
      <g stroke="var(--genre-color)" strokeLinecap="round" strokeLinejoin="round" filter="url(#glow-folk)">
        <path d="M 20,120 C 20,60 80,20 120,20 C 80,40 40,80 40,120" strokeWidth="1.5" opacity="0.6" />
        <path d="M 40,130 C 40,70 100,30 140,30 C 100,50 60,90 60,130" strokeWidth="1" opacity="0.3" />
      </g>
    </svg>
  );
}

export function GenreArtJazz(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 144 144" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" {...props}>
      <defs>
        <filter id="glow-jazz" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>
      <g stroke="var(--genre-color)" strokeLinecap="round" strokeLinejoin="round" filter="url(#glow-jazz)">
        <path d="M 20,80 Q 50,20 90,60 T 140,40" strokeWidth="1.5" opacity="0.6" />
        <circle cx="40" cy="90" r="2" fill="var(--genre-color)" opacity="0.5" stroke="none" />
        <circle cx="100" cy="30" r="3" fill="var(--genre-color)" opacity="0.4" stroke="none" />
        <circle cx="120" cy="80" r="1.5" fill="var(--genre-color)" opacity="0.6" stroke="none" />
      </g>
    </svg>
  );
}

export function GenreArtInstrumental(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 144 144" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" {...props}>
      <defs>
        <filter id="glow-inst" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>
      <g stroke="var(--genre-color)" strokeLinecap="round" strokeLinejoin="round" filter="url(#glow-inst)">
        <path d="M 20,20 L 120,120" strokeWidth="1" opacity="0.5" />
        <path d="M 30,10 L 130,110" strokeWidth="1.5" opacity="0.4" />
        <path d="M 40,0 L 140,100" strokeWidth="1" opacity="0.3" />
        <path d="M 10,30 L 110,130" strokeWidth="1.5" opacity="0.6" />
      </g>
    </svg>
  );
}
