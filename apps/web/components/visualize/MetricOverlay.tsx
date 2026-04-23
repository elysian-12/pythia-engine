"use client";

import { motion } from "framer-motion";
import { CountUp } from "./CountUp";
import type { Summary } from "@/lib/vis-data";

export function MetricOverlay({ summary }: { summary: Summary }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-6 md:p-10">
      {/* Top bar */}
      <div className="flex items-start justify-between">
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.6 }}
          className="pointer-events-auto"
        >
          <div className="text-xs tracking-[0.3em] text-cyan uppercase">Pythia</div>
          <div className="text-xl font-semibold text-slate-100 mt-1">
            {summary.strategy}
          </div>
          <div className="text-xs text-mist mt-1">{summary.universe}</div>
        </motion.div>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="pointer-events-auto text-right"
        >
          <span className="chip chip-cyan">LIVE REPLAY</span>
          <div className="text-xs text-mist mt-2 num">
            {summary.data_points.toLocaleString()} data points
          </div>
        </motion.div>
      </div>

      {/* Center — headline */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 0.4 }}
        className="pointer-events-auto mx-auto text-center"
      >
        <div className="text-xs tracking-[0.3em] text-mist uppercase mb-2">
          365 days · real BTC + ETH perps · paper-traded
        </div>
        <div className="text-4xl md:text-6xl font-semibold text-slate-100">
          <span className="text-mist">$</span>
          <CountUp value={summary.starting_equity} commas />{" "}
          <span className="text-cyan">→</span>{" "}
          <span className="text-emerald-400">
            $<CountUp value={summary.final_equity} commas duration={2.2} />
          </span>
        </div>
        <div className="text-sm md:text-base text-mist mt-3">
          +<CountUp value={summary.roi_pct} decimals={1} suffix="%" />
          <span className="mx-2">·</span>
          <CountUp value={summary.n_trades} />
          <span className="ml-1">trades</span>
          <span className="mx-2">·</span>
          <CountUp value={summary.win_rate * 100} decimals={1} suffix="%" />
          <span className="ml-1">win rate</span>
        </div>
      </motion.div>

      {/* Bottom — metric cards */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 0.9 }}
        className="pointer-events-auto grid grid-cols-2 md:grid-cols-5 gap-3"
      >
        <MetricCard
          label="Sharpe / trade"
          value={<CountUp value={summary.sharpe} decimals={2} />}
          accent="cyan"
        />
        <MetricCard
          label="Sortino"
          value={<CountUp value={summary.sortino} decimals={2} />}
          accent="cyan"
        />
        <MetricCard
          label="Max DD"
          value={
            <>
              <CountUp
                value={summary.max_drawdown * 100}
                decimals={1}
                suffix="%"
              />
            </>
          }
          accent="green"
        />
        <MetricCard
          label="Profit factor"
          value={<CountUp value={summary.profit_factor} decimals={2} />}
          accent="green"
        />
        <MetricCard
          label="Calmar"
          value={<CountUp value={summary.calmar} decimals={0} />}
          accent="gold"
        />
      </motion.div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  accent: "cyan" | "green" | "gold";
}) {
  const accentRing =
    accent === "cyan"
      ? "before:bg-cyan/70"
      : accent === "green"
      ? "before:bg-emerald-400/70"
      : "before:bg-amber-300/70";
  return (
    <div
      className={`panel relative overflow-hidden p-3 before:absolute before:top-0 before:left-0 before:h-full before:w-[2px] ${accentRing}`}
    >
      <div className="text-[10px] uppercase tracking-widest text-mist">
        {label}
      </div>
      <div className="text-xl font-semibold text-slate-100 mt-1">{value}</div>
    </div>
  );
}
