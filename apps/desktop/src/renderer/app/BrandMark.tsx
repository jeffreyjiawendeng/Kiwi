/**
 * The Kiwi mark: a slice of the fruit.
 *
 * The same drawing as build/icon.svg, so the top bar, the sign-in page, and the taskbar agree.
 * Inline rather than an image so that it needs no file to fetch and no scheme to fetch it over;
 * the size comes from the class it is given.
 */
export function BrandMark({ className = "brand-mark" }: { className?: string }): React.JSX.Element {
  const seeds = Array.from({ length: 12 }, (_, index) => index * 30);
  return (
    <svg className={className} viewBox="0 0 256 256" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="brand-flesh" cx="42%" cy="36%" r="70%">
          <stop offset="0" stopColor="#b9e07a" />
          <stop offset="0.55" stopColor="#7fb945" />
          <stop offset="1" stopColor="#4f8a2b" />
        </radialGradient>
        <radialGradient id="brand-core" cx="46%" cy="42%" r="60%">
          <stop offset="0" stopColor="#fbfbe9" />
          <stop offset="1" stopColor="#e6efc4" />
        </radialGradient>
      </defs>
      <circle cx="128" cy="128" r="120" fill="#6a4b2a" />
      <circle cx="128" cy="128" r="110" fill="url(#brand-flesh)" />
      <g fill="#1d1a12">
        {seeds.map((angle) => (
          <ellipse
            key={angle}
            cx="128"
            cy="62"
            rx="5"
            ry="9"
            transform={`rotate(${String(angle)} 128 128)`}
          />
        ))}
      </g>
      <circle cx="128" cy="128" r="40" fill="url(#brand-core)" />
    </svg>
  );
}
