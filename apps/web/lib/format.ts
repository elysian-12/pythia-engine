// Adaptive duration formatter. The pipeline cycle measurement uses
// performance.now(), which returns floating-point milliseconds with
// browser-clamped sub-ms resolution (~5µs in Chrome, ~20µs in Firefox
// w/ fingerprinting opt-in, ~1ms in Safari). The previous formatter
// rounded to integer ms and floored at 1, so every cycle read "1ms"
// even when the real number was much smaller. This keeps the float
// reading and renders the smallest unit that still has a meaningful
// integer in front of the decimal.

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 1) return `${ms.toFixed(ms >= 10 ? 1 : 2)}ms`;
  const us = ms * 1000;
  if (us >= 1) return `${us.toFixed(us >= 10 ? 1 : 2)}µs`;
  const ns = us * 1000;
  return `${ns.toFixed(ns >= 10 ? 0 : 1)}ns`;
}
