"use client";

import { agentFamily, FAMILY_COLORS, type AgentStats } from "@/lib/swarm";

export function Leaderboard({ agents }: { agents: AgentStats[] }) {
  return (
    <div className="panel p-4 flex flex-col h-[520px]">
      <div className="flex items-center justify-between mb-3 shrink-0">
        <div className="text-xs uppercase tracking-[0.3em] text-mist">
          Swarm scoreboard
        </div>
        <div className="text-[0.65rem] text-mist num">
          ranked by Σ R · {" "}
          {agents.length} {agents.length === 1 ? "agent" : "agents"}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto -mx-1 px-1">
        <table className="w-full text-xs">
          <caption className="sr-only">
            Pythia agent scoreboard, ranked by total R-multiple (Σ R).
            Columns: trades, win rate, Σ R, expectancy E[R], profit
            factor, Sharpe, max drawdown, PnL in dollars. Secondary
            stats (E[R], PF, Sharpe, Max DD, PnL$) are hidden on
            mobile to keep the table within ~360 px viewports.
          </caption>
          <thead className="text-[0.65rem] text-mist uppercase sticky top-0 bg-panel">
            <tr>
              <th scope="col" className="text-left py-2 pr-2">#</th>
              <th scope="col" className="text-left py-2 pr-2">Agent</th>
              <th
                scope="col"
                className="text-right py-2 pr-2"
                title="Total closed trades"
              >
                Trades
              </th>
              <th scope="col" className="text-right py-2 pr-2">Win %</th>
              <th scope="col" className="text-right py-2 pr-2" title="Σ R-multiple">Σ R</th>
              <th
                scope="col"
                className="hidden md:table-cell text-right py-2 pr-2"
                title="Average R per trade (Van Tharp expectancy)"
              >
                E[R]
              </th>
              <th
                scope="col"
                className="hidden md:table-cell text-right py-2 pr-2"
                title="Profit factor = gross win R / gross loss R"
              >
                PF
              </th>
              <th
                scope="col"
                className="hidden md:table-cell text-right py-2 pr-2"
                title="Sharpe of per-trade R-multiples"
              >
                Sharpe
              </th>
              <th
                scope="col"
                className="hidden md:table-cell text-right py-2 pr-2"
                title="Max drawdown in cumulative R"
              >
                Max DD
              </th>
              <th scope="col" className="hidden sm:table-cell text-right py-2">PnL $</th>
            </tr>
          </thead>
          <tbody className="num">
            {agents.map((a, i) => {
              const family = agentFamily(a.agent_id);
              const color = FAMILY_COLORS[family] ?? "#94a3b8";
              const rClass =
                a.total_r > 0
                  ? "text-green"
                  : a.total_r < 0
                    ? "text-red"
                    : "text-mist";
              const rank = i + 1;
              return (
                <tr
                  key={a.agent_id}
                  className={`border-b border-edge/40 ${
                    i === 0 ? "bg-amber/5" : ""
                  } hover:bg-edge/30 transition-colors`}
                >
                  <td className="py-1.5 pr-2 text-mist">
                    {i === 0 ? (
                      <span aria-label="champion (rank 1)">👑</span>
                    ) : (
                      rank
                    )}
                  </td>
                  <td className="py-1.5 pr-2">
                    <span
                      className="inline-block w-2 h-2 rounded-full mr-2 align-middle"
                      style={{ background: color, boxShadow: `0 0 6px ${color}` }}
                    />
                    <span className="font-mono text-slate-200">
                      {a.agent_id}
                    </span>
                  </td>
                  <td className="py-1.5 pr-2 text-right text-slate-300">
                    {a.wins + a.losses}
                  </td>
                  <td className="py-1.5 pr-2 text-right text-slate-300">
                    {(a.win_rate * 100).toFixed(1)}
                  </td>
                  <td className={`py-1.5 pr-2 text-right ${rClass}`}>
                    {a.total_r >= 0 ? "+" : ""}
                    {a.total_r.toFixed(2)}
                  </td>
                  <td
                    className={`hidden md:table-cell py-1.5 pr-2 text-right ${
                      (a.expectancy_r ?? 0) > 0
                        ? "text-green"
                        : (a.expectancy_r ?? 0) < 0
                          ? "text-red"
                          : "text-mist"
                    }`}
                  >
                    {a.expectancy_r !== undefined
                      ? (a.expectancy_r >= 0 ? "+" : "") + a.expectancy_r.toFixed(2)
                      : "—"}
                  </td>
                  <td
                    className={`hidden md:table-cell py-1.5 pr-2 text-right ${
                      (a.profit_factor ?? 0) >= 1.5
                        ? "text-green"
                        : (a.profit_factor ?? 0) >= 1.0
                          ? "text-amber"
                          : (a.profit_factor ?? 0) > 0
                            ? "text-red"
                            : "text-mist"
                    }`}
                  >
                    {a.profit_factor !== undefined && Number.isFinite(a.profit_factor)
                      ? a.profit_factor.toFixed(2)
                      : a.profit_factor === undefined
                        ? "—"
                        : "∞"}
                  </td>
                  <td
                    className={`hidden md:table-cell py-1.5 pr-2 text-right ${
                      a.rolling_sharpe > 0.5
                        ? "text-green"
                        : a.rolling_sharpe > 0
                          ? "text-amber"
                          : a.rolling_sharpe < 0
                            ? "text-red"
                            : "text-mist"
                    }`}
                  >
                    {(a.wins + a.losses) > 1
                      ? a.rolling_sharpe.toFixed(2)
                      : "—"}
                  </td>
                  <td className="hidden md:table-cell py-1.5 pr-2 text-right text-mist">
                    {a.max_drawdown_r !== undefined
                      ? `-${a.max_drawdown_r.toFixed(2)}`
                      : "—"}
                  </td>
                  <td className={`hidden sm:table-cell py-1.5 text-right ${rClass}`}>
                    {a.total_pnl_usd >= 0 ? "+" : ""}
                    {a.total_pnl_usd.toFixed(0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
