"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  duration?: number; // seconds
  commas?: boolean;
}

/** Eased count-up from 0 to `value` over `duration` seconds. */
export function CountUp({
  value,
  decimals = 0,
  prefix = "",
  suffix = "",
  duration = 1.6,
  commas = true,
}: Props) {
  const [v, setV] = useState(0);
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    let raf = 0;
    startedAt.current = performance.now();
    const tick = () => {
      const now = performance.now();
      const t = Math.min(1, (now - (startedAt.current ?? now)) / (duration * 1000));
      // ease-out-quart
      const eased = 1 - Math.pow(1 - t, 4);
      setV(value * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  const fixed = v.toFixed(decimals);
  const [intPart, decPart] = fixed.split(".");
  const formatted = commas ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : intPart;
  return (
    <span className="num">
      {prefix}
      {formatted}
      {decPart ? `.${decPart}` : ""}
      {suffix}
    </span>
  );
}
