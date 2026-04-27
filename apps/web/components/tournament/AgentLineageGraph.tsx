"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import { agentFamily, FAMILY_COLORS, type AgentStats } from "@/lib/swarm";

// Force-directed lineage graph for the tournament page. One node per
// live agent; edges connect each mutant to its parent agent (or a
// phantom seed if the parent isn't in the live population). Champion
// glows gold; family colours distinguish strategy branches. Hover for
// stats, drag to rearrange.
//
// Implementation notes:
//   - d3-force runs ~300 simulation ticks on mount + on snapshot
//     change. Position state lives in refs to avoid re-renders during
//     the physics loop.
//   - Drag: pin via fx/fy while held, release on mouseup. Native
//     pointer events; no react-three-fiber dependency.
//   - Edges drawn from mutant → parent. Multi-level mutants
//     (`gen138-mut1525-gen3-mut37-vol-breakout-v0`) chain up to the
//     nearest live ancestor, otherwise fall back to a synthetic seed.

type Props = {
  agents: AgentStats[];
  championId?: string | null;
  generation?: number;
};

type GraphNode = SimulationNodeDatum & {
  id: string;
  family: ReturnType<typeof agentFamily>;
  agent?: AgentStats;
  isChampion: boolean;
  isSeed: boolean;
  size: number; // radius in px
};

type GraphLink = SimulationLinkDatum<GraphNode>;

const WIDTH = 900;
const HEIGHT = 520;

/** Strip a single `genN-mutXX-` prefix to peel one ancestor up. */
function peelOneLevel(id: string): string | null {
  const m = id.match(/^gen\d+(?:-mut\d+)?-(.+)$/);
  return m ? m[1] : null;
}

/** Walk up the mutation chain until either we hit an id that's in
 *  `liveIds` (the parent edge target) or we exhaust prefixes (seed).
 *  Returns the first live ancestor's id, or the bare seed name. */
function resolveParent(id: string, liveIds: Set<string>): string | null {
  let cursor: string | null = peelOneLevel(id);
  while (cursor) {
    if (liveIds.has(cursor)) return cursor;
    const next = peelOneLevel(cursor);
    if (!next) return cursor; // bare seed name like "vol-breakout-v0"
    cursor = next;
  }
  return null;
}

export function AgentLineageGraph({
  agents,
  championId = null,
  generation = 0,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [tick, setTick] = useState(0); // bumped each simulation tick to re-render
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const draggingRef = useRef<GraphNode | null>(null);
  const simRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);

  // Build nodes + links from the live agents. Memoised on the
  // identity-derivable fields (id, total_r, win_rate) so the
  // simulation doesn't restart on every parent re-render.
  const { nodes, links } = useMemo(() => {
    if (agents.length === 0) {
      return { nodes: [] as GraphNode[], links: [] as GraphLink[] };
    }
    const liveIds = new Set(agents.map((a) => a.agent_id));
    const maxR = Math.max(1, ...agents.map((a) => Math.abs(a.total_r)));
    const liveNodes: GraphNode[] = agents.map((a) => {
      const family = agentFamily(a.agent_id);
      const sizeR = 6 + (Math.abs(a.total_r) / maxR) * 14; // 6..20 px
      return {
        id: a.agent_id,
        family,
        agent: a,
        isChampion: a.agent_id === championId,
        isSeed: false,
        size: sizeR,
      };
    });

    // Edges: each agent links to its first live ancestor (or to a
    // synthetic seed node if the chain leaves the live set).
    const linksOut: GraphLink[] = [];
    const seedNodes: GraphNode[] = [];
    const seenSeeds = new Set<string>();
    for (const n of liveNodes) {
      const parent = resolveParent(n.id, liveIds);
      if (!parent) continue;
      if (liveIds.has(parent)) {
        linksOut.push({ source: n.id, target: parent });
      } else {
        if (!seenSeeds.has(parent)) {
          seenSeeds.add(parent);
          seedNodes.push({
            id: parent,
            family: agentFamily(parent),
            isChampion: false,
            isSeed: true,
            size: 4,
          });
        }
        linksOut.push({ source: n.id, target: parent });
      }
    }
    return { nodes: [...liveNodes, ...seedNodes], links: linksOut };
  }, [agents, championId]);

  // Set up + tick the d3-force simulation.
  //
  // Stability tuning (the prior config let the graph "explode" off-
  // screen):
  //   - charge strength dropped from -220 to -90 so nodes don't shove
  //     each other into the next county
  //   - forceCenter still pulls toward the middle, but we add gentle
  //     forceX/forceY anchors so a single hub-and-spoke seed doesn't
  //     drag the whole cluster off centre
  //   - clamp x/y to viewport bounds inside the tick handler — d3
  //     doesn't do this natively, and a single bad config is enough
  //     to launch a node into oblivion. Belt + suspenders
  //   - velocityDecay bumped to 0.45 (default 0.4) so nodes settle
  //     a touch quicker once forces equalise
  useEffect(() => {
    if (nodes.length === 0) return;
    const sim = forceSimulation<GraphNode>(nodes)
      .force(
        "link",
        forceLink<GraphNode, GraphLink>(links)
          .id((d) => d.id)
          .distance((l) => {
            const s = l.source as GraphNode;
            const t = l.target as GraphNode;
            return s.family === t.family ? 55 : 95;
          })
          .strength(0.2),
      )
      .force("charge", forceManyBody<GraphNode>().strength(-90))
      .force("center", forceCenter(WIDTH / 2, HEIGHT / 2))
      .force("anchorX", forceX<GraphNode>(WIDTH / 2).strength(0.05))
      .force("anchorY", forceY<GraphNode>(HEIGHT / 2).strength(0.05))
      .force(
        "collide",
        forceCollide<GraphNode>()
          .radius((d) => d.size + 3)
          .strength(0.9),
      )
      .velocityDecay(0.45)
      .alpha(1)
      .alphaDecay(0.03);

    let frame = 0;
    const margin = 8;
    const onTick = () => {
      frame++;
      // Hard-clamp every node to viewport bounds. Without this any
      // transient over-correction (e.g. a single hub edge) can yeet
      // a leaf node off the canvas before the dampening catches up.
      for (const n of nodes) {
        const r = n.size + margin;
        if (n.x == null) n.x = WIDTH / 2;
        if (n.y == null) n.y = HEIGHT / 2;
        n.x = Math.max(r, Math.min(WIDTH - r, n.x));
        n.y = Math.max(r, Math.min(HEIGHT - r, n.y));
      }
      // Throttle re-renders — every other tick is plenty for 60fps.
      if (frame % 2 === 0) setTick((t) => t + 1);
    };
    sim.on("tick", onTick);
    simRef.current = sim;
    return () => {
      sim.stop();
      simRef.current = null;
    };
  }, [nodes, links]);

  // Drag handlers — `setPointerCapture` was the bug in the prior
  // version: it redirected pointermove to the captured circle so the
  // svg-level handler never fired. Now drags are tracked through a
  // window-level pointermove/pointerup pair, which works even if the
  // cursor leaves the svg viewport mid-drag.
  const screenToSvg = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    return pt.matrixTransform(ctm.inverse());
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const n = draggingRef.current;
      if (!n) return;
      const local = screenToSvg(e.clientX, e.clientY);
      if (!local) return;
      n.fx = local.x;
      n.fy = local.y;
      // Keep the sim warm so neighbours respond to the drag.
      if (simRef.current) simRef.current.alphaTarget(0.3);
    };
    const onUp = () => {
      const n = draggingRef.current;
      if (!n) return;
      n.fx = null;
      n.fy = null;
      draggingRef.current = null;
      if (simRef.current) simRef.current.alphaTarget(0);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  const onPointerDownNode = (e: React.PointerEvent, n: GraphNode) => {
    e.stopPropagation();
    e.preventDefault();
    draggingRef.current = n;
    // Pin to the node's current position immediately so the first
    // move doesn't snap from (null,null).
    n.fx = n.x ?? WIDTH / 2;
    n.fy = n.y ?? HEIGHT / 2;
    if (simRef.current) {
      simRef.current.alphaTarget(0.3).restart();
    }
  };

  if (nodes.length === 0) {
    return null;
  }

  return (
    <section className="panel p-4 sm:p-5 relative">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div className="text-xs uppercase tracking-[0.3em] text-mist">
          Agent lineage
        </div>
        <div className="text-[0.65rem] text-mist num">
          gen {generation} · {nodes.filter((n) => !n.isSeed).length} agents · {links.length} edges
        </div>
      </div>
      <p className="text-[0.65rem] text-mist mb-3 max-w-2xl leading-relaxed">
        Each node is an agent; bigger = more cumulative R. Edges link
        each mutant to its parent (or to a phantom seed when the
        ancestor predates the current generation). Champion glows gold.
        Hover for stats, drag to rearrange.
      </p>
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="w-full h-auto rounded-sm bg-black/40 border border-edge/40 select-none touch-none"
          aria-label={`Force-directed lineage graph: ${nodes.filter((n) => !n.isSeed).length} agents linked by mutation`}
        >
          {/* Edges */}
          <g stroke="#3b3b46" strokeOpacity={0.55} strokeWidth={0.8}>
            {links.map((l, i) => {
              const s = l.source as GraphNode;
              const t = l.target as GraphNode;
              if (s.x == null || t.x == null) return null;
              return (
                <line
                  key={i}
                  x1={s.x}
                  y1={s.y!}
                  x2={t.x}
                  y2={t.y!}
                />
              );
            })}
          </g>
          {/* Nodes */}
          <g>
            {nodes.map((n) => {
              if (n.x == null || n.y == null) return null;
              const fam = (FAMILY_COLORS as Record<string, string>)[n.family] ?? "#94a3b8";
              const isHover = hovered?.id === n.id;
              const ring = n.isChampion ? "#fbbf24" : isHover ? "#22d3ee" : null;
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  className="cursor-pointer"
                  onPointerDown={(e) => onPointerDownNode(e, n)}
                  onPointerEnter={() => setHovered(n)}
                  onPointerLeave={() => setHovered((h) => (h?.id === n.id ? null : h))}
                >
                  {n.isChampion ? (
                    <circle
                      r={n.size + 6}
                      fill="none"
                      stroke="#fbbf24"
                      strokeWidth={1.5}
                      opacity={0.6}
                    >
                      <animate
                        attributeName="r"
                        values={`${n.size + 4};${n.size + 9};${n.size + 4}`}
                        dur="2.4s"
                        repeatCount="indefinite"
                      />
                      <animate
                        attributeName="opacity"
                        values="0.7;0.25;0.7"
                        dur="2.4s"
                        repeatCount="indefinite"
                      />
                    </circle>
                  ) : null}
                  <circle
                    r={n.size}
                    fill={n.isSeed ? "#1f2937" : fam}
                    fillOpacity={n.isSeed ? 0.6 : 0.85}
                    stroke={ring ?? (n.isSeed ? fam : "#0b0f14")}
                    strokeWidth={ring ? 2 : 1.2}
                    style={
                      n.isChampion || isHover
                        ? { filter: `drop-shadow(0 0 6px ${ring})` }
                        : undefined
                    }
                  />
                </g>
              );
            })}
          </g>
        </svg>

        {/* Hover tooltip — anchored to top-right so it doesn't follow
            the cursor and obscure neighbouring nodes. */}
        {hovered ? (
          <div className="absolute top-12 right-4 panel p-3 bg-black/90 backdrop-blur-sm max-w-[280px] text-[0.7rem] num pointer-events-none">
            <div className="font-mono text-slate-100 break-all">
              {hovered.isChampion ? "👑 " : ""}
              {hovered.id.replace(/^gen\d+-mut\d+-/, "")}
            </div>
            <div className="text-[0.6rem] text-mist mt-0.5">
              {hovered.isSeed ? "phantom seed (ancestor not in live set)" : `family: ${hovered.family}`}
            </div>
            {hovered.agent ? (
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2">
                <span>
                  <span className="text-mist">Σ R</span>{" "}
                  <span className={hovered.agent.total_r >= 0 ? "text-green" : "text-red"}>
                    {hovered.agent.total_r >= 0 ? "+" : ""}
                    {hovered.agent.total_r.toFixed(2)}
                  </span>
                </span>
                <span>
                  <span className="text-mist">WR</span>{" "}
                  {(hovered.agent.win_rate * 100).toFixed(1)}%
                </span>
                <span>
                  <span className="text-mist">trades</span>{" "}
                  {hovered.agent.wins + hovered.agent.losses}
                </span>
                <span>
                  <span className="text-mist">Sharpe</span>{" "}
                  {hovered.agent.rolling_sharpe.toFixed(2)}
                </span>
                <span className="col-span-2">
                  <span className="text-mist">last R</span>{" "}
                  <span
                    className={
                      hovered.agent.last_r >= 0 ? "text-green" : "text-red"
                    }
                  >
                    {hovered.agent.last_r >= 0 ? "+" : ""}
                    {hovered.agent.last_r.toFixed(2)}
                  </span>
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Family legend */}
      <div className="mt-3 flex flex-wrap gap-3 text-[0.6rem] text-mist">
        {(["liq-trend", "liq-fade", "vol-breakout", "funding-trend", "funding-arb", "polyedge", "polyfusion", "llm"] as const).map((f) => (
          <span key={f} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ background: (FAMILY_COLORS as Record<string, string>)[f] }}
            />
            <span className="font-mono uppercase tracking-widest">{f}</span>
          </span>
        ))}
      </div>
      <span className="sr-only">tick {tick}</span>
    </section>
  );
}
