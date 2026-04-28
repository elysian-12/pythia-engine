"use client";

import { usePathname } from "next/navigation";

export function HeaderNav() {
  const pathname = usePathname();
  const onTournament = pathname?.startsWith("/tournament");

  return (
    <nav className="flex items-center gap-2 sm:gap-3 text-base flex-wrap">
      {onTournament ? (
        <a
          className="chip chip-mist hover:opacity-80 transition-opacity text-base px-5 py-2.5 tracking-wider"
          href="/"
        >
          ← Home
        </a>
      ) : null}
      <a
        className="chip chip-mist hover:opacity-80 transition-opacity text-base px-5 py-2.5 tracking-wider"
        href="/performance"
      >
        Agent details
      </a>
      {onTournament ? null : (
        <a
          className="chip chip-cyan hover:opacity-90 transition-all hover:scale-[1.03] font-bold tracking-wider text-base sm:text-lg px-7 sm:px-8 py-3.5 sm:py-4 ring-2 ring-cyan/50 shadow-[0_0_32px_rgba(34,211,238,0.45)]"
          href="/tournament"
        >
          Open tournament app →
        </a>
      )}
      <span className="num text-mist hidden sm:inline">v0.3.0</span>
    </nav>
  );
}
