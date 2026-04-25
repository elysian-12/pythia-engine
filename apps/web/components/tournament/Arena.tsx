"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Html } from "@react-three/drei";
import {
  EffectComposer,
  Bloom,
  Vignette,
} from "@react-three/postprocessing";
import { Suspense, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import {
  agentFamily,
  FAMILY_COLORS,
  type AgentStats,
  type AgentFam,
} from "@/lib/swarm";

/**
 * Pythian arena.
 *
 * The Pythia at Delphi sat on a bronze tripod above the omphalos — the
 * navel of the world — and prophesied. We render that scene as a 3D
 * data-art piece: a wavy regime landscape, agents as stacked-ring
 * totems planted on it, the champion as a glowing oracle orb floating
 * above a gilded tripod at the centre, with beams of "prophecy" linking
 * her to the top specialists. Agent totems flash when their agent
 * fires, and mantic vapor rises from the omphalos.
 *
 * Replaces the prior Colosseum-and-orbs scene entirely. The aesthetic
 * goal: dynamic, legible, thematically Pythian — not a generic space
 * scene with planets.
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

const ACCENT = "#a855f7"; // Tyrian purple

/** Wireframe regime landscape. Slow, sinusoidal — reads as "the market
 *  surface" rather than literal terrain. */
function RegimeSurface() {
  const ref = useRef<THREE.Mesh>(null!);
  const geom = useMemo(() => {
    const g = new THREE.PlaneGeometry(120, 80, 100, 70);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);
  const baseY = useMemo(() => {
    const pos = geom.attributes.position;
    const out = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) out[i] = pos.getY(i);
    return out;
  }, [geom]);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.elapsedTime * 0.4;
    const pos = ref.current.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      // Gentle radial falloff so the centre stays flat enough for the
      // tripod and totems to sit cleanly.
      const r = Math.sqrt(x * x + z * z);
      const falloff = Math.min(1, r / 40);
      const h =
        (Math.sin(x * 0.16 + t) * 0.8 +
          Math.cos(z * 0.2 + t * 0.7) * 0.7 +
          Math.sin((x + z) * 0.11 - t * 0.4) * 0.4) *
        falloff;
      pos.setY(i, baseY[i] + h);
    }
    pos.needsUpdate = true;
  });
  return (
    <mesh ref={ref} position={[0, -3.4, 0]}>
      <primitive object={geom} attach="geometry" />
      <meshBasicMaterial
        color="#cbd5e1"
        wireframe
        transparent
        opacity={0.28}
      />
    </mesh>
  );
}

/** Pythian tripod — three gilded legs supporting a wide bronze rim
 *  beneath the oracle's seat. The champion orb floats above it.
 *  Subtly rotates. */
function PythianTripod() {
  const ref = useRef<THREE.Group>(null!);
  useFrame(({ clock }) => {
    if (ref.current) {
      ref.current.rotation.y = clock.elapsedTime * 0.05;
    }
  });
  return (
    <group ref={ref} position={[0, -3.0, 0]}>
      {/* Three legs at 120° */}
      {[0, 120, 240].map((deg) => {
        const rad = (deg * Math.PI) / 180;
        return (
          <mesh
            key={deg}
            position={[Math.cos(rad) * 0.9, 1.2, Math.sin(rad) * 0.9]}
            rotation={[
              Math.cos(rad) * 0.18,
              0,
              -Math.sin(rad) * 0.18,
            ]}
          >
            <cylinderGeometry args={[0.06, 0.09, 2.6, 12]} />
            <meshStandardMaterial
              color="#fbbf24"
              emissive="#fde68a"
              emissiveIntensity={0.55}
              metalness={0.85}
              roughness={0.25}
            />
          </mesh>
        );
      })}
      {/* Bronze rim — the oracle's seat */}
      <mesh position={[0, 2.45, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.0, 0.08, 16, 64]} />
        <meshStandardMaterial
          color="#fbbf24"
          emissive="#f59e0b"
          emissiveIntensity={0.85}
          metalness={0.9}
          roughness={0.18}
        />
      </mesh>
      {/* Spoke decoration on the rim */}
      {[0, 60, 120, 180, 240, 300].map((deg) => {
        const rad = (deg * Math.PI) / 180;
        return (
          <mesh
            key={deg}
            position={[Math.cos(rad) * 0.5, 2.45, Math.sin(rad) * 0.5]}
          >
            <boxGeometry args={[0.04, 0.04, 1.0]} />
            <meshStandardMaterial color="#fde68a" emissive="#fde68a" emissiveIntensity={0.4} />
          </mesh>
        );
      })}
    </group>
  );
}

/** The omphalos — Delphi's "navel of the world" stone, glowing softly
 *  beneath the tripod. Mantic vapor rises from it. */
function Omphalos() {
  const vaporRef = useRef<THREE.Points>(null!);
  const count = 80;
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const speed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.8;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = -3 + Math.random() * 0.5;
      pos[i * 3 + 2] = Math.sin(a) * r;
      speed[i] = 0.4 + Math.random() * 0.7;
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    (g as THREE.BufferGeometry & { userData: { speed: Float32Array } }).userData = { speed };
    return g;
  }, []);
  useFrame((_state, delta) => {
    if (!vaporRef.current) return;
    const attr = vaporRef.current.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const speeds = (vaporRef.current.geometry as THREE.BufferGeometry & {
      userData: { speed: Float32Array };
    }).userData.speed;
    for (let i = 0; i < count; i++) {
      arr[i * 3 + 1] += speeds[i] * delta;
      // Drift outward as it rises
      arr[i * 3] *= 1.005;
      arr[i * 3 + 2] *= 1.005;
      if (arr[i * 3 + 1] > 4) {
        arr[i * 3 + 1] = -3;
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 0.6;
        arr[i * 3] = Math.cos(a) * r;
        arr[i * 3 + 2] = Math.sin(a) * r;
      }
    }
    attr.needsUpdate = true;
  });
  return (
    <group>
      {/* Stone */}
      <mesh position={[0, -3.0, 0]}>
        <sphereGeometry args={[0.7, 32, 24]} />
        <meshStandardMaterial
          color="#1e1b4b"
          emissive={ACCENT}
          emissiveIntensity={0.45}
          roughness={0.45}
          metalness={0.35}
        />
      </mesh>
      {/* Inscribed ring at the base */}
      <mesh position={[0, -3.4, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.1, 1.3, 64]} />
        <meshBasicMaterial color="#fde68a" transparent opacity={0.5} toneMapped={false} />
      </mesh>
      {/* Mantic vapor */}
      <points ref={vaporRef} geometry={geom}>
        <pointsMaterial
          color={ACCENT}
          size={0.22}
          sizeAttenuation
          transparent
          opacity={0.5}
          toneMapped={false}
          depthWrite={false}
        />
      </points>
    </group>
  );
}

/** Champion orb floating above the tripod. Pulses, slowly orbits a
 *  halo. Sends a beam of light upward into the dome. */
function ChampionOrb({
  champion,
  activeKey,
}: {
  champion: AgentStats | null;
  activeKey: number;
}) {
  const orbRef = useRef<THREE.Mesh>(null!);
  const haloRef = useRef<THREE.Mesh>(null!);
  const beamRef = useRef<THREE.Mesh>(null!);
  const flashStartRef = useRef<number>(-Infinity);

  // Pulse on every event — champion-side feedback that the system is live.
  useMemo(() => {
    flashStartRef.current = performance.now();
  }, [activeKey]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const sinceFlash = (performance.now() - flashStartRef.current) / 700;
    const flash = sinceFlash < 1 ? Math.max(0, 1 - sinceFlash) : 0;
    if (orbRef.current) {
      orbRef.current.scale.setScalar(1 + Math.sin(t * 1.6) * 0.04 + flash * 0.3);
      const mat = orbRef.current.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 2.6 + flash * 3;
    }
    if (haloRef.current) {
      haloRef.current.rotation.z = t * 0.4;
    }
    if (beamRef.current) {
      const mat = beamRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.18 + 0.12 * Math.sin(t * 1.4) + flash * 0.2;
    }
  });

  if (!champion) return null;
  const family = agentFamily(champion.agent_id);
  const color = FAMILY_COLORS[family] ?? "#fde68a";

  return (
    <group position={[0, 0, 0]}>
      <mesh ref={orbRef}>
        <icosahedronGeometry args={[0.95, 3]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={2.6}
          metalness={0.6}
          roughness={0.18}
        />
      </mesh>
      {/* Spinning gold halo */}
      <mesh ref={haloRef} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.7, 0.04, 16, 96]} />
        <meshBasicMaterial color="#fde68a" toneMapped={false} />
      </mesh>
      {/* Tilted secondary halo */}
      <mesh rotation={[Math.PI / 2.5, Math.PI / 6, 0]}>
        <torusGeometry args={[2.0, 0.025, 16, 96]} />
        <meshBasicMaterial
          color={ACCENT}
          toneMapped={false}
          transparent
          opacity={0.6}
        />
      </mesh>
      {/* Beam of prophecy, rising into the dome */}
      <mesh ref={beamRef} position={[0, 9, 0]}>
        <cylinderGeometry args={[0.5, 1.8, 18, 32, 1, true]} />
        <meshBasicMaterial
          color="#fde68a"
          transparent
          opacity={0.2}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>
      {/* Champion label */}
      <Html position={[0, 1.8, 0]} center distanceFactor={14}>
        <div className="px-2 py-0.5 rounded-sm bg-black/85 ring-1 ring-amber/50 text-[0.6rem] font-mono text-amber whitespace-nowrap">
          👑 {champion.agent_id.replace(/^gen\d+-mut\d+-/, "")}
        </div>
      </Html>
    </group>
  );
}

type LaneInfo = { x: number; z: number };

/** Place each agent on a deterministic spot within its family lane. */
function totemPlacement(
  agent: AgentStats,
  byFamily: Map<AgentFam, AgentStats[]>,
): LaneInfo {
  const family = agentFamily(agent.agent_id);
  const fIdx = FAMILY_ORDER.indexOf(family);
  const cohort = byFamily.get(family) ?? [];
  const ix = cohort.indexOf(agent);
  // Family lanes spiral outward on a ring; agents within a family
  // step radially. Keeps the centre clear for the tripod.
  const angle = (fIdx / FAMILY_ORDER.length) * Math.PI * 2 + Math.PI / 9;
  const radius = 9 + ix * 1.4;
  return {
    x: Math.cos(angle) * radius,
    z: Math.sin(angle) * radius,
  };
}

function AgentTotem({
  agent,
  position,
  ringCount,
  family,
  rPositive,
  isHovered,
  onHover,
  onLeave,
  isActive,
  activeKey,
}: {
  agent: AgentStats;
  position: [number, number, number];
  ringCount: number;
  family: AgentFam;
  rPositive: boolean;
  isHovered: boolean;
  onHover: () => void;
  onLeave: () => void;
  isActive: boolean;
  activeKey: number;
}) {
  const baseColor = FAMILY_COLORS[family] ?? "#94a3b8";
  const groupRef = useRef<THREE.Group>(null!);
  const flashStartRef = useRef<number>(-Infinity);
  useMemo(() => {
    if (isActive) flashStartRef.current = performance.now();
  }, [isActive, activeKey]);

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const phase = position[0] * 0.5 + position[2] * 0.5;
    const bob = Math.sin(clock.elapsedTime * 1.2 + phase) * 0.06;
    groupRef.current.position.y = position[1] + bob;
    if (isHovered) {
      groupRef.current.rotation.y = clock.elapsedTime * 0.4;
    } else {
      groupRef.current.rotation.y *= 0.95;
    }
  });

  const rings = useMemo(() => {
    const out: { y: number; radius: number; color: string }[] = [];
    for (let i = 0; i < ringCount; i++) {
      const t = i / Math.max(1, ringCount - 1);
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
    >
      {rings.map((r, i) => (
        <FlashRing
          key={i}
          y={r.y}
          radius={r.radius}
          color={r.color}
          isHovered={isHovered}
          flashStartRef={flashStartRef}
        />
      ))}
      <mesh position={[0, ringCount * 0.32 + 0.3, 0]}>
        <sphereGeometry args={[0.2, 16, 12]} />
        <meshBasicMaterial
          color={rPositive ? baseColor : "#f87171"}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[0, -0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.6, 0.95, 32]} />
        <meshBasicMaterial
          color={baseColor}
          transparent
          opacity={isHovered ? 0.45 : 0.18}
          toneMapped={false}
        />
      </mesh>
      {isHovered ? (
        <Html
          position={[0, ringCount * 0.32 + 1.0, 0]}
          center
          style={{ pointerEvents: "none" }}
        >
          <div className="px-2 py-1 rounded-sm bg-black/85 border border-edge text-[0.6rem] font-mono text-slate-100 whitespace-nowrap">
            <div className="text-purple-300">{agent.agent_id.replace(/^gen\d+-mut\d+-/, "")}</div>
            <div className="text-mist">
              {family} · {agent.total_r >= 0 ? "+" : ""}
              {agent.total_r.toFixed(1)}R · WR{" "}
              {(agent.win_rate * 100).toFixed(0)}%
            </div>
          </div>
        </Html>
      ) : null}
    </group>
  );
}

/** A torus ring whose emissive intensity flares on activeKey change. */
function FlashRing({
  y,
  radius,
  color,
  isHovered,
  flashStartRef,
}: {
  y: number;
  radius: number;
  color: string;
  isHovered: boolean;
  flashStartRef: React.MutableRefObject<number>;
}) {
  const meshRef = useRef<THREE.Mesh>(null!);
  useFrame(() => {
    if (!meshRef.current) return;
    const sinceFlash = (performance.now() - flashStartRef.current) / 700;
    const flash = sinceFlash < 1 ? Math.max(0, 1 - sinceFlash) : 0;
    const mat = meshRef.current.material as THREE.MeshBasicMaterial;
    mat.opacity = (isHovered ? 1.0 : 0.85) + flash * 0.3;
    meshRef.current.scale.setScalar(1 + flash * 0.25);
  });
  return (
    <mesh ref={meshRef} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]}>
      <torusGeometry args={[radius, 0.045, 10, 40]} />
      <meshBasicMaterial color={color} toneMapped={false} transparent opacity={0.85} />
    </mesh>
  );
}

/** Filaments from the champion orb to the top-3 specialists, each
 *  carrying a moving spark — the visible "prophecy". */
function ProphecyBeams({
  champion,
  agents,
  byFamily,
}: {
  champion: AgentStats | null;
  agents: AgentStats[];
  byFamily: Map<AgentFam, AgentStats[]>;
}) {
  const tops = useMemo(() => {
    if (!champion) return [];
    return agents
      .filter((a) => a.agent_id !== champion.agent_id)
      .slice(0, 3)
      .map((a) => {
        const p = totemPlacement(a, byFamily);
        return {
          target: new THREE.Vector3(p.x, 1.2, p.z),
          color: FAMILY_COLORS[agentFamily(a.agent_id)] ?? "#94a3b8",
          phase: Math.random(),
        };
      });
  }, [champion, agents, byFamily]);
  return (
    <group>
      {tops.map((t, i) => (
        <Beam key={i} from={new THREE.Vector3(0, 0, 0)} to={t.target} color={t.color} phase={t.phase} />
      ))}
    </group>
  );
}

function Beam({
  from,
  to,
  color,
  phase,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  color: string;
  phase: number;
}) {
  const sparkRef = useRef<THREE.Mesh>(null!);
  useFrame(({ clock }) => {
    if (!sparkRef.current) return;
    const t = (clock.elapsedTime * 0.6 + phase) % 1;
    sparkRef.current.position.lerpVectors(from, to, t);
    const mat = sparkRef.current.material as THREE.MeshBasicMaterial;
    mat.opacity = 0.4 + (1 - t) * 0.6;
  });
  // Static line geometry from from→to
  const lineGeom = useMemo(() => {
    const g = new THREE.BufferGeometry().setFromPoints([from, to]);
    return g;
  }, [from, to]);
  return (
    <group>
      <line>
        <primitive object={lineGeom} attach="geometry" />
        <lineBasicMaterial color={color} transparent opacity={0.32} />
      </line>
      <mesh ref={sparkRef}>
        <sphereGeometry args={[0.18, 14, 14]} />
        <meshBasicMaterial color={color} toneMapped={false} transparent />
      </mesh>
    </group>
  );
}

/** Constellation field high in the dome — legend says Greek heroes
 *  were placed among the stars by the gods. */
function StarsDome() {
  const ref = useRef<THREE.Points>(null!);
  const count = 240;
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const u = Math.random();
      const v = Math.random();
      const theta = u * Math.PI * 2;
      const phi = Math.acos(2 * v - 1) * 0.5;
      const r = 70 + Math.random() * 8;
      pos[i * 3] = Math.sin(phi) * Math.cos(theta) * r;
      pos[i * 3 + 1] = Math.cos(phi) * r * 0.7 + 8;
      pos[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * r;
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
  }, []);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    ref.current.rotation.y = clock.elapsedTime * 0.005;
  });
  return (
    <points ref={ref} geometry={geom}>
      <pointsMaterial
        color="#fde68a"
        size={0.5}
        sizeAttenuation
        transparent
        opacity={0.85}
        toneMapped={false}
      />
    </points>
  );
}

export function Arena({
  agents,
  generation = 0,
  activeIds = new Set<string>(),
  activeKey = 0,
}: {
  agents: AgentStats[];
  generation?: number;
  activeIds?: Set<string>;
  activeKey?: number;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const ranked = [...agents].sort((a, b) => b.total_r - a.total_r);
  const champion = ranked[0] ?? null;
  const others = ranked.slice(1);
  const maxR = Math.max(1, ...others.map((a) => Math.abs(a.total_r)));

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
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [0, 6, 24], fov: 52 }}
      gl={{ antialias: true, alpha: false }}
      aria-hidden="true"
    >
      <color attach="background" args={["#03020a"]} />
      <fog attach="fog" args={["#03020a", 32, 100]} />
      <Suspense fallback={null}>
        <ambientLight intensity={0.32} />
        <pointLight position={[0, 12, 4]} intensity={42} color="#fde68a" />
        <pointLight position={[-22, 6, -10]} intensity={22} color={ACCENT} />
        <pointLight position={[22, 6, -10]} intensity={18} color="#22d3ee" />
        <StarsDome />
        <RegimeSurface />
        <Omphalos />
        <PythianTripod />
        <ChampionOrb champion={champion} activeKey={activeKey} />
        <ProphecyBeams champion={champion} agents={others} byFamily={byFamily} />
        {others.map((agent) => {
          const family = agentFamily(agent.agent_id);
          const place = totemPlacement(agent, byFamily);
          const ringCount = Math.max(
            3,
            Math.min(14, Math.round((Math.abs(agent.total_r) / maxR) * 14)),
          );
          return (
            <AgentTotem
              key={agent.agent_id}
              agent={agent}
              position={[place.x, 0, place.z]}
              family={family}
              ringCount={ringCount}
              rPositive={agent.total_r >= 0}
              isHovered={hovered === agent.agent_id}
              onHover={() => setHovered(agent.agent_id)}
              onLeave={() => setHovered((h) => (h === agent.agent_id ? null : h))}
              isActive={activeIds.has(agent.agent_id)}
              activeKey={activeKey}
            />
          );
        })}
        <Html position={[0, 14, -30]} center distanceFactor={20}>
          <div className="text-center pointer-events-none">
            <div className="text-amber-300 font-semibold tracking-[0.4em] text-sm">
              ΜΑΝΤΕΙΟΝ ΤΟΥ ΣΜΗΝΟΥΣ
            </div>
            <div className="text-purple-300 tracking-[0.3em] text-[0.6rem] mt-1">
              ORACLE OF THE SWARM · GEN {generation.toString().padStart(3, "0")}
            </div>
          </div>
        </Html>
        <OrbitControls
          enableDamping
          dampingFactor={0.08}
          minDistance={12}
          maxDistance={60}
          maxPolarAngle={Math.PI / 2.05}
          target={[0, 1, 0]}
        />
        <EffectComposer>
          <Bloom
            intensity={1.2}
            luminanceThreshold={0.12}
            luminanceSmoothing={0.32}
            mipmapBlur
          />
          <Vignette eskil={false} offset={0.2} darkness={0.85} />
        </EffectComposer>
      </Suspense>
    </Canvas>
  );
}
