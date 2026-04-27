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

// Force-directed lineage graph projected onto a slowly-rotating
// virtual globe. SVG only — no three.js, but the orthographic
// sphere projection + per-node depth scaling + dim-back-of-globe
// gives a believable 3D feel.
//
// Interactions:
//   - Drag empty space          → rotates the globe (yaw + pitch)
//   - Drag a node               → moves the node on the underlying
//                                 2D layout; sphere projection
//                                 follows. Releases re-energise the
//                                 force sim so neighbours rearrange.
//   - Click / tap a node        → pins the details panel for that
//                                 agent. Works on touch where hover
//                                 doesn't fire.
//   - Click empty space         → clears the selection
//
// Champion gets a 2x size halo + crown label + is always rendered on
// top (no depth fade) so it's unmissable.

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
  size: number; // base radius in 2D space
};

type GraphLink = SimulationLinkDatum<GraphNode>;

const WIDTH = 900;
const HEIGHT = 560;
const SPHERE_RADIUS = Math.min(WIDTH, HEIGHT) * 0.42;
const CENTER_X = WIDTH / 2;
const CENTER_Y = HEIGHT / 2;

function peelOneLevel(id: string): string | null {
  const m = id.match(/^gen\d+(?:-mut\d+)?-(.+)$/);
  return m ? m[1] : null;
}

function resolveParent(id: string, liveIds: Set<string>): string | null {
  let cursor: string | null = peelOneLevel(id);
  while (cursor) {
    if (liveIds.has(cursor)) return cursor;
    const next = peelOneLevel(cursor);
    if (!next) return cursor;
    cursor = next;
  }
  return null;
}

/** Map 2D layout (x ∈ [0, W], y ∈ [0, H]) to lon/lat on the sphere
 *  surface, then apply the current camera rotation, then orthographic-
 *  project to screen. Returns screen coords + a depth value in [-1, 1]
 *  where +1 = front of globe (closest to viewer), -1 = far back. */
function project(
  x2d: number,
  y2d: number,
  yaw: number,
  pitch: number,
): { sx: number; sy: number; depth: number } {
  const lon = ((x2d - CENTER_X) / CENTER_X) * Math.PI; // [-π, π]
  const lat = ((y2d - CENTER_Y) / CENTER_Y) * (Math.PI / 2); // [-π/2, π/2]
  // Apply yaw to longitude, pitch to latitude.
  const adjLon = lon + yaw;
  const adjLat = lat + pitch;
  // Sphere coords (R = 1).
  const cy = Math.cos(adjLat);
  const sx_sphere = cy * Math.sin(adjLon);
  const sy_sphere = Math.sin(adjLat);
  const sz_sphere = cy * Math.cos(adjLon);
  // Orthographic projection to screen.
  const sx = CENTER_X + sx_sphere * SPHERE_RADIUS;
  const sy = CENTER_Y - sy_sphere * SPHERE_RADIUS; // flip Y for screen
  return { sx, sy, depth: sz_sphere };
}

export function AgentLineageGraph({
  agents,
  championId = null,
  generation = 0,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [, forceRerender] = useState(0);
  const tickCount = useRef(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Camera rotation. Refs (not state) so updating during a drag
  // doesn't trigger React re-renders for every mouse move; the rAF
  // loop drives the visual update.
  const yawRef = useRef(0);
  const pitchRef = useRef(0);

  // Drag bookkeeping. dragMode tells the global pointermove handler
  // whether to move a node or rotate the camera.
  const dragRef = useRef<
    | { mode: "node"; node: GraphNode; startX: number; startY: number; moved: boolean }
    | { mode: "camera"; lastX: number; lastY: number }
    | null
  >(null);

  const simRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);

  const { nodes, links } = useMemo(() => {
    if (agents.length === 0) {
      return { nodes: [] as GraphNode[], links: [] as GraphLink[] };
    }
    const liveIds = new Set(agents.map((a) => a.agent_id));
    const maxR = Math.max(1, ...agents.map((a) => Math.abs(a.total_r)));
    const liveNodes: GraphNode[] = agents.map((a) => {
      const family = agentFamily(a.agent_id);
      const sizeR = 7 + (Math.abs(a.total_r) / maxR) * 13;
      return {
        id: a.agent_id,
        family,
        agent: a,
        isChampion: a.agent_id === championId,
        isSeed: false,
        size: sizeR,
      };
    });

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
            size: 4.5,
          });
        }
        linksOut.push({ source: n.id, target: parent });
      }
    }
    return { nodes: [...liveNodes, ...seedNodes], links: linksOut };
  }, [agents, championId]);

  // Force simulation in 2D. The 2D positions feed sphere projection
  // (lon = x, lat = y) so a balanced 2D layout maps to a balanced
  // distribution on the globe.
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
            return s.family === t.family ? 60 : 100;
          })
          .strength(0.18),
      )
      .force("charge", forceManyBody<GraphNode>().strength(-80))
      .force("center", forceCenter(CENTER_X, CENTER_Y))
      .force("anchorX", forceX<GraphNode>(CENTER_X).strength(0.04))
      .force("anchorY", forceY<GraphNode>(CENTER_Y).strength(0.04))
      .force(
        "collide",
        forceCollide<GraphNode>()
          .radius((d) => d.size + 4)
          .strength(0.9),
      )
      .velocityDecay(0.5)
      .alpha(1)
      .alphaDecay(0.035);

    const margin = 8;
    const onTick = () => {
      // Clamp 2D positions inside [margin, W-margin] × [margin, H-margin]
      // so the projection stays well-defined and nothing escapes.
      for (const n of nodes) {
        if (n.x == null) n.x = CENTER_X;
        if (n.y == null) n.y = CENTER_Y;
        n.x = Math.max(margin, Math.min(WIDTH - margin, n.x));
        n.y = Math.max(margin, Math.min(HEIGHT - margin, n.y));
      }
    };
    sim.on("tick", onTick);
    simRef.current = sim;
    return () => {
      sim.stop();
      simRef.current = null;
    };
  }, [nodes, links]);

  // rAF loop — auto-rotation + render. Slows when interacting so
  // the user's drag isn't fighting an auto-spin.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      const dt = t - last;
      last = t;
      // Auto-yaw at ~1 revolution / 90s, pause while user is dragging
      // the camera. Pitch doesn't auto-spin.
      if (!dragRef.current || dragRef.current.mode !== "camera") {
        yawRef.current += (dt / 1000) * (Math.PI * 2 / 90);
      }
      tickCount.current++;
      // Re-render every other frame is fine.
      if (tickCount.current % 2 === 0) forceRerender((c) => c + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Window-level pointer handlers — work even when the cursor leaves
  // the SVG, work on touch (pointercancel cleans up).
  useEffect(() => {
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
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.mode === "camera") {
        const dx = e.clientX - drag.lastX;
        const dy = e.clientY - drag.lastY;
        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
        // Mouse moves 1px → 0.5° rotation. Scale to taste.
        yawRef.current += dx * 0.006;
        pitchRef.current = Math.max(
          -Math.PI / 2 + 0.1,
          Math.min(Math.PI / 2 - 0.1, pitchRef.current + dy * 0.006),
        );
        return;
      }
      // node drag — translate from screen to 2D layout coords through
      // the inverse of the current camera projection. Approximation:
      // assume small motion → just update the node's 2D x/y by the
      // screen delta divided by SPHERE_RADIUS scale.
      const local = screenToSvg(e.clientX, e.clientY);
      if (!local) return;
      const dxScreen = local.x - CENTER_X;
      const dyScreen = -(local.y - CENTER_Y);
      // Reverse-project from screen → sphere (assume z = +1 hemisphere
      // i.e. front of globe). For the back hemisphere the math
      // degenerates; we accept the small inaccuracy because drags on
      // back-of-globe nodes should rotate the camera first anyway.
      const r = Math.min(SPHERE_RADIUS, Math.sqrt(dxScreen * dxScreen + dyScreen * dyScreen));
      const lon =
        Math.atan2(dxScreen, Math.sqrt(SPHERE_RADIUS * SPHERE_RADIUS - r * r));
      const lat = Math.asin(dyScreen / SPHERE_RADIUS);
      // Subtract the current camera rotation to get the underlying
      // 2D layout position.
      const adjLon = lon - yawRef.current;
      const adjLat = lat - pitchRef.current;
      drag.node.fx =
        CENTER_X + (adjLon / Math.PI) * CENTER_X;
      drag.node.fy =
        CENTER_Y + (adjLat / (Math.PI / 2)) * CENTER_Y;
      drag.moved = true;
      if (simRef.current) simRef.current.alphaTarget(0.25);
    };
    const onUp = (_e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.mode === "node") {
        // If the pointer barely moved, treat as a click → select.
        if (!drag.moved) {
          setSelectedId((cur) => (cur === drag.node.id ? null : drag.node.id));
        }
        drag.node.fx = null;
        drag.node.fy = null;
        if (simRef.current) simRef.current.alphaTarget(0);
      }
      dragRef.current = null;
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
    dragRef.current = {
      mode: "node",
      node: n,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    n.fx = n.x ?? CENTER_X;
    n.fy = n.y ?? CENTER_Y;
    if (simRef.current) simRef.current.alphaTarget(0.25).restart();
  };
  const onPointerDownBackground = (e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = {
      mode: "camera",
      lastX: e.clientX,
      lastY: e.clientY,
    };
  };
  const onClickBackground = () => {
    setSelectedId(null);
  };

  if (nodes.length === 0) return null;

  // Pre-compute projected positions for this render.
  const yaw = yawRef.current;
  const pitch = pitchRef.current;
  const projected = nodes.map((n) => {
    const x = n.x ?? CENTER_X;
    const y = n.y ?? CENTER_Y;
    const p = project(x, y, yaw, pitch);
    return { node: n, ...p };
  });
  // Draw order: champion always last. Otherwise back-to-front by
  // depth so the front-of-globe nodes appear on top.
  projected.sort((a, b) => {
    if (a.node.isChampion !== b.node.isChampion) return a.node.isChampion ? 1 : -1;
    return a.depth - b.depth;
  });
  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <section className="panel p-4 sm:p-5 relative">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div className="text-xs uppercase tracking-[0.3em] text-mist">
          Agent lineage · globe view
        </div>
        <div className="text-[0.65rem] text-mist num">
          gen {generation} · {nodes.filter((n) => !n.isSeed).length} agents · {links.length} edges
        </div>
      </div>
      <p className="text-[0.65rem] text-mist mb-3 max-w-2xl leading-relaxed">
        Drag empty space to rotate the globe, drag a node to reposition
        it, tap a node for stats. Edges link mutants to their parents.
        Champion glows gold and stays on top. Front-of-globe nodes sit
        sharp; back-of-globe nodes dim with depth.
      </p>
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="w-full h-auto rounded-sm bg-black/40 border border-edge/40 select-none touch-none"
          onPointerDown={onPointerDownBackground}
          onClick={onClickBackground}
          aria-label="Agent lineage globe"
        >
          {/* Globe glow + horizon */}
          <defs>
            <radialGradient id="globe-glow" cx="50%" cy="42%" r="55%">
              <stop offset="0%" stopColor="#6366f1" stopOpacity="0.18" />
              <stop offset="55%" stopColor="#1e1b4b" stopOpacity="0.08" />
              <stop offset="100%" stopColor="#000" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="champion-halo" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#fde68a" stopOpacity="0.95" />
              <stop offset="60%" stopColor="#fbbf24" stopOpacity="0.5" />
              <stop offset="100%" stopColor="#fbbf24" stopOpacity="0" />
            </radialGradient>
            <filter id="champion-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="6" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {/* Background sphere outline + glow */}
          <circle
            cx={CENTER_X}
            cy={CENTER_Y}
            r={SPHERE_RADIUS + 12}
            fill="url(#globe-glow)"
          />
          <circle
            cx={CENTER_X}
            cy={CENTER_Y}
            r={SPHERE_RADIUS}
            fill="none"
            stroke="#475569"
            strokeOpacity={0.25}
            strokeWidth={1}
            strokeDasharray="2 4"
          />

          {/* Edges. Each edge is a straight line in screen space; we
              fade it by the average depth of its endpoints so back
              edges sit visually behind front nodes. */}
          <g>
            {links.map((l, i) => {
              const s = l.source as GraphNode;
              const t = l.target as GraphNode;
              const ps = projected.find((p) => p.node === s);
              const pt = projected.find((p) => p.node === t);
              if (!ps || !pt) return null;
              const avg = (ps.depth + pt.depth) / 2;
              const op = 0.12 + Math.max(0, avg) * 0.45;
              return (
                <line
                  key={i}
                  x1={ps.sx}
                  y1={ps.sy}
                  x2={pt.sx}
                  y2={pt.sy}
                  stroke="#4b5563"
                  strokeOpacity={op}
                  strokeWidth={0.7}
                />
              );
            })}
          </g>

          {/* Nodes — back-to-front, champion last (always on top). */}
          <g>
            {projected.map(({ node: n, sx, sy, depth }) => {
              const fam = (FAMILY_COLORS as Record<string, string>)[n.family] ?? "#94a3b8";
              const isSelected = selectedId === n.id;
              // Depth scaling: front (depth=1) is 1.0×, back (depth=-1)
              // is 0.55×. Champion is always full size.
              const depthScale = n.isChampion ? 1.6 : 0.55 + Math.max(0, depth + 1) / 2 * 0.45;
              const r = n.size * depthScale;
              const opacity = n.isChampion
                ? 1
                : n.isSeed
                  ? 0.4 + Math.max(0, depth) * 0.35
                  : 0.4 + Math.max(0, depth + 1) / 2 * 0.6;
              const stroke = isSelected ? "#22d3ee" : n.isChampion ? "#fbbf24" : n.isSeed ? fam : "#0b0f14";
              return (
                <g
                  key={n.id}
                  transform={`translate(${sx},${sy})`}
                  className="cursor-pointer"
                  onPointerDown={(e) => onPointerDownNode(e, n)}
                >
                  {n.isChampion ? (
                    <>
                      {/* Outer halo gradient */}
                      <circle r={r + 16} fill="url(#champion-halo)">
                        <animate
                          attributeName="r"
                          values={`${r + 12};${r + 22};${r + 12}`}
                          dur="3.6s"
                          repeatCount="indefinite"
                        />
                      </circle>
                      {/* Pulsing ring */}
                      <circle
                        r={r + 6}
                        fill="none"
                        stroke="#fbbf24"
                        strokeWidth={2.5}
                        opacity={0.85}
                      >
                        <animate
                          attributeName="r"
                          values={`${r + 4};${r + 12};${r + 4}`}
                          dur="3.6s"
                          repeatCount="indefinite"
                        />
                        <animate
                          attributeName="opacity"
                          values="0.95;0.35;0.95"
                          dur="3.6s"
                          repeatCount="indefinite"
                        />
                      </circle>
                    </>
                  ) : null}
                  <circle
                    r={r}
                    fill={n.isSeed ? "#1f2937" : fam}
                    fillOpacity={opacity}
                    stroke={stroke}
                    strokeWidth={n.isChampion ? 2.5 : isSelected ? 2 : 1}
                    filter={n.isChampion ? "url(#champion-glow)" : undefined}
                  />
                  {n.isChampion ? (
                    <text
                      y={-(r + 14)}
                      textAnchor="middle"
                      fontSize="14"
                      fill="#fde68a"
                      style={{ pointerEvents: "none", filter: "drop-shadow(0 0 4px #000)" }}
                    >
                      👑 CHAMPION
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        </svg>

        {/* Pinned details panel — shows whichever node was last
            tapped/clicked. Closed via × or by tapping empty space. */}
        {selected ? (
          <div
            className="absolute top-3 right-3 panel p-3 bg-black/95 backdrop-blur-sm max-w-[280px] text-[0.7rem] num shadow-2xl ring-1 ring-cyan/30"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2 mb-1">
              <div className="font-mono text-slate-100 break-all text-[0.7rem]">
                {selected.isChampion ? "👑 " : ""}
                {selected.id.replace(/^gen\d+-mut\d+-/, "")}
              </div>
              <button
                onClick={() => setSelectedId(null)}
                className="text-mist hover:text-slate-100 text-base leading-none px-1"
                aria-label="Close details"
              >
                ×
              </button>
            </div>
            <div className="text-[0.6rem] text-mist mb-2">
              {selected.isSeed
                ? "phantom seed (ancestor not in live set)"
                : `family: ${selected.family}`}
            </div>
            {selected.agent ? (
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                <span>
                  <span className="text-mist">Σ R</span>{" "}
                  <span className={selected.agent.total_r >= 0 ? "text-green" : "text-red"}>
                    {selected.agent.total_r >= 0 ? "+" : ""}
                    {selected.agent.total_r.toFixed(2)}
                  </span>
                </span>
                <span>
                  <span className="text-mist">WR</span>{" "}
                  {(selected.agent.win_rate * 100).toFixed(1)}%
                </span>
                <span>
                  <span className="text-mist">trades</span>{" "}
                  {selected.agent.wins + selected.agent.losses}
                </span>
                <span>
                  <span className="text-mist">Sharpe</span>{" "}
                  {selected.agent.rolling_sharpe.toFixed(2)}
                </span>
                <span className="col-span-2">
                  <span className="text-mist">last R</span>{" "}
                  <span className={selected.agent.last_r >= 0 ? "text-green" : "text-red"}>
                    {selected.agent.last_r >= 0 ? "+" : ""}
                    {selected.agent.last_r.toFixed(2)}
                  </span>
                </span>
                {selected.agent.expectancy_r != null ? (
                  <span className="col-span-2">
                    <span className="text-mist">E[R]</span>{" "}
                    <span
                      className={
                        selected.agent.expectancy_r >= 0 ? "text-green" : "text-red"
                      }
                    >
                      {selected.agent.expectancy_r >= 0 ? "+" : ""}
                      {selected.agent.expectancy_r.toFixed(3)}
                    </span>
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

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
    </section>
  );
}
