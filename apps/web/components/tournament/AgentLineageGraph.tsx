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

// Force-directed lineage graph projected onto a Pythian orb — the
// agora of the swarm. SVG only; orthographic sphere projection plus
// per-node depth scaling + dim-back-of-orb fading sells the 3D feel
// without three.js. Visual theme is classical Greek: laurel-gold
// laureate, bronze horizon, ochre haze.
//
// Gestures (mouse, trackpad, touch all work):
//   - 1-finger drag empty space  → rotate globe (yaw + pitch)
//   - 2-finger pinch             → zoom around the pinch midpoint
//   - 2-finger drag              → pan
//   - Scroll wheel / trackpad    → zoom around cursor
//   - +/− / ⟲ buttons (top-left) → discrete zoom + reset
//   - Drag a node                → reposition it; sphere reflows
//   - Tap any node               → pin a stats panel for that agent
//                                  (works on touch where hover doesn't
//                                  fire)
//   - Tap empty space            → clear selection

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
  size: number;
};

type GraphLink = SimulationLinkDatum<GraphNode>;

const WIDTH = 900;
const HEIGHT = 560;
const SPHERE_RADIUS = Math.min(WIDTH, HEIGHT) * 0.42;
const CENTER_X = WIDTH / 2;
const CENTER_Y = HEIGHT / 2;
const MIN_SCALE = 0.6;
const MAX_SCALE = 4;
const TAP_VS_DRAG_THRESHOLD = 8;
const PARTICLE_COUNT = 220;

// Family colors used to tint the background particle cloud. Excludes
// "other" so the cloud stays vivid (no slate/grey particles).
const PARTICLE_FAMILIES = [
  "liq-trend",
  "liq-fade",
  "vol-breakout",
  "funding-trend",
  "funding-arb",
  "polyedge",
  "polyfusion",
  "llm",
] as const;

type Particle = {
  /** Spherical longitude in [-π, π]. */
  lon: number;
  /** Spherical latitude in [-π/2, π/2]. */
  lat: number;
  /** Radial offset as a multiple of SPHERE_RADIUS. Range ~0.6–1.05
   *  so most particles hug the surface, with some slightly inside or
   *  outside to give the cloud depth. */
  rOffset: number;
  color: string;
  /** Pixel radius of the particle when drawn. */
  size: number;
  /** Phase offset so each particle pulses on its own schedule. */
  phase: number;
};

/** Tiny seeded PRNG so the particle field is deterministic across
 *  re-renders. mulberry32 is plenty for visual jitter. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

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

/** Map 2D layout (x ∈ [0, W], y ∈ [0, H]) to lon/lat, rotate by
 *  yaw/pitch, orthographic-project to viewBox space. Pan + zoom are
 *  applied via the wrapping <g transform>, not here. */
function project(
  x2d: number,
  y2d: number,
  yaw: number,
  pitch: number,
): { sx: number; sy: number; depth: number } {
  const lon = ((x2d - CENTER_X) / CENTER_X) * Math.PI;
  const lat = ((y2d - CENTER_Y) / CENTER_Y) * (Math.PI / 2);
  const adjLon = lon + yaw;
  const adjLat = lat + pitch;
  const cy = Math.cos(adjLat);
  const sx_sphere = cy * Math.sin(adjLon);
  const sy_sphere = Math.sin(adjLat);
  const sz_sphere = cy * Math.cos(adjLon);
  const sx = CENTER_X + sx_sphere * SPHERE_RADIUS;
  const sy = CENTER_Y - sy_sphere * SPHERE_RADIUS;
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
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Frozen view of the agents prop. We only sync to the latest snapshot
  // when the user isn't interacting (no selection, no live drag, tab is
  // visible). Stops layout reshuffles from yanking the cursor target
  // mid-study after an hourly cron refresh.
  const [frozenAgents, setFrozenAgents] = useState(agents);

  // Camera state: rotation + zoom + pan. Refs so updates during a
  // gesture don't trigger React re-renders for every move event;
  // the rAF loop drives the visual update.
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const scaleRef = useRef(1);
  const panXRef = useRef(0);
  const panYRef = useRef(0);

  // All currently-down pointers on the SVG (mouse, touch fingers, pen).
  // Two simultaneous → pinch/pan gesture; one → single drag (camera or
  // node depending on what was hit).
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{
    startDist: number;
    startScale: number;
    startCenterVB: { x: number; y: number };
    startPanX: number;
    startPanY: number;
  } | null>(null);

  const dragRef = useRef<
    | {
        mode: "node";
        pointerId: number;
        node: GraphNode;
        startX: number;
        startY: number;
        moved: boolean;
      }
    | { mode: "camera"; pointerId: number; lastX: number; lastY: number }
    | null
  >(null);

  const simRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);

  // Background particle cloud — multi-colored dots distributed near
  // the sphere surface so the orb reads as a luminous brain rather
  // than a wireframe globe. Generated once with a fixed seed; each
  // particle picks a family color from the swarm palette.
  const particles = useMemo<Particle[]>(() => {
    const rng = mulberry32(0xa10c);
    const list: Particle[] = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const family = PARTICLE_FAMILIES[
        Math.floor(rng() * PARTICLE_FAMILIES.length)
      ];
      list.push({
        lon: (rng() - 0.5) * 2 * Math.PI,
        lat: (rng() - 0.5) * Math.PI,
        rOffset: 0.6 + rng() * 0.5,
        color: FAMILY_COLORS[family],
        size: 0.5 + rng() * 1.6,
        phase: rng() * Math.PI * 2,
      });
    }
    return list;
  }, []);

  useEffect(() => {
    const isInteracting =
      selectedId !== null ||
      dragRef.current !== null ||
      pointersRef.current.size > 0;
    const tabHidden = typeof document !== "undefined" && document.hidden;
    if (!isInteracting && !tabHidden) {
      setFrozenAgents(agents);
    }
  }, [agents, selectedId]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (
        !document.hidden &&
        selectedId === null &&
        dragRef.current === null
      ) {
        setFrozenAgents(agents);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [agents, selectedId]);

  const { nodes, links } = useMemo(() => {
    if (frozenAgents.length === 0) {
      return { nodes: [] as GraphNode[], links: [] as GraphLink[] };
    }
    const liveIds = new Set(frozenAgents.map((a) => a.agent_id));
    const maxR = Math.max(1, ...frozenAgents.map((a) => Math.abs(a.total_r)));
    const liveNodes: GraphNode[] = frozenAgents.map((a) => ({
      id: a.agent_id,
      family: agentFamily(a.agent_id),
      agent: a,
      isChampion: a.agent_id === championId,
      isSeed: false,
      size: 7 + (Math.abs(a.total_r) / maxR) * 13,
    }));

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
  }, [frozenAgents, championId]);

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

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      const dt = t - last;
      last = t;
      // Auto-rotate only in the resting "default" view: nothing
      // selected, no zoom or pan applied, no active gesture. Once the
      // user has touched any control we stop spinning so we're not
      // fighting their input.
      const isIdle =
        !dragRef.current &&
        !pinchRef.current &&
        selectedId === null &&
        Math.abs(scaleRef.current - 1) < 0.01 &&
        Math.abs(panXRef.current) < 1 &&
        Math.abs(panYRef.current) < 1;
      if (isIdle) {
        yawRef.current += (dt / 1000) * ((Math.PI * 2) / 90);
      }
      tickCount.current++;
      if (tickCount.current % 2 === 0) forceRerender((c) => c + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [selectedId]);

  // Single source of truth for client→viewBox conversion. Reads svgRef
  // (stable) so a closure over this function is fine.
  const screenToViewBox = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    return pt.matrixTransform(ctm.inverse());
  };

  const viewBoxToWorld = (vx: number, vy: number) => ({
    x: (vx - panXRef.current) / scaleRef.current,
    y: (vy - panYRef.current) / scaleRef.current,
  });

  const zoomAt = (factor: number, vbx: number, vby: number) => {
    const oldScale = scaleRef.current;
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, oldScale * factor));
    if (newScale === oldScale) return;
    // Anchor: world point under (vbx, vby) stays put across the zoom.
    const worldX = (vbx - panXRef.current) / oldScale;
    const worldY = (vby - panYRef.current) / oldScale;
    panXRef.current = vbx - worldX * newScale;
    panYRef.current = vby - worldY * newScale;
    scaleRef.current = newScale;
  };

  // Wheel handler attached natively so we can preventDefault even when
  // React's synthetic wheel event is passive.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const vb = screenToViewBox(e.clientX, e.clientY);
      if (!vb) return;
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, vb.x, vb.y);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  // Window-level pointer move/up handlers. Window-level so the gesture
  // continues even if the cursor leaves the SVG.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!pointersRef.current.has(e.pointerId)) return;
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      // Pinch/pan beats single drag. Two pointers → zoom around the
      // midpoint, pan with the midpoint, ignore individual moves.
      if (pinchRef.current && pointersRef.current.size >= 2) {
        const ps = Array.from(pointersRef.current.values());
        const a = ps[0];
        const b = ps[1];
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const ratio = dist / pinchRef.current.startDist;
        const newScale = Math.max(
          MIN_SCALE,
          Math.min(MAX_SCALE, pinchRef.current.startScale * ratio),
        );
        const midClient = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const midVB = screenToViewBox(midClient.x, midClient.y);
        if (!midVB) return;
        const worldAnchor = {
          x:
            (pinchRef.current.startCenterVB.x - pinchRef.current.startPanX) /
            pinchRef.current.startScale,
          y:
            (pinchRef.current.startCenterVB.y - pinchRef.current.startPanY) /
            pinchRef.current.startScale,
        };
        panXRef.current = midVB.x - worldAnchor.x * newScale;
        panYRef.current = midVB.y - worldAnchor.y * newScale;
        scaleRef.current = newScale;
        return;
      }

      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;

      if (drag.mode === "camera") {
        const dx = e.clientX - drag.lastX;
        const dy = e.clientY - drag.lastY;
        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
        yawRef.current += dx * 0.006;
        pitchRef.current = Math.max(
          -Math.PI / 2 + 0.1,
          Math.min(Math.PI / 2 - 0.1, pitchRef.current + dy * 0.006),
        );
        return;
      }

      // Node drag — only commit movement once the pointer has travelled
      // past the tap radius, so a tap (with natural finger jitter)
      // reliably selects instead of dragging by 1-2 pixels.
      const totalDx = e.clientX - drag.startX;
      const totalDy = e.clientY - drag.startY;
      const distSq = totalDx * totalDx + totalDy * totalDy;
      if (
        !drag.moved &&
        distSq < TAP_VS_DRAG_THRESHOLD * TAP_VS_DRAG_THRESHOLD
      ) {
        return;
      }
      drag.moved = true;
      const vb = screenToViewBox(e.clientX, e.clientY);
      if (!vb) return;
      const local = viewBoxToWorld(vb.x, vb.y);
      const dxScreen = local.x - CENTER_X;
      const dyScreen = -(local.y - CENTER_Y);
      const r = Math.min(
        SPHERE_RADIUS,
        Math.sqrt(dxScreen * dxScreen + dyScreen * dyScreen),
      );
      const lon = Math.atan2(
        dxScreen,
        Math.sqrt(SPHERE_RADIUS * SPHERE_RADIUS - r * r),
      );
      const lat = Math.asin(
        Math.max(-1, Math.min(1, dyScreen / SPHERE_RADIUS)),
      );
      const adjLon = lon - yawRef.current;
      const adjLat = lat - pitchRef.current;
      drag.node.fx = CENTER_X + (adjLon / Math.PI) * CENTER_X;
      drag.node.fy = CENTER_Y + (adjLat / (Math.PI / 2)) * CENTER_Y;
      if (simRef.current) simRef.current.alphaTarget(0.25);
    };

    const onUp = (e: PointerEvent) => {
      if (!pointersRef.current.has(e.pointerId)) return;
      pointersRef.current.delete(e.pointerId);

      if (pinchRef.current && pointersRef.current.size < 2) {
        // Pinch ends. We don't promote a leftover pointer into a fresh
        // single drag — user must lift fully and re-press to rotate
        // again, which avoids unintended yaw spins on pinch release.
        pinchRef.current = null;
        return;
      }

      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      if (drag.mode === "node") {
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

  // Helper: snapshot pinch state from the current pointer set.
  const tryStartPinch = () => {
    if (pointersRef.current.size < 2) return;
    const ps = Array.from(pointersRef.current.values());
    const a = ps[0];
    const b = ps[1];
    const midVB = screenToViewBox((a.x + b.x) / 2, (a.y + b.y) / 2);
    if (!midVB) return;
    pinchRef.current = {
      startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      startScale: scaleRef.current,
      startCenterVB: { x: midVB.x, y: midVB.y },
      startPanX: panXRef.current,
      startPanY: panYRef.current,
    };
    // Cancel any in-progress single drag so the gesture is clean.
    const cur = dragRef.current;
    if (cur?.mode === "node") {
      cur.node.fx = null;
      cur.node.fy = null;
      if (simRef.current) simRef.current.alphaTarget(0);
    }
    dragRef.current = null;
  };

  const onPointerDownNode = (e: React.PointerEvent, n: GraphNode) => {
    e.stopPropagation();
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size >= 2) {
      tryStartPinch();
      return;
    }
    dragRef.current = {
      mode: "node",
      pointerId: e.pointerId,
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
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size >= 2) {
      tryStartPinch();
      return;
    }
    dragRef.current = {
      mode: "camera",
      pointerId: e.pointerId,
      lastX: e.clientX,
      lastY: e.clientY,
    };
  };

  const onClickBackground = () => setSelectedId(null);

  const resetView = () => {
    scaleRef.current = 1;
    panXRef.current = 0;
    panYRef.current = 0;
    yawRef.current = 0;
    pitchRef.current = 0;
    setSelectedId(null);
  };
  const zoomIn = () => zoomAt(1.25, WIDTH / 2, HEIGHT / 2);
  const zoomOut = () => zoomAt(1 / 1.25, WIDTH / 2, HEIGHT / 2);

  if (nodes.length === 0) return null;

  const yaw = yawRef.current;
  const pitch = pitchRef.current;
  const projected = nodes.map((n) => {
    const x = n.x ?? CENTER_X;
    const y = n.y ?? CENTER_Y;
    const p = project(x, y, yaw, pitch);
    return { node: n, ...p };
  });
  projected.sort((a, b) => {
    if (a.node.isChampion !== b.node.isChampion) return a.node.isChampion ? 1 : -1;
    return a.depth - b.depth;
  });
  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const hovered = nodes.find((n) => n.id === hoveredId) ?? null;
  const championProjection = projected.find((p) => p.node.isChampion) ?? null;

  return (
    <section className="panel p-4 sm:p-5 relative">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div className="text-xs uppercase tracking-[0.3em] text-amber/80">
          Pythian agora · lineage
        </div>
        <div className="text-[0.65rem] text-mist num">
          gen {generation} · {nodes.filter((n) => !n.isSeed).length} agents · {links.length} edges
        </div>
      </div>
      <p className="text-[0.65rem] text-mist mb-3 max-w-2xl leading-relaxed">
        Drag the marble to turn it · pinch / scroll / +− to zoom ·
        two-finger drag to pan · tap any node for the agent&apos;s
        record. Champion glows gold and stays on top.
      </p>
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="w-full h-auto rounded-sm bg-black/40 border border-edge/40 select-none touch-none"
          onPointerDown={onPointerDownBackground}
          onClick={onClickBackground}
          aria-label="Pythian agora — agent lineage orb"
        >
          <defs>
            {/* Greek palette: ochre-amber haze fading to dark wine.
                Replaces the old indigo/space-blue gradient. */}
            <radialGradient id="globe-glow" cx="50%" cy="42%" r="55%">
              <stop offset="0%" stopColor="#d97706" stopOpacity="0.22" />
              <stop offset="55%" stopColor="#7c2d12" stopOpacity="0.1" />
              <stop offset="100%" stopColor="#000" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="champion-halo" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#fde68a" stopOpacity="0.95" />
              <stop offset="60%" stopColor="#f59e0b" stopOpacity="0.55" />
              <stop offset="100%" stopColor="#b45309" stopOpacity="0" />
            </radialGradient>
            <filter id="champion-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="6" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Everything that should pan/zoom together lives inside this
              <g transform>. The sphere outline + edges + nodes + champion
              callout all move with the camera. screenToViewBox uses the
              outer <svg>'s CTM, then we divide by scale + subtract pan
              for the inverse. */}
          <g
            transform={`translate(${panXRef.current} ${panYRef.current}) scale(${scaleRef.current})`}
          >
            <circle
              cx={CENTER_X}
              cy={CENTER_Y}
              r={SPHERE_RADIUS + 12}
              fill="url(#globe-glow)"
            />
            {/* Particle cloud — multi-colored dots distributed near
                the sphere surface so the orb reads as a luminous
                brain rather than a wireframe globe. Each particle
                rotates with the camera and pulses on its own phase.
                Drawn before the sphere outline + edges + nodes so it
                sits in the background. */}
            <g style={{ pointerEvents: "none" }}>
              {particles.map((p, i) => {
                const cy = Math.cos(p.lat + pitch);
                const sx_sphere =
                  cy * Math.sin(p.lon + yaw) * p.rOffset;
                const sy_sphere = Math.sin(p.lat + pitch) * p.rOffset;
                const sz_sphere =
                  cy * Math.cos(p.lon + yaw) * p.rOffset;
                const sx = CENTER_X + sx_sphere * SPHERE_RADIUS;
                const sy = CENTER_Y - sy_sphere * SPHERE_RADIUS;
                // Front-of-globe (depth ≈ +1) glows bright; back fades
                // away. Pulse oscillates at 0.7–1.0 with a per-particle
                // phase offset so the cloud breathes asynchronously.
                const depth = sz_sphere;
                const depthBase = 0.08 + (Math.max(0, depth + 1) / 2) * 0.55;
                const t = performance.now() / 1000;
                const pulse = 0.72 + 0.28 * Math.sin(t * 0.7 + p.phase);
                const opacity = depthBase * pulse;
                if (opacity < 0.02) return null;
                return (
                  <circle
                    key={i}
                    cx={sx}
                    cy={sy}
                    r={p.size}
                    fill={p.color}
                    opacity={opacity}
                  />
                );
              })}
            </g>

            {/* Bronze horizon — subtle dashed circle frames the marble. */}
            <circle
              cx={CENTER_X}
              cy={CENTER_Y}
              r={SPHERE_RADIUS}
              fill="none"
              stroke="#a16207"
              strokeOpacity={0.18}
              strokeWidth={1}
              strokeDasharray="2 4"
            />

            <g>
              {links.map((l, i) => {
                const s = l.source as GraphNode;
                const t = l.target as GraphNode;
                const ps = projected.find((p) => p.node === s);
                const pt = projected.find((p) => p.node === t);
                if (!ps || !pt) return null;
                const avg = (ps.depth + pt.depth) / 2;
                // Visible enough to read as lineage spokes, muted
                // enough that the family-colored nodes own the
                // visual hierarchy.
                const op = 0.13 + Math.max(0, avg) * 0.32;
                return (
                  <line
                    key={i}
                    x1={ps.sx}
                    y1={ps.sy}
                    x2={pt.sx}
                    y2={pt.sy}
                    stroke="#92400e"
                    strokeOpacity={op}
                    strokeWidth={0.7}
                    strokeLinecap="round"
                  />
                );
              })}
            </g>

            <g>
              {projected.map(({ node: n, sx, sy, depth }) => {
                const fam =
                  (FAMILY_COLORS as Record<string, string>)[n.family] ??
                  "#94a3b8";
                const isSelected = selectedId === n.id;
                const isHovered = hoveredId === n.id;
                const depthScale = n.isChampion
                  ? 1.6
                  : 0.55 + (Math.max(0, depth + 1) / 2) * 0.45;
                // Visible bump on hover/select so every node — not just
                // the champion — feels touchable.
                const interactionBump = isSelected ? 1.35 : isHovered ? 1.15 : 1;
                const r = n.size * depthScale * interactionBump;
                const opacity = n.isChampion
                  ? 1
                  : n.isSeed
                    ? 0.4 + Math.max(0, depth) * 0.35
                    : 0.4 + (Math.max(0, depth + 1) / 2) * 0.6;
                const stroke = isSelected
                  ? "#22d3ee"
                  : n.isChampion
                    ? "#fbbf24"
                    : isHovered
                      ? "#cbd5e1"
                      : n.isSeed
                        ? fam
                        : "#0b0f14";
                return (
                  <g
                    key={n.id}
                    transform={`translate(${sx},${sy})`}
                    className="cursor-pointer"
                    onPointerDown={(e) => onPointerDownNode(e, n)}
                    onPointerEnter={() => setHoveredId(n.id)}
                    onPointerLeave={() =>
                      setHoveredId((cur) => (cur === n.id ? null : cur))
                    }
                    onClick={(e) => e.stopPropagation()}
                  >
                    {n.isChampion ? (
                      <>
                        <circle r={r + 16} fill="url(#champion-halo)">
                          <animate
                            attributeName="r"
                            values={`${r + 12};${r + 22};${r + 12}`}
                            dur="3.6s"
                            repeatCount="indefinite"
                          />
                        </circle>
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
                    {/* Selection ring on any non-champion picked node so
                        users get strong visual confirmation of the tap. */}
                    {isSelected && !n.isChampion ? (
                      <circle
                        r={r + 4}
                        fill="none"
                        stroke="#22d3ee"
                        strokeWidth={1.5}
                        strokeDasharray="3 2"
                        opacity={0.85}
                      >
                        <animate
                          attributeName="r"
                          values={`${r + 3};${r + 7};${r + 3}`}
                          dur="2.4s"
                          repeatCount="indefinite"
                        />
                      </circle>
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
                        style={{
                          pointerEvents: "none",
                          filter: "drop-shadow(0 0 4px #000)",
                        }}
                      >
                        👑 CHAMPION
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </g>

            {championProjection
              ? (() => {
                  const { sx, sy, depth, node } = championProjection;
                  const above = sy < CENTER_Y;
                  const labelDy = above ? 70 : -70;
                  const labelY = sy + labelDy;
                  const opacity = depth < 0 ? 0.7 : 1;
                  const champ = node.agent;
                  return (
                    <g opacity={opacity} style={{ pointerEvents: "none" }}>
                      <line
                        x1={sx}
                        y1={sy}
                        x2={sx}
                        y2={labelY + (above ? -10 : 10)}
                        stroke="#fbbf24"
                        strokeWidth={1}
                        strokeDasharray="2 3"
                        opacity={0.6}
                      />
                      <rect
                        x={sx - 78}
                        y={labelY - 18}
                        width={156}
                        height={36}
                        rx={6}
                        fill="rgba(11, 15, 20, 0.92)"
                        stroke="#fbbf24"
                        strokeWidth={1.5}
                      />
                      <text
                        x={sx}
                        y={labelY - 4}
                        textAnchor="middle"
                        fontSize={11}
                        fill="#fde68a"
                        fontWeight={600}
                      >
                        👑 CHAMPION
                      </text>
                      <text
                        x={sx}
                        y={labelY + 11}
                        textAnchor="middle"
                        fontSize={10}
                        fill="#cbd5e1"
                        fontFamily="ui-monospace, monospace"
                      >
                        {champ
                          ? `${champ.total_r >= 0 ? "+" : ""}${champ.total_r.toFixed(0)}R · ${(champ.win_rate * 100).toFixed(0)}% WR`
                          : node.id.slice(0, 22)}
                      </text>
                    </g>
                  );
                })()
              : null}
          </g>
        </svg>

        {/* Zoom + reset overlay. Top-left so it doesn't fight the
            details panel for space (which pins top-right on desktop,
            bottom-anchored on mobile). */}
        <div className="absolute top-2 left-2 flex flex-col gap-1.5 z-10">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              zoomIn();
            }}
            className="w-9 h-9 rounded-sm bg-black/85 hover:bg-black border border-edge/60 hover:border-cyan/40 text-slate-100 text-lg leading-none flex items-center justify-center"
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              zoomOut();
            }}
            className="w-9 h-9 rounded-sm bg-black/85 hover:bg-black border border-edge/60 hover:border-cyan/40 text-slate-100 text-lg leading-none flex items-center justify-center"
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              resetView();
            }}
            className="w-9 h-9 rounded-sm bg-black/85 hover:bg-black border border-edge/60 hover:border-cyan/40 text-mist hover:text-slate-100 text-sm leading-none flex items-center justify-center"
            aria-label="Reset view"
            title="Reset"
          >
            ⟲
          </button>
        </div>

        {/* Details panel.
            Mobile: pinned to the bottom of the graph, full width minus
            small margins, so it doesn't collide with the champion
            callout above.
            Desktop (sm+): top-right floating card. */}
        {selected ? (
          <div
            className="absolute left-2 right-2 bottom-2 sm:left-auto sm:right-3 sm:top-3 sm:bottom-auto sm:max-w-[280px] panel p-3 bg-black/95 backdrop-blur-sm text-[0.7rem] num shadow-2xl ring-1 ring-cyan/30 z-20"
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
                className="text-mist hover:text-slate-100 text-base leading-none px-1 shrink-0"
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
                  <span
                    className={
                      selected.agent.total_r >= 0 ? "text-green" : "text-red"
                    }
                  >
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
                  <span
                    className={
                      selected.agent.last_r >= 0 ? "text-green" : "text-red"
                    }
                  >
                    {selected.agent.last_r >= 0 ? "+" : ""}
                    {selected.agent.last_r.toFixed(2)}
                  </span>
                </span>
                {selected.agent.expectancy_r != null ? (
                  <span className="col-span-2">
                    <span className="text-mist">E[R]</span>{" "}
                    <span
                      className={
                        selected.agent.expectancy_r >= 0
                          ? "text-green"
                          : "text-red"
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
        ) : hovered ? (
          // Hover preview — desktop only (sm:block); mobile users get
          // the pinned panel on tap instead. No close button because
          // pointerleave dismisses it.
          <div className="hidden sm:block absolute top-3 right-3 panel p-2.5 bg-black/90 backdrop-blur-sm max-w-[260px] text-[0.65rem] num pointer-events-none ring-1 ring-edge/40 z-10">
            <div className="font-mono text-slate-100 break-all text-[0.7rem]">
              {hovered.isChampion ? "👑 " : ""}
              {hovered.id.replace(/^gen\d+-mut\d+-/, "")}
            </div>
            <div className="text-[0.55rem] text-mist mt-0.5 mb-1.5">
              {hovered.isSeed ? "phantom seed" : `${hovered.family} · tap to pin`}
            </div>
            {hovered.agent ? (
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                <span>
                  <span className="text-mist">Σ R</span>{" "}
                  <span
                    className={
                      hovered.agent.total_r >= 0 ? "text-green" : "text-red"
                    }
                  >
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
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-3 text-[0.6rem] text-mist">
        {(
          [
            "liq-trend",
            "liq-fade",
            "vol-breakout",
            "funding-trend",
            "funding-arb",
            "polyedge",
            "polyfusion",
            "llm",
          ] as const
        ).map((f) => (
          <span key={f} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{
                background: (FAMILY_COLORS as Record<string, string>)[f],
              }}
            />
            <span className="font-mono uppercase tracking-widest">{f}</span>
          </span>
        ))}
      </div>
    </section>
  );
}
