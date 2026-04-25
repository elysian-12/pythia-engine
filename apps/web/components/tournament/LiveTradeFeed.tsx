"use client";

import type { SimEvent, SimReaction } from "@/lib/simulate";
import { FAMILY_COLORS } from "@/lib/swarm";

export type FeedEntry = {
  id: string;
  ts: number;
  event: SimEvent;
  reactions: SimReaction[];
  championId: string | null;
  /** Wall-clock latency from event-arrival → trade-sent, in ms. */
  latencyMs?: number;
  /** Router decision for this event — which specialist owns the kind,
   *  what direction the ensemble vote landed on, and why we did or
   *  didn't trade. */
  routing?: {
    specialist_id: string | null;
    specialist_short: string | null;
    fired_count: number;
    total_reactors: number;
    vote_direction: "long" | "short" | "flat";
    conviction: number;
    decision_direction: "long" | "short" | null;
    size_factor: number;
    rationale: string;
  };
};

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function LiveTradeFeed({ entries }: { entries: FeedEntry[] }) {
  return (
    <div className="panel p-5 flex flex-col h-[480px]">
      <div className="flex items-center justify-between mb-3 shrink-0">
        <div className="text-xs uppercase tracking-[0.3em] text-mist">
          Trade feed
        </div>
        <div className="text-[0.65rem] text-mist num">
          {entries.length === 0
            ? "no events yet"
            : `${entries.length} events · newest on top`}
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-mist text-center px-4">
          Fire an event on the left to see the swarm react here — each
          row is one event and the agents that would have traded on it.
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-3">
          {entries.map((e) => (
            <EventRow key={e.id} entry={e} />
          ))}
        </div>
      )}
    </div>
  );
}

function EventRow({ entry }: { entry: FeedEntry }) {
  const firing = entry.reactions.filter((r) => r.reacted);
  const longs = firing.filter((r) => r.direction === "long").length;
  const shorts = firing.length - longs;
  const champion = firing.find((r) => r.agent_id === entry.championId);
  const eventLabel = entry.event.kind.replace("-", " ");

  return (
    <div className="border border-edge/60 rounded-sm bg-black/20">
      {/* Top line: event meta — wraps cleanly when the panel is narrow. */}
      <div className="px-3 py-2 border-b border-edge/50 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[0.7rem]">
        <span className="num text-mist shrink-0">{fmtTime(entry.ts)}</span>
        <span className="font-mono text-slate-100 uppercase tracking-wider shrink-0">
          {eventLabel}
        </span>
        <span className="font-mono text-cyan shrink-0">{entry.event.asset}</span>
        <span className="text-mist num shrink-0">
          |z|={entry.event.magnitude_z.toFixed(2)}
        </span>
        <span
          className={`shrink-0 ${
            entry.event.direction === "long" ? "text-green" : "text-red"
          }`}
        >
          {entry.event.direction === "long" ? "↑" : "↓"}
          {entry.event.direction.toUpperCase()}
        </span>
        <span className="grow" />
        <span className="text-[0.65rem] num shrink-0 flex items-center gap-2">
          <span className="text-green">{longs}L</span>
          <span className="text-red">{shorts}S</span>
          <span className="text-mist">
            {firing.length}/{entry.reactions.length} fired
          </span>
          {entry.latencyMs != null ? (
            <span
              className="text-cyan"
              title="Latency from event arrival to trade-sent"
            >
              {entry.latencyMs}ms
            </span>
          ) : null}
        </span>
      </div>
      <div className="px-3 py-2 flex flex-wrap gap-1.5">
        {firing.length === 0 ? (
          <span className="text-[0.7rem] text-mist italic">
            No agent took this — below trigger or wrong signal type.
          </span>
        ) : (
          firing.map((r) => {
            const isChamp = r.agent_id === entry.championId;
            return (
              <span
                key={r.agent_id}
                className={`inline-flex items-center gap-1 text-[0.65rem] font-mono px-1.5 py-0.5 rounded-sm ${
                  isChamp
                    ? "bg-amber/10 text-amber ring-1 ring-amber/40"
                    : "bg-edge/40 text-slate-300"
                }`}
                title={r.rationale}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{
                    background: FAMILY_COLORS[r.family],
                    boxShadow: `0 0 5px ${FAMILY_COLORS[r.family]}`,
                  }}
                />
                <span>
                  {isChamp ? "👑 " : ""}
                  {r.agent_id}
                </span>
                <span
                  className={
                    r.direction === "long" ? "text-green" : "text-red"
                  }
                >
                  {r.direction === "long" ? "↑" : "↓"}
                </span>
              </span>
            );
          })
        )}
      </div>
      {/* Router footer — shows which specialist owns this event kind,
          the ensemble vote, and the resulting trade decision. Replaces
          the old "did the global champion fire?" copy with the actual
          routing math the system executes. */}
      {entry.routing ? (
        <RouterFooter routing={entry.routing} latencyMs={entry.latencyMs} />
      ) : champion ? (
        <div className="px-3 py-1.5 border-t border-amber/20 bg-amber/5 text-[0.65rem] text-amber flex items-center justify-between gap-2">
          <span>
            Copy-trader would {champion.direction === "long" ? "GO LONG" : "GO SHORT"} —
            champion fired.
          </span>
          {entry.latencyMs != null ? (
            <span className="num text-cyan/80">{entry.latencyMs}ms event→sent</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RouterFooter({
  routing,
  latencyMs,
}: {
  routing: NonNullable<FeedEntry["routing"]>;
  latencyMs?: number;
}) {
  const trading = routing.decision_direction != null;
  const dirColor = trading
    ? routing.decision_direction === "long"
      ? "text-green"
      : "text-red"
    : "text-mist";
  const tone = trading
    ? "border-amber/30 bg-amber/5"
    : "border-edge/50 bg-edge/10";
  return (
    <div
      className={`px-3 py-1.5 border-t ${tone} text-[0.65rem] flex flex-wrap items-baseline gap-x-3 gap-y-1`}
    >
      <span className="font-mono">
        <span className="text-purple-300">{routing.specialist_short ?? "—"}</span>
        <span className="text-mist/60"> specialist</span>
      </span>
      <span className="text-mist">
        <span className="num text-slate-200">
          {routing.fired_count}/{routing.total_reactors}
        </span>{" "}
        fired
      </span>
      <span className={`uppercase ${dirColor}`}>
        {trading ? routing.decision_direction : "FLAT"}
      </span>
      <span className="text-mist">
        conviction <span className="num">{routing.conviction.toFixed(2)}</span>
      </span>
      {trading ? (
        <span className="text-mist">
          size <span className="num">{(routing.size_factor * 100).toFixed(0)}%</span>
        </span>
      ) : null}
      <span className="grow" />
      {latencyMs != null ? (
        <span className="num text-cyan/80">{latencyMs}ms</span>
      ) : null}
    </div>
  );
}
