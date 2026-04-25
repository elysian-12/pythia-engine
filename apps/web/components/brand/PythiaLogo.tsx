"use client";

/**
 * Pythia logomark — the oracle eye.
 *
 *   - Outer ring   = the swarm (25 agents on the perimeter)
 *   - Triple arcs  = three signal channels (liquidations · funding · price)
 *   - Pupil + spark = the champion firing
 *
 * Pure SVG, no fonts, no images. Scales fluidly via the `size` prop.
 */
export function PythiaLogo({
  size = 36,
  animated = true,
  className = "",
}: {
  size?: number;
  animated?: boolean;
  className?: string;
}) {
  const id = "pythia-logo-" + Math.random().toString(36).slice(2, 8);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 ${className}`}
      aria-label="Pythia"
      role="img"
    >
      <defs>
        {/* Tyrian-purple core glowing into imperial gold — the Roman
            emperor palette: Caesar's purple toga lined with gilded
            laurel. */}
        <radialGradient id={`${id}-core`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#fde68a" stopOpacity="1" />
          <stop offset="55%" stopColor="#a855f7" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#0b0f14" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-ring`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#fbbf24" />
          <stop offset="50%" stopColor="#a855f7" />
          <stop offset="100%" stopColor="#7e22ce" />
        </linearGradient>
      </defs>

      {/* outer swarm ring — dashed to suggest 27 distinct nodes */}
      <circle
        cx="50"
        cy="50"
        r="44"
        fill="none"
        stroke={`url(#${id}-ring)`}
        strokeWidth="2"
        strokeDasharray="3 4.5"
        opacity="0.9"
      >
        {animated ? (
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 50 50"
            to="360 50 50"
            dur="22s"
            repeatCount="indefinite"
          />
        ) : null}
      </circle>

      {/* three signal arcs at 120° — gold + two shades of imperial purple */}
      {[0, 120, 240].map((deg, i) => (
        <g key={deg} transform={`rotate(${deg} 50 50)`}>
          <path
            d="M 50 18 A 32 32 0 0 1 77.7 36"
            fill="none"
            stroke={["#fbbf24", "#a855f7", "#7e22ce"][i]}
            strokeWidth="2.4"
            strokeLinecap="round"
            opacity="0.95"
          />
        </g>
      ))}

      {/* iris ring */}
      <circle
        cx="50"
        cy="50"
        r="20"
        fill="none"
        stroke="#a855f7"
        strokeWidth="1.6"
        opacity="0.6"
      />

      {/* pupil core */}
      <circle cx="50" cy="50" r="14" fill={`url(#${id}-core)`} />

      {/* champion spark — gilded centre */}
      <circle cx="50" cy="50" r="3.2" fill="#fde68a">
        {animated ? (
          <animate
            attributeName="r"
            values="3.2;4.4;3.2"
            dur="2.6s"
            repeatCount="indefinite"
          />
        ) : null}
      </circle>
    </svg>
  );
}

/** Wordmark version — logomark + "PYTHIA" letterform. */
export function PythiaWordmark({
  size = 32,
  animated = true,
}: {
  size?: number;
  animated?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <PythiaLogo size={size} animated={animated} />
      <span className="flex flex-col leading-none">
        <span
          className="font-semibold tracking-[0.32em] bg-gradient-to-r from-amber-300 via-purple-300 to-purple-500 bg-clip-text text-transparent"
          style={{ fontSize: size * 0.46 }}
        >
          PYTHIA
        </span>
        <span
          className="text-purple-300/80 tracking-[0.4em] uppercase mt-1"
          style={{ fontSize: size * 0.22 }}
        >
          Oracle of the swarm
        </span>
      </span>
    </span>
  );
}
