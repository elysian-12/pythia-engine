"use client";

import { useEffect, useMemo, useState } from "react";
import type { PaperPosition } from "@/lib/paper";
import { realizedPnl, sumRealized, unrealizedPnl } from "@/lib/paper";

type Props = {
  open: PaperPosition[];
  closed: PaperPosition[];
  marks: { BTC: number | null; ETH: number | null };
  equity_usd: number;
  onClose: (id: string) => void;
  onReset?: () => void;
};

type HlMode = "paper" | "live";

const HL_MODE_KEY = "pythia-hl-mode";
const HL_WALLET_KEY = "pythia-hl-wallet";
const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

export function HyperliquidPanel({
  open,
  closed,
  marks,
  equity_usd,
  onClose,
  onReset,
}: Props) {
  // Mode + wallet address moved here from TradeSettingsPanel — the
  // landing page is now purely a simulation; the live-preview toggle
  // belongs on the page that actually shows trade flow. Persist
  // locally only (no /api/config round-trip) since this is preview
  // chrome until execution wiring exists.
  const [mode, setMode] = useState<HlMode>("paper");
  const [wallet, setWallet] = useState("");
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const m = localStorage.getItem(HL_MODE_KEY);
      if (m === "live" || m === "paper") setMode(m);
      const w = localStorage.getItem(HL_WALLET_KEY) ?? "";
      setWallet(w);
    } catch {
      /* ignore */
    }
  }, []);
  const setModePersist = (m: HlMode) => {
    setMode(m);
    try {
      localStorage.setItem(HL_MODE_KEY, m);
    } catch {
      /* ignore */
    }
  };
  const setWalletPersist = (w: string) => {
    setWallet(w);
    try {
      localStorage.setItem(HL_WALLET_KEY, w);
    } catch {
      /* ignore */
    }
  };
  const walletValid = wallet.length === 0 || EVM_ADDR_RE.test(wallet);

  const realized = useMemo(() => sumRealized(closed), [closed]);
  const unrealized = useMemo(
    () =>
      open.reduce((a, p) => {
        const m = p.asset === "BTC" ? marks.BTC : marks.ETH;
        if (m == null) return a;
        return a + unrealizedPnl(p, m);
      }, 0),
    [open, marks],
  );

  const totalPnl = realized + unrealized;
  const equityLive = equity_usd + totalPnl;
  const wins = closed.filter((p) => realizedPnl(p) > 0).length;
  const losses = closed.length - wins;
  const winRate = closed.length > 0 ? wins / closed.length : 0;

  return (
    <div className="panel p-5 relative overflow-hidden">
      {/* BTC / ETH mark chips dropped from this header — the
          KiyotakaBadge in the page top strip already shows live BTC
          price, and the per-position rows below show their own
          marks. Repeating them here was just visual noise. */}
      <div className="flex items-center gap-2 mb-3">
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            mode === "live" ? "bg-amber animate-pulse" : "bg-cyan animate-pulse"
          }`}
        />
        <div className="text-xs uppercase tracking-[0.3em] text-mist truncate">
          Hyperliquid {mode === "live" ? "live" : "paper"}
        </div>
        {mode === "live" ? (
          <span className="chip chip-mist text-[0.55rem] tracking-widest">
            disconnected
          </span>
        ) : null}
      </div>

      {/* Mode toggle — paper is the working sandbox, live previews
          where a Hyperliquid wallet would attach when execution
          wiring lands. */}
      <div className="flex items-center gap-1 p-0.5 rounded-md border border-edge/60 bg-black/30 mb-3">
        <button
          type="button"
          onClick={() => setModePersist("paper")}
          aria-pressed={mode === "paper"}
          className={`flex-1 px-3 py-1.5 rounded text-[0.6rem] uppercase tracking-[0.25em] transition-all duration-200 ${
            mode === "paper"
              ? "bg-cyan/15 text-cyan font-bold ring-1 ring-cyan/40"
              : "text-mist hover:text-slate-100"
          }`}
        >
          Paper
        </button>
        <button
          type="button"
          onClick={() => setModePersist("live")}
          aria-pressed={mode === "live"}
          className={`flex-1 px-3 py-1.5 rounded text-[0.6rem] uppercase tracking-[0.25em] transition-all duration-200 ${
            mode === "live"
              ? "bg-amber/15 text-amber font-bold ring-1 ring-amber/40"
              : "text-mist hover:text-slate-100"
          }`}
        >
          Live preview
        </button>
      </div>

      {/* Live-preview reveal — wallet input + plain-English disclaimer
          that real execution isn't wired yet. Read-only; the address
          is persisted to localStorage for the preview only. */}
      {mode === "live" ? (
        <div className="rounded-sm border border-amber/30 bg-amber/5 p-3 mb-4">
          <div className="text-[0.55rem] uppercase tracking-[0.3em] text-amber">
            Not wired up
          </div>
          <p className="text-[0.7rem] text-mist mt-1 leading-relaxed">
            Real-money execution is gated behind a manual review —
            no EIP-712 signer is hooked here yet. Paste a Hyperliquid
            address to preview where copy-trades would route.
            Read-only; nothing leaves your browser.
          </p>
          <input
            value={wallet}
            onChange={(e) => setWalletPersist(e.target.value.trim())}
            placeholder="0x… your EVM wallet"
            className={`mt-2 w-full font-mono text-[0.7rem] bg-black/40 border rounded-sm px-2.5 py-1.5 outline-none transition-colors ${
              walletValid
                ? "border-edge/60 focus:border-amber/60"
                : "border-red/60 focus:border-red"
            }`}
            maxLength={42}
          />
          {!walletValid ? (
            <div className="text-[0.6rem] text-red mt-1">
              Looks malformed — expected 42 chars starting with 0x.
            </div>
          ) : (
            <div className="text-[0.6rem] text-mist mt-1">
              Find yours at app.hyperliquid.xyz → Subaccount → Trader
              Address.
            </div>
          )}
        </div>
      ) : null}

      <div className="grid grid-cols-4 gap-2 text-[0.7rem] num mb-4">
        <Stat label="Equity" value={`$${equityLive.toFixed(0)}`} tone="neutral" />
        <Stat
          label="Realized"
          value={`${realized >= 0 ? "+" : ""}$${realized.toFixed(2)}`}
          tone={realized >= 0 ? "pos" : "neg"}
        />
        <Stat
          label="Unrealized"
          value={`${unrealized >= 0 ? "+" : ""}$${unrealized.toFixed(2)}`}
          tone={unrealized >= 0 ? "pos" : "neg"}
        />
        <Stat
          label="Win rate"
          value={`${(winRate * 100).toFixed(0)}% (${wins}W/${losses}L)`}
          tone="neutral"
        />
      </div>

      <div className="text-[0.7rem] uppercase tracking-wider text-mist mb-2 flex items-center justify-between">
        <span>Open positions · {open.length}</span>
        {open.length > 0 ? (
          <span className="text-mist/70 normal-case tracking-normal">
            newest on top · scroll to see more
          </span>
        ) : null}
      </div>
      {open.length === 0 ? (
        <div className="rounded-sm border border-edge/60 bg-black/20 px-3 py-4 text-center text-[0.75rem] text-mist">
          Flat. When the champion fires on an autopilot signal, the paper
          position opens here with stop + TP wired up.
        </div>
      ) : (
        <div className="space-y-2 max-h-[440px] overflow-y-auto pr-1">
          {[...open].reverse().map((p) => {
            const m = p.asset === "BTC" ? marks.BTC : marks.ETH;
            const pnl = m != null ? unrealizedPnl(p, m) : 0;
            return (
              <PositionRow
                key={p.id}
                p={p}
                mark={m}
                pnl={pnl}
                onClose={() => onClose(p.id)}
              />
            );
          })}
        </div>
      )}

      {closed.length > 0 ? (
        <div className="mt-5">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[0.7rem] uppercase tracking-wider text-mist">
              Closed · {closed.length}
            </div>
            {onReset ? (
              <button
                onClick={() => {
                  if (
                    typeof window === "undefined" ||
                    window.confirm(
                      "Clear all open + closed paper positions for this session? This cannot be undone.",
                    )
                  ) {
                    onReset();
                  }
                }}
                className="text-[0.65rem] text-mist hover:text-red transition-colors px-1 py-0.5 rounded-sm"
              >
                Reset session
              </button>
            ) : null}
          </div>
          <div className="max-h-48 overflow-auto space-y-1 pr-1">
            {[...closed]
              .reverse()
              .slice(0, 30)
              .map((p) => (
                <ClosedRow key={p.id} p={p} />
              ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MarkChip({ asset, px }: { asset: "BTC" | "ETH"; px: number | null }) {
  return (
    <span className="inline-flex items-center gap-1 text-mist">
      <span className="font-mono">{asset}</span>
      <span className={px != null ? "text-slate-100" : "text-mist"}>
        {px != null
          ? `$${px.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
          : "—"}
      </span>
    </span>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "pos" | "neg" | "neutral";
}) {
  const color =
    tone === "pos" ? "text-green" : tone === "neg" ? "text-red" : "text-slate-100";
  return (
    <div className="rounded-sm border border-edge/60 bg-black/20 px-2 py-1.5">
      <div className="text-[0.6rem] uppercase tracking-wider text-mist">
        {label}
      </div>
      <div className={`mt-0.5 text-sm ${color}`}>{value}</div>
    </div>
  );
}

function PositionRow({
  p,
  mark,
  pnl,
  onClose,
}: {
  p: PaperPosition;
  mark: number | null;
  pnl: number;
  onClose: () => void;
}) {
  const pnlPct = (pnl / p.notional_usd) * 100;
  const sideColor = p.side === "long" ? "text-green" : "text-red";
  const pnlColor = pnl >= 0 ? "text-green" : "text-red";

  return (
    <div className="rounded-sm border border-edge/60 bg-black/30 px-3 py-2 text-[0.75rem]">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 font-mono">
            <span className="text-slate-100">{p.asset}</span>
            <span className={sideColor}>{p.side.toUpperCase()}</span>
            <span className="text-mist num">
              {p.size_contracts.toFixed(4)}
            </span>
            <span className="text-mist">·</span>
            <span className="num text-mist">
              ${p.notional_usd.toFixed(0)}
            </span>
          </div>
          <div className="mt-1 text-[0.65rem] text-mist">
            by <span className="font-mono text-slate-300">{p.agent_id}</span>
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-[0.65rem] text-mist hover:text-red transition-colors px-2 py-0.5 border border-edge rounded-sm"
        >
          Close
        </button>
      </div>
      <div className="grid grid-cols-4 gap-2 mt-2 text-[0.65rem] num">
        <div>
          <div className="text-mist">Entry</div>
          <div>${p.entry.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-mist">Mark</div>
          <div>{mark != null ? `$${mark.toFixed(2)}` : "—"}</div>
        </div>
        <div>
          <div className="text-mist">Stop / TP</div>
          <div>
            <span className="text-red">${p.stop.toFixed(0)}</span>
            <span className="text-mist"> / </span>
            <span className="text-green">${p.take_profit.toFixed(0)}</span>
          </div>
        </div>
        <div>
          <div className="text-mist">Unrealized</div>
          <div className={pnlColor}>
            {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
            <span className="text-mist"> ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%)</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ClosedRow({ p }: { p: PaperPosition }) {
  const pnl = realizedPnl(p);
  const pnlColor = pnl >= 0 ? "text-green" : "text-red";
  // Color hint by category — wins (green), stop-outs (red), risk-management
  // exits (amber). Lets the user scan a session log and immediately see
  // whether the loop is closing in profit or being walked out by stops.
  const reasonChip: Record<NonNullable<PaperPosition["close_reason"]>, string> = {
    stop: "text-red",
    tp: "text-green",
    manual: "text-mist",
    trail: "text-green",
    time: "text-amber",
    reverse: "text-amber",
    "swarm-flip": "text-amber",
  };
  const reasonLabel: Record<NonNullable<PaperPosition["close_reason"]>, string> = {
    stop: "stop",
    tp: "take profit",
    manual: "manual",
    trail: "trail",
    time: "time stop",
    reverse: "reverse",
    "swarm-flip": "swarm flip",
  };
  const reason = p.close_reason ?? "manual";
  return (
    <div className="flex items-center justify-between text-[0.7rem] num px-2 py-1 rounded-sm bg-black/20">
      <div className="flex items-center gap-2">
        <span className="font-mono text-slate-200">{p.asset}</span>
        <span className={p.side === "long" ? "text-green" : "text-red"}>
          {p.side === "long" ? "↑" : "↓"}
        </span>
        <span className="text-mist">{p.agent_id}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className={`text-[0.6rem] uppercase ${reasonChip[reason]}`}>
          {reasonLabel[reason]}
        </span>
        <span className={pnlColor}>
          {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
        </span>
      </div>
    </div>
  );
}
