"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Html } from "@react-three/drei";
import { Suspense, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import {
  agentFamily,
  FAMILY_COLORS,
  type AgentStats,
  type AgentFam,
} from "@/lib/swarm";

/**
 * AgentLandscape — the wireframe terrain alternative to the orb arena.
 *
 *   ┌─ rippling wireframe plane represents the market regime surface
 *   ├─ each agent is a totem of stacked torus rings rising from the
 *   │  terrain. Ring count scales with |Σ R|, ring colour alternates
 *   │  family vs. accent, the totem stands taller the more the agent
 *   │  has earned.
 *   ├─ champion gets a centred glowing orb on its own pedestal so the
 *   │  eye lands on it before reading the rest.
 *   └─ user can drag-rotate the whole field with OrbitControls.
 *
 * Reads as data-art rather than space-orbs, and scales cleanly to
 * arbitrary agent counts (the totems pack densely without overlapping
 * because each is anchored to a per-family lane).
 */

const FAMILY_ORDER: AgentFam[] = [
  "liq-trend",
  "liq-fade",
  "vol-breakout",
  "funding-trend",
  "funding-arb",
  "polyedge",
  "polyfusion",
  "llm",
  "other",
];

const ACCENT = "#a855f7"; // royal-purple complement for alternating rings

/** Animated wireframe plane with two summed sine waves giving a
 *  drifting hilly surface. Position attribute is mutated in-place each
 *  frame; geometry is shared across renders. */
function WireTerrain() {
  const ref = useRef<THREE.Mesh>(null!);
  const geom = useMemo(() => {
    const g = new THREE.PlaneGeometry(90, 65, 80, 60);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);
  const offsets = useMemo(() => {
    // Cache base positions so noise sums against a known starting point.
    const pos = geom.attributes.position;
    const out = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      out[i] = pos.getY(i); // baseline height (== 0 for a fresh plane)
    }
    return out;
  }, [geom]);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.elapsedTime * 0.45;
    const pos = ref.current.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h =
        Math.sin(x * 0.18 + t) * 0.9 +
        Math.cos(z * 0.22 + t * 0.7) * 0.7 +
        Math.sin((x + z) * 0.12 - t * 0.4) * 0.4;
      pos.setY(i, offsets[i] + h);
    }
    pos.needsUpdate = true;
  });
  return (
    <mesh ref={ref} position={[0, -3, 0]}>
      <primitive object={geom} attach="geometry" />
      <meshBasicMaterial
        color="#cbd5e1"
        wireframe
        transparent
        opacity={0.32}
      />
    </mesh>
  );
}

/** A single agent totem — stack of torus rings with a tiny apex glyph. */
function AgentTotem({
  position,
  family,
  ringCount,
  rPositive,
  isHovered,
  onHover,
  onLeave,
  onClick,
  agentId,
  totalR,
  winRate,
}: {
  position: [number, number, number];
  family: AgentFam;
  ringCount: number;
  rPositive: boolean;
  isHovered: boolean;
  onHover: () => void;
  onLeave: () => void;
  onClick: () => void;
  agentId: string;
  totalR: number;
  winRate: number;
}) {
  const baseColor = FAMILY_COLORS[family] ?? "#94a3b8";
  const groupRef = useRef<THREE.Group>(null!);
  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    // Gentle bob synced to rank — taller totems bob more, dramatising scale.
    const phase = position[0] * 0.5 + position[2] * 0.5;
    const bob = Math.sin(clock.elapsedTime * 1.2 + phase) * 0.06;
    groupRef.current.position.y = position[1] + bob;
    if (isHovered) {
      groupRef.current.rotation.y = clock.elapsedTime * 0.4;
    } else {
      groupRef.current.rotation.y *= 0.95; // ease back to 0
    }
  });

  const rings = useMemo(() => {
    const out: { y: number; radius: number; color: string }[] = [];
    for (let i = 0; i < ringCount; i++) {
      const t = i / Math.max(1, ringCount - 1);
      // Taper subtly toward the top (1.0 → 0.7) so it reads as a totem.
      const radius = 0.55 - t * 0.16;
      out.push({
        y: i * 0.32,
        radius,
        color: i % 2 === 0 ? baseColor : ACCENT,
      });
    }
    return out;
  }, [ringCount, baseColor]);

  return (
    <group
      ref={groupRef}
      position={position}
      onPointerOver={(e) => {
        e.stopPropagation();
        onHover();
      }}
      onPointerOut={onLeave}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {/* Totem rings */}
      {rings.map((r, i) => (
        <mesh key={i} position={[0, r.y, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[r.radius, 0.045, 10, 40]} />
          <meshBasicMaterial
            color={r.color}
            toneMapped={false}
            transparent
            opacity={isHovered ? 1.0 : 0.85}
          />
        </mesh>
      ))}
      {/* Apex glyph — tiny ovoid that reads as a "head" */}
      <mesh position={[0, ringCount * 0.32 + 0.25, 0]}>
        <sphereGeometry args={[0.18, 16, 12]} />
        <meshBasicMaterial
          color={rPositive ? baseColor : "#f87171"}
          toneMapped={false}
        />
      </mesh>
      {/* Glow base — soft ring on the terrain at the totem's foot */}
      <mesh position={[0, -0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.6, 0.95, 32]} />
        <meshBasicMaterial
          color={baseColor}
          transparent
          opacity={isHovered ? 0.45 : 0.18}
          toneMapped={false}
        />
      </mesh>
      {/* Hover label */}
      {isHovered ? (
        <Html
          position={[0, ringCount * 0.32 + 0.9, 0]}
          center
          style={{ pointerEvents: "none" }}
        >
          <div className="px-2 py-1 rounded-sm bg-black/85 border border-edge text-[0.6rem] font-mono text-slate-100 whitespace-nowrap">
            <div className="text-cyan">{agentId.replace(/^gen\d+-mut\d+-/, "")}</div>
            <div className="text-mist">
              {family} · {totalR >= 0 ? "+" : ""}
              {totalR.toFixed(1)}R · WR {(winRate * 100).toFixed(0)}%
            </div>
          </div>
        </Html>
      ) : null}
    </group>
  );
}

/** Glowing champion sphere on a raised pedestal at the centre. */
function ChampionGlyph({ champion }: { champion: AgentStats | null }) {
  const ref = useRef<THREE.Mesh>(null!);
  const haloRef = useRef<THREE.Mesh>(null!);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (ref.current) {
      ref.current.scale.setScalar(1 + Math.sin(t * 1.6) * 0.05);
    }
    if (haloRef.current) {
      haloRef.current.rotation.z = t * 0.3;
    }
  });
  if (!champion) return null;
  const family = agentFamily(champion.agent_id);
  const color = FAMILY_COLORS[family] ?? "#fde68a";
  return (
    <group position={[0, 0.5, 0]}>
      <mesh ref={ref}>
        <sphereGeometry args={[1.0, 32, 24]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={2.4}
          metalness={0.55}
          roughness={0.18}
        />
      </mesh>
      {/* Halo torus */}
      <mesh ref={haloRef} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.7, 0.04, 16, 96]} />
        <meshBasicMaterial color="#fde68a" toneMapped={false} />
      </mesh>
      {/* Vertical light beam */}
      <mesh position={[0, 8, 0]}>
        <cylinderGeometry args={[0.4, 1.5, 14, 32, 1, true]} />
        <meshBasicMaterial
          color="#fde68a"
          transparent
          opacity={0.18}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

/** Maps an agent into a deterministic (x, z) lane based on family + rank. */
function totemPosition(
  agent: AgentStats,
  byFamily: Map<AgentFam, AgentStats[]>,
): [number, number, number] {
  const family = agentFamily(agent.agent_id);
  const fIdx = FAMILY_ORDER.indexOf(family);
  const cohort = byFamily.get(family) ?? [];
  const ix = cohort.indexOf(agent);
  // Lay out: x = family lane (-spread .. +spread), z = rank within family
  const xSpread = 4.5;
  const zSpread = 3.0;
  const fxOffset = (fIdx - (FAMILY_ORDER.length - 1) / 2) * xSpread;
  const zOffset = (ix - (cohort.length - 1) / 2) * zSpread;
  return [fxOffset, 0, zOffset];
}

export function AgentLandscape({ agents }: { agents: AgentStats[] }) {
  const [hovered, setHovered] = useState<string | null>(null);

  const ranked = [...agents].sort((a, b) => b.total_r - a.total_r);
  const champion = ranked[0] ?? null;
  const others = ranked.slice(1);
  const maxR = Math.max(1, ...others.map((a) => Math.abs(a.total_r)));

  // Group by family so the totems lay out into orderly lanes.
  const byFamily = useMemo(() => {
    const m = new Map<AgentFam, AgentStats[]>();
    for (const a of others) {
      const f = agentFamily(a.agent_id);
      const arr = m.get(f) ?? [];
      arr.push(a);
      m.set(f, arr);
    }
    return m;
  }, [others]);

  return (
    <section className="panel relative overflow-hidden ring-1 ring-royal/20">
      <div className="px-5 md:px-6 pt-5 md:pt-6 pb-3">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <div className="text-[0.6rem] tracking-[0.4em] uppercase">
              <span className="text-amber-300">Manteion</span>
              <span className="text-mist/60 mx-2">·</span>
              <span className="text-purple-300">the swarm landscape</span>
            </div>
            <h3 className="text-xl md:text-2xl font-semibold text-slate-100 mt-1">
              Each totem is one agent. Height = Σ R. Family = colour.
            </h3>
            <p className="text-xs text-mist mt-1.5 max-w-2xl">
              Drag to rotate. Hover any totem for its name and stats. The
              gilded sphere at centre is the current champion. The
              wireframe surface is the regime landscape — calmer in the
              corners, more turbulent where the rules are paying out.
            </p>
          </div>
          <div className="text-[0.6rem] uppercase tracking-widest text-mist text-right">
            <div>
              <span className="text-purple-300">{others.length}</span> totems
            </div>
            <div>
              max Σ R{" "}
              <span className="text-amber-300 num">
                +{maxR.toFixed(0)}R
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="h-[520px] -mx-px border-t border-edge/40 bg-black">
        <Canvas
          dpr={[1, 2]}
          camera={{ position: [0, 7, 26], fov: 50 }}
          gl={{ antialias: true, alpha: false }}
          aria-hidden="true"
        >
          <color attach="background" args={["#03030a"]} />
          <fog attach="fog" args={["#03030a", 28, 80]} />
          <Suspense fallback={null}>
            <ambientLight intensity={0.35} />
            <pointLight position={[0, 12, 6]} intensity={28} color="#fde68a" />
            <pointLight
              position={[-18, 6, -10]}
              intensity={18}
              color="#a855f7"
            />
            <pointLight
              position={[18, 6, -10]}
              intensity={14}
              color="#22d3ee"
            />
            <WireTerrain />
            <ChampionGlyph champion={champion} />
            {others.map((agent) => {
              const family = agentFamily(agent.agent_id);
              const pos = totemPosition(agent, byFamily);
              const ringCount = Math.max(
                3,
                Math.min(14, Math.round((Math.abs(agent.total_r) / maxR) * 14)),
              );
              return (
                <AgentTotem
                  key={agent.agent_id}
                  position={pos}
                  family={family}
                  ringCount={ringCount}
                  rPositive={agent.total_r >= 0}
                  isHovered={hovered === agent.agent_id}
                  onHover={() => setHovered(agent.agent_id)}
                  onLeave={() => setHovered((h) => (h === agent.agent_id ? null : h))}
                  onClick={() => setHovered(agent.agent_id)}
                  agentId={agent.agent_id}
                  totalR={agent.total_r}
                  winRate={agent.win_rate}
                />
              );
            })}
            <OrbitControls
              enableDamping
              dampingFactor={0.08}
              minDistance={12}
              maxDistance={60}
              maxPolarAngle={Math.PI / 2.05}
              target={[0, 0, 0]}
            />
          </Suspense>
        </Canvas>
      </div>

      {/* Family legend along the bottom — same lane order as the scene. */}
      <div className="px-5 md:px-6 py-3 border-t border-edge/40 flex flex-wrap items-center gap-3 text-[0.6rem]">
        <span className="uppercase tracking-widest text-mist">Family lanes</span>
        {FAMILY_ORDER.filter((f) => byFamily.get(f)?.length).map((f) => {
          const color = FAMILY_COLORS[f] ?? "#94a3b8";
          return (
            <span key={f} className="inline-flex items-center gap-1.5 font-mono uppercase text-slate-300">
              <span
                className="w-2 h-2 rounded-full"
                style={{ background: color, boxShadow: `0 0 6px ${color}` }}
              />
              {f}
            </span>
          );
        })}
      </div>
    </section>
  );
}
