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
        <radialGradient id={`${id}-core`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#fde68a" stopOpacity="1" />
          <stop offset="55%" stopColor="#22d3ee" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#0b0f14" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-ring`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="60%" stopColor="#34d399" />
          <stop offset="100%" stopColor="#a78bfa" />
        </linearGradient>
      </defs>

      {/* outer swarm ring — dashed to suggest 25 distinct nodes */}
      <circle
        cx="50"
        cy="50"
        r="44"
        fill="none"
        stroke={`url(#${id}-ring)`}
        strokeWidth="2"
        strokeDasharray="3 4.5"
        opacity="0.85"
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

      {/* three signal arcs at 120° */}
      {[0, 120, 240].map((deg, i) => (
        <g key={deg} transform={`rotate(${deg} 50 50)`}>
          <path
            d="M 50 18 A 32 32 0 0 1 77.7 36"
            fill="none"
            stroke={["#22d3ee", "#34d399", "#fbbf24"][i]}
            strokeWidth="2.4"
            strokeLinecap="round"
            opacity="0.9"
          />
        </g>
      ))}

      {/* iris ring */}
      <circle
        cx="50"
        cy="50"
        r="20"
        fill="none"
        stroke="#22d3ee"
        strokeWidth="1.6"
        opacity="0.55"
      />

      {/* pupil core */}
      <circle cx="50" cy="50" r="14" fill={`url(#${id}-core)`} />

      {/* champion spark */}
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
          className="font-semibold tracking-[0.32em] text-slate-100"
          style={{ fontSize: size * 0.46 }}
        >
          PYTHIA
        </span>
        <span
          className="text-mist tracking-[0.4em] uppercase mt-1"
          style={{ fontSize: size * 0.22 }}
        >
          Oracle of the swarm
        </span>
      </span>
    </span>
  );
}
