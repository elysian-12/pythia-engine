"use client";

import { motion } from "framer-motion";

/**
 * The data pipeline as an animated flow: Kiyotaka events fan out to
 * the swarm, the scoreboard picks the champion, the paper-trader turns
 * the champion's signals into P&L. Each stage blinks and particles
 * travel between them.
 */
export function PipelineFlow() {
  const stages = [
    { label: "Kiyotaka API", sub: "liqs · funding · candles · Polymarket", color: "#22d3ee" },
    { label: "Swarm", sub: "25 agents · 6 rule families", color: "#a78bfa" },
    { label: "Scoreboard", sub: "Σ R · Sharpe · PSR / DSR", color: "#34d399" },
    { label: "Champion", sub: "ATR-risk · 1% / trade", color: "#fbbf24" },
    { label: "Equity curve", sub: "$1k → $64k", color: "#f472b6" },
  ];

  return (
    <section className="relative my-20 mx-auto max-w-6xl px-4">
      <div className="text-xs tracking-[0.3em] text-cyan uppercase text-center">
        Data pipeline
      </div>
      <h2 className="text-3xl md:text-4xl font-semibold text-slate-100 text-center mt-2">
        From raw API bytes to paper P&amp;L
      </h2>

      <div className="mt-10 flex flex-col md:flex-row items-stretch justify-between gap-4 md:gap-2">
        {stages.map((s, i) => (
          <div key={s.label} className="flex items-center w-full md:w-auto md:flex-1">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ delay: i * 0.12, duration: 0.45 }}
              className="panel relative flex-1 p-4 overflow-hidden"
              style={{
                boxShadow: `inset 0 0 0 1px ${s.color}22, 0 0 40px -12px ${s.color}55`,
              }}
            >
              <div
                className="absolute inset-0 opacity-20"
                style={{
                  background: `radial-gradient(circle at 20% 20%, ${s.color}33, transparent 60%)`,
                }}
              />
              <div
                className="relative num text-[10px] uppercase tracking-widest"
                style={{ color: s.color }}
              >
                stage 0{i + 1}
              </div>
              <div className="relative text-lg font-semibold mt-1 text-slate-100">
                {s.label}
              </div>
              <div className="relative text-xs text-mist mt-1">{s.sub}</div>
              <Particles color={s.color} />
            </motion.div>
            {i < stages.length - 1 && (
              <div className="hidden md:flex items-center justify-center mx-2 relative w-10 h-1">
                <motion.div
                  className="absolute h-[2px] w-full rounded-full"
                  style={{
                    background: `linear-gradient(90deg, ${s.color}, ${stages[i + 1].color})`,
                  }}
                  initial={{ scaleX: 0, transformOrigin: "0 0" }}
                  whileInView={{ scaleX: 1 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.12 + 0.3, duration: 0.35 }}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <motion.p
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        transition={{ delay: 1.0, duration: 0.6 }}
        className="mt-8 text-center text-sm text-mist max-w-2xl mx-auto"
      >
        Every stage is a pure-functional Rust crate with its own test
        suite. 80 tests green. The full backtest ablation on a year of
        Kiyotaka hourly bars completes in <span className="num text-cyan">403 ms</span>.
      </motion.p>
    </section>
  );
}

function Particles({ color }: { color: string }) {
  return (
    <div className="pointer-events-none absolute inset-0">
      {Array.from({ length: 6 }, (_, i) => (
        <motion.span
          key={i}
          className="absolute w-1 h-1 rounded-full"
          style={{ background: color, top: `${10 + i * 15}%`, left: "-4px" }}
          initial={{ x: 0, opacity: 0 }}
          animate={{ x: 260, opacity: [0, 1, 0] }}
          transition={{
            delay: i * 0.4,
            duration: 3.2,
            repeat: Infinity,
            ease: "linear",
          }}
        />
      ))}
    </div>
  );
}
