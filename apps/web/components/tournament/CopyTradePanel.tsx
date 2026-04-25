"use client";

import { useMemo } from "react";
import type { AgentStats } from "@/lib/swarm";
import { agentFamily, FAMILY_COLORS } from "@/lib/swarm";
import type { CopyTradeSim, SimEvent, SimReaction } from "@/lib/simulate";
import { simulateCopyTrade } from "@/lib/simulate";

const LS_KEY = "pythia-copytrade-agent";

type Props = {
  agents: AgentStats[];
  selected: string | null; // agent_id to mirror; null → follow champion
  onSelect: (agent_id: string | null) => void;
  equity_usd: number;
  risk_fraction: number;
  btc_price: number;
  eth_price: number;
  reactions: SimReaction[];
  lastEvent: SimEvent | null;
};

export function CopyTradePanel({
  agents,
  selected,
  onSelect,
  equity_usd,
  risk_fraction,
  btc_price,
  eth_price,
  reactions,
  lastEvent,
}: Props) {
  const champion = agents[0] ?? null;
  const mirrored = useMemo(() => {
    if (!selected) return champion;
    return agents.find((a) => a.agent_id === selected) ?? champion;
  }, [agents, selected, champion]);

  const sim: CopyTradeSim | null =
    mirrored && lastEvent
      ? simulateCopyTrade(
          mirrored,
          lastEvent,
          reactions,
          equity_usd,
          risk_fraction,
          btc_price,
          eth_price,
        )
      : null;

  const saveSelection = (id: string | null) => {
    onSelect(id);
    try {
      if (id) localStorage.setItem(LS_KEY, id);
      else localStorage.removeItem(LS_KEY);
    } catch {
      // ignore
    }
  };

  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs uppercase tracking-[0.3em] text-mist">
          Copy trade
        </div>
        {mirrored ? (
          <span
            className="inline-flex items-center gap-1.5 text-[0.65rem] text-mist"
            title={agentFamily(mirrored.agent_id)}
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{
                background: FAMILY_COLORS[agentFamily(mirrored.agent_id)],
                boxShadow: `0 0 6px ${FAMILY_COLORS[agentFamily(mirrored.agent_id)]}`,
              }}
            />
            {agentFamily(mirrored.agent_id)}
          </span>
        ) : null}
      </div>

      {/* Agent selector — defaults to champion. min-w-0 + w-full keep the
          select inside its panel even when an option label is long; the
          earlier flex-1 alone could overflow because select inherits its
          intrinsic option width. */}
      <label className="block text-[0.7rem] text-mist mb-1">Mirror agent</label>
      <div className="mb-4 min-w-0">
        <select
          className="block w-full max-w-full bg-black/40 border border-edge rounded-sm px-2 py-1.5 text-xs num truncate appearance-none focus:border-cyan/60 outline-none"
          value={selected ?? "__champion__"}
          onChange={(e) => {
            const v = e.target.value;
            saveSelection(v === "__champion__" ? null : v);
          }}
        >
          <option value="__champion__">Champion · auto-follow #1</option>
          {agents.map((a, i) => (
            <option key={a.agent_id} value={a.agent_id}>
              #{i + 1} · {a.agent_id.replace(/^gen\d+-mut\d+-/, "")} ·{" "}
              {a.total_r >= 0 ? "+" : ""}
              {a.total_r.toFixed(1)}R
            </option>
          ))}
        </select>
      </div>

      {/* Mirrored agent stats. */}
      {mirrored ? (
        <div className="space-y-2 text-xs num mb-4">
          <div className="flex justify-between gap-2 min-w-0">
            <span className="text-mist shrink-0">Agent</span>
            <span
              className="font-mono text-slate-100 truncate text-right"
              title={mirrored.agent_id}
            >
              {mirrored.agent_id}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-mist">Σ R</span>
            <span className={mirrored.total_r >= 0 ? "text-green" : "text-red"}>
              {mirrored.total_r >= 0 ? "+" : ""}
              {mirrored.total_r.toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-mist">Win rate</span>
            <span>{(mirrored.win_rate * 100).toFixed(1)}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-mist">Decisions</span>
            <span>{mirrored.wins + mirrored.losses}</span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-mist mb-4">No agents in the swarm yet.</p>
      )}

      {/* What-if simulated trade. */}
      <div className="border-t border-edge/50 pt-4">
        <div className="text-[0.7rem] tracking-[0.25em] text-amber uppercase mb-2">
          If live + event fired
        </div>
        {sim ? (
          <div className="space-y-1.5 text-xs num">
            <div className="flex justify-between">
              <span className="text-mist">Direction</span>
              <span
                className={
                  sim.direction === "long" ? "text-green" : "text-red"
                }
              >
                {sim.direction.toUpperCase()}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-mist">Notional</span>
              <span>${sim.size_usd.toFixed(0)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-mist">Size</span>
              <span>
                {sim.size_contracts.toFixed(4)} {lastEvent?.asset}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-mist">Entry</span>
              <span>${sim.entry.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-mist">Stop</span>
              <span className="text-red">${sim.stop.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-mist">Take-profit</span>
              <span className="text-green">
                ${sim.take_profit.toFixed(2)}
              </span>
            </div>
          </div>
        ) : lastEvent ? (
          <p className="text-xs text-mist">
            Your mirrored agent didn&apos;t react to that event — it&apos;s
            watching different signals or the magnitude was below its
            trigger. Copy-trader stays flat.
          </p>
        ) : (
          <p className="text-xs text-mist">
            Fire an event on the left to see what this agent — and
            therefore your copy-trade — would do.
          </p>
        )}
      </div>
    </div>
  );
}
