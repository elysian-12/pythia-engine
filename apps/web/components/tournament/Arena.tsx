"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Text, Line } from "@react-three/drei";
import {
  EffectComposer,
  Bloom,
  Vignette,
  ChromaticAberration,
  Noise,
} from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { agentFamily, FAMILY_COLORS, type AgentStats } from "@/lib/swarm";

/**
 * Shared orb-state ref keyed by agent_id. The blob phase reads/writes
 * positions into this map so AgentOrb instances can detect collisions
 * with each other and apply elastic-bounce velocities. Once the podium
 * snaps in, collisions disable themselves (the amphitheatre layout is
 * deterministic so jitter is unnecessary). Storing this outside React
 * state avoids per-frame re-renders.
 */
type OrbState = {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  size: number;
};
type OrbMap = Map<string, OrbState>;

/** Intro animation: deterministic "blob" position for an agent, used
 *  for the first ~4 s before the podium layout takes over. Clustered
 *  around the centre with turbulence so it reads as a swarm. */
function blobPosition(seedIdx: number, t: number): THREE.Vector3 {
  const a = seedIdx * 2.3998; // golden-angle spread
  const r = 2.5 + ((seedIdx * 13) % 7) * 0.4;
  const wob = Math.sin(t * 2.1 + seedIdx) * 0.6;
  const wob2 = Math.cos(t * 1.3 + seedIdx * 1.7) * 0.5;
  return new THREE.Vector3(
    Math.cos(a) * r + wob,
    3 + wob2,
    Math.sin(a) * r + wob,
  );
}

/** Amphitheater layout — champion at centre-front, three tiers behind. */
function amphitheaterPosition(rank: number): THREE.Vector3 {
  if (rank === 0) return new THREE.Vector3(0, 3.2, 8); // centre-front pedestal
  // Tier 1: ranks 1..4, close semicircle
  if (rank <= 4) {
    const t = (rank - 1) / 3; // 0..1
    const angle = -Math.PI * 0.42 + t * Math.PI * 0.84;
    const radius = 14;
    return new THREE.Vector3(
      Math.sin(angle) * radius,
      3.0,
      Math.cos(angle) * -radius + 3,
    );
  }
  // Tier 2: ranks 5..11, wider arc behind
  if (rank <= 11) {
    const t = (rank - 5) / 6;
    const angle = -Math.PI * 0.5 + t * Math.PI;
    const radius = 20;
    return new THREE.Vector3(
      Math.sin(angle) * radius,
      1.5,
      Math.cos(angle) * -radius + 3,
    );
  }
  // Tier 3: ranks 12+, back row fading into depth
  const tierIdx = rank - 12;
  const t = tierIdx / Math.max(1, 9);
  const angle = -Math.PI * 0.55 + t * Math.PI * 1.1;
  const radius = 27;
  return new THREE.Vector3(
    Math.sin(angle) * radius,
    0.3,
    Math.cos(angle) * -radius + 3,
  );
}

function normR(r: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(-1, Math.min(1, r / max));
}

function AgentOrb({
  agent,
  rank,
  seedIdx,
  maxAbsR,
  introProgress,
  orbsRef,
}: {
  agent: AgentStats;
  rank: number;
  seedIdx: number;
  maxAbsR: number;
  introProgress: number; // 0 = pure blob · 1 = pure podium
  orbsRef: React.MutableRefObject<OrbMap>;
}) {
  const group = useRef<THREE.Group>(null!);
  const satellite = useRef<THREE.Mesh>(null!);
  const target = useMemo(() => amphitheaterPosition(rank), [rank]);
  const family = agentFamily(agent.agent_id);
  const color = FAMILY_COLORS[family] ?? "#94a3b8";
  const score = normR(agent.total_r, maxAbsR);
  // Tier-appropriate size: tier 1 is slightly chunkier, tier 3 smaller.
  const tierScale = rank === 0 ? 1.0 : rank <= 4 ? 0.75 : rank <= 11 ? 0.55 : 0.42;
  const size = (0.45 + Math.abs(score) * 0.7) * tierScale;
  const emissive = score >= 0 ? color : "#b21d1d";
  const intensity = 0.8 + Math.abs(score) * 1.6;
  const phase = useMemo(() => Math.random() * Math.PI * 2, []);

  // Initial velocity for the blob phase. Each orb gets a distinct direction
  // so they collide and bounce off each other.
  const velRef = useRef(
    new THREE.Vector3(
      Math.cos(seedIdx * 1.7) * 0.6,
      0,
      Math.sin(seedIdx * 1.7) * 0.6,
    ),
  );
  // Register this orb in the shared map on mount.
  useEffect(() => {
    const init = blobPosition(seedIdx, 0);
    orbsRef.current.set(agent.agent_id, {
      pos: init.clone(),
      vel: velRef.current,
      size,
    });
    return () => {
      orbsRef.current.delete(agent.agent_id);
    };
  }, [agent.agent_id, seedIdx, size, orbsRef]);

  useFrame(({ clock }, delta) => {
    if (!group.current) return;
    const t = clock.elapsedTime + phase;
    const k = introProgress;
    const ease = k * k * (3 - 2 * k); // smoothstep — 0 blob · 1 podium

    // Blob phase: integrate position with velocity + a soft pull toward
    // the swarm centre, then resolve collisions against every other orb.
    const me = orbsRef.current.get(agent.agent_id);
    if (me && ease < 0.95) {
      // Cheap drag + centre-pull so velocities don't blow up.
      const centerPull = me.pos.clone().multiplyScalar(-0.6);
      const desiredHover = blobPosition(seedIdx, clock.elapsedTime);
      const hover = desiredHover.sub(me.pos).multiplyScalar(0.8);
      me.vel.add(centerPull.multiplyScalar(delta * 0.05));
      me.vel.add(hover.multiplyScalar(delta * 0.6));
      me.vel.multiplyScalar(0.985); // damping
      me.pos.addScaledVector(me.vel, delta);

      // O(n²) collision resolution. n ≤ 30 in practice — trivially cheap.
      orbsRef.current.forEach((other, id) => {
        if (id === agent.agent_id) return;
        const minDist = me.size + other.size;
        const diff = me.pos.clone().sub(other.pos);
        const d = diff.length();
        if (d > 0.0001 && d < minDist) {
          // Push apart along the contact normal.
          const overlap = minDist - d;
          const n = diff.divideScalar(d); // normal
          me.pos.addScaledVector(n, overlap * 0.5);
          // Reflect velocity component along the normal — elastic bounce.
          const vDotN = me.vel.dot(n);
          if (vDotN < 0) {
            // Add a small kick proportional to relative speed for energy.
            me.vel.addScaledVector(n, -2 * vDotN * 0.85);
          }
        }
      });
    }

    // Blend between the blob (interactive) position and the podium target.
    const blobP = me ? me.pos : blobPosition(seedIdx, clock.elapsedTime);
    const desired = new THREE.Vector3().lerpVectors(blobP, target, ease);
    const p = group.current.position;
    p.x += (desired.x - p.x) * 0.12;
    p.y += (desired.y + Math.sin(t * 0.8) * 0.18 * ease - p.y) * 0.12;
    p.z += (desired.z - p.z) * 0.12;
    if (me) me.pos.set(p.x, p.y, p.z);

    if (satellite.current) {
      const r = size * 1.6;
      satellite.current.position.x = Math.cos(t * 1.5) * r;
      satellite.current.position.z = Math.sin(t * 1.5) * r;
      satellite.current.position.y = Math.sin(t * 0.9) * 0.25;
    }
  });

  return (
    <group ref={group} position={target}>
      <mesh castShadow>
        <icosahedronGeometry args={[size, 2]} />
        <meshStandardMaterial
          color={color}
          emissive={emissive}
          emissiveIntensity={intensity}
          roughness={0.2}
          metalness={0.55}
        />
      </mesh>
      {/* Satellite micro-particle = "this agent is live". */}
      <mesh ref={satellite}>
        <sphereGeometry args={[size * 0.12, 12, 12]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      {/* Rank chip for top-5. */}
      {rank < 5 && rank > 0 ? (
        <Text
          position={[0, size + 0.5, 0]}
          fontSize={0.32}
          color="#cbd5e1"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.01}
          outlineColor="#000"
        >
          {`#${rank + 1}  ${agent.agent_id}`}
        </Text>
      ) : null}
    </group>
  );
}

function ChampionPedestal({
  champion,
  introProgress,
}: {
  champion: AgentStats | null;
  introProgress: number;
}) {
  const coreRef = useRef<THREE.Mesh>(null!);
  const haloRef = useRef<THREE.Mesh>(null!);
  const beamRef = useRef<THREE.Mesh>(null!);
  const groupRef = useRef<THREE.Group>(null!);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (haloRef.current) {
      haloRef.current.rotation.z = t * 0.6;
    }
    if (coreRef.current) {
      const pulse = 1 + Math.sin(t * 2.1) * 0.04;
      coreRef.current.scale.setScalar(pulse);
    }
    if (beamRef.current) {
      const mat = beamRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.28 + 0.14 * Math.sin(t * 1.4);
    }
    if (groupRef.current) {
      // Pedestal rises from below during the intro.
      const k = introProgress;
      const ease = k * k * (3 - 2 * k);
      groupRef.current.position.y = -14 + ease * 14;
      (groupRef.current as THREE.Group & { __scaleY?: number }).__scaleY = ease;
      groupRef.current.scale.y = 0.1 + ease * 0.9;
    }
  });

  if (!champion) return null;

  const family = agentFamily(champion.agent_id);
  const color = FAMILY_COLORS[family] ?? "#fde68a";
  const positive = champion.total_r >= 0;

  return (
    <group ref={groupRef} position={[0, 0, 8]}>
      {/* Glass pedestal column. */}
      <mesh position={[0, -1.4, 0]} castShadow>
        <cylinderGeometry args={[1.1, 1.45, 2.2, 48, 1, true]} />
        <meshPhysicalMaterial
          color="#0a1220"
          transparent
          opacity={0.85}
          transmission={0.35}
          roughness={0.15}
          metalness={0.55}
          clearcoat={1}
        />
      </mesh>
      {/* Top cap (disc) with subtle emission. */}
      <mesh position={[0, -0.29, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1.12, 64]} />
        <meshStandardMaterial
          color="#050811"
          emissive={color}
          emissiveIntensity={0.7}
          roughness={0.2}
          metalness={0.8}
        />
      </mesh>
      {/* Core orb — the champion avatar. */}
      <mesh ref={coreRef} position={[0, 0.5, 0]}>
        <icosahedronGeometry args={[0.95, 3]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={positive ? 2.4 : 0.9}
          roughness={0.15}
          metalness={0.55}
        />
      </mesh>
      {/* Halo ring. */}
      <mesh ref={haloRef} position={[0, 0.5, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.6, 0.04, 16, 128]} />
        <meshBasicMaterial color="#fde68a" toneMapped={false} />
      </mesh>
      {/* Secondary tilted halo. */}
      <mesh position={[0, 0.5, 0]} rotation={[Math.PI / 2.5, Math.PI / 6, 0]}>
        <torusGeometry args={[1.85, 0.02, 16, 128]} />
        <meshBasicMaterial color={color} toneMapped={false} transparent opacity={0.6} />
      </mesh>
      {/* Beam of light. */}
      <mesh ref={beamRef} position={[0, 7, 0]}>
        <cylinderGeometry args={[0.5, 2.1, 15, 40, 1, true]} />
        <meshBasicMaterial
          color="#fde68a"
          transparent
          opacity={0.3}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>
      {/* Champion name etched in 3D text above. */}
      <Text
        position={[0, 2.7, 0]}
        fontSize={0.72}
        color="#f8fafc"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.02}
        outlineColor="#000"
        letterSpacing={0.08}
      >
        {champion.agent_id.toUpperCase()}
      </Text>
      {/* Stats line. */}
      <Text
        position={[0, 2.15, 0]}
        fontSize={0.28}
        color={positive ? "#86efac" : "#fca5a5"}
        anchorX="center"
        anchorY="middle"
        letterSpacing={0.12}
      >
        {`Σ R ${positive ? "+" : ""}${champion.total_r.toFixed(2)}   ·   WR ${(champion.win_rate * 100).toFixed(1)}%   ·   ${champion.wins + champion.losses} TRADES`}
      </Text>
      <Text
        position={[0, 1.72, 0]}
        fontSize={0.18}
        color="#64748b"
        anchorX="center"
        anchorY="middle"
        letterSpacing={0.4}
      >
        CHAMPION
      </Text>
    </group>
  );
}

function EliteLinks({ ranked }: { ranked: AgentStats[] }) {
  // Faint filaments from the champion to each of ranks 1..4 — the
  // elite cluster the executor is drawing from.
  const lines = useMemo(() => {
    if (ranked.length < 2) return [];
    const champ = amphitheaterPosition(0);
    const top = ranked.slice(1, Math.min(5, ranked.length));
    return top.map((_, i) => {
      const rank = i + 1;
      return { from: champ, to: amphitheaterPosition(rank), key: `c-${rank}` };
    });
  }, [ranked]);
  return (
    <group>
      {lines.map((l) => (
        <Line
          key={l.key}
          points={[l.from.toArray(), l.to.toArray()]}
          color="#38bdf8"
          lineWidth={1.0}
          transparent
          opacity={0.22}
          dashed
          dashScale={2.5}
        />
      ))}
    </group>
  );
}

function Floor() {
  // Marble disc + radial ridges — the Pythian sanctuary at Delphi.
  return (
    <group position={[0, -1.5, 3]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[50, 128]} />
        <meshStandardMaterial
          color="#0b0e16"
          emissive="#1a233a"
          emissiveIntensity={0.45}
          roughness={0.3}
          metalness={0.55}
        />
      </mesh>
      {/* Concentric faint rings — sanctuary terraces. */}
      {[8, 14, 20, 28].map((r, i) => (
        <mesh key={r} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
          <ringGeometry args={[r - 0.03, r, 128]} />
          <meshBasicMaterial
            color="#fde68a"
            transparent
            opacity={0.18 - i * 0.035}
            toneMapped={false}
          />
        </mesh>
      ))}
      {/* Compass rose at the centre — the omphalos, navel of the world. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <ringGeometry args={[2.4, 2.55, 64]} />
        <meshBasicMaterial color="#fde68a" transparent opacity={0.55} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Doric temple columns in a wide semicircle behind the amphitheatre.
 *  Twelve columns × Olympian peristyle motif. Subtle gold rim-lighting so
 *  they read as architecture, not pillars-of-fire. */
function TempleColonnade() {
  const columns = useMemo(() => {
    const out: { x: number; z: number; angle: number }[] = [];
    const N = 13;
    const radius = 35;
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const angle = -Math.PI * 0.62 + t * Math.PI * 1.24;
      out.push({
        x: Math.sin(angle) * radius,
        z: Math.cos(angle) * -radius + 3,
        angle,
      });
    }
    return out;
  }, []);
  return (
    <group>
      {columns.map((c) => (
        <group key={`${c.x}-${c.z}`} position={[c.x, -1.5, c.z]}>
          {/* Stylobate (base block) */}
          <mesh position={[0, 0.25, 0]}>
            <boxGeometry args={[1.6, 0.5, 1.6]} />
            <meshStandardMaterial color="#1a2030" metalness={0.45} roughness={0.6} />
          </mesh>
          {/* Fluted shaft — segmented for that fluted-marble silhouette */}
          <mesh position={[0, 4.2, 0]} castShadow>
            <cylinderGeometry args={[0.55, 0.7, 7.4, 18, 1, false]} />
            <meshStandardMaterial
              color="#cbd5e1"
              emissive="#1f2a44"
              emissiveIntensity={0.25}
              roughness={0.55}
              metalness={0.35}
            />
          </mesh>
          {/* Capital (top) — simple Doric square block */}
          <mesh position={[0, 8.05, 0]}>
            <boxGeometry args={[1.45, 0.5, 1.45]} />
            <meshStandardMaterial
              color="#e5e7eb"
              emissive="#fde68a"
              emissiveIntensity={0.18}
              metalness={0.6}
              roughness={0.4}
            />
          </mesh>
          {/* Subtle gold rim glow at the top */}
          <pointLight
            position={[0, 8.6, 0]}
            intensity={1.6}
            color="#fde68a"
            distance={6}
            decay={2}
          />
        </group>
      ))}
    </group>
  );
}

/** Laurel wreath orbiting the champion — the victor's crown. Ten leaves
 *  on each half, slowly spinning. */
function LaurelWreath() {
  const ref = useRef<THREE.Group>(null!);
  const leaves = useMemo(() => {
    const out: { angle: number; tilt: number; flip: number }[] = [];
    const N = 22;
    for (let i = 0; i < N; i++) {
      out.push({
        angle: (i / N) * Math.PI * 2,
        tilt: Math.sin(i * 0.7) * 0.15,
        flip: i % 2 === 0 ? 1 : -1,
      });
    }
    return out;
  }, []);
  useFrame(({ clock }) => {
    if (ref.current) {
      ref.current.rotation.y = clock.elapsedTime * 0.18;
    }
  });
  return (
    <group ref={ref} position={[0, 1.85, 8]}>
      {leaves.map((leaf, i) => {
        const r = 2.05;
        return (
          <mesh
            key={i}
            position={[Math.cos(leaf.angle) * r, leaf.tilt, Math.sin(leaf.angle) * r]}
            rotation={[leaf.flip * 0.25, -leaf.angle + Math.PI / 2, 0.35]}
          >
            <coneGeometry args={[0.13, 0.5, 6]} />
            <meshStandardMaterial
              color="#facc15"
              emissive="#fbbf24"
              emissiveIntensity={0.7}
              metalness={0.7}
              roughness={0.35}
            />
          </mesh>
        );
      })}
    </group>
  );
}

function EmberField() {
  // Slow-rising glowing motes for atmosphere.
  const ref = useRef<THREE.Points>(null!);
  const count = 220;
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const speed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const r = 6 + Math.random() * 40;
      const a = Math.random() * Math.PI * 2;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = -1 + Math.random() * 18;
      pos[i * 3 + 2] = Math.sin(a) * r;
      speed[i] = 0.08 + Math.random() * 0.2;
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    (g as THREE.BufferGeometry & { userData: { speed: Float32Array } }).userData = { speed };
    return g;
  }, []);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const attr = ref.current.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const speeds = (ref.current.geometry as THREE.BufferGeometry & {
      userData: { speed: Float32Array };
    }).userData.speed;
    for (let i = 0; i < count; i++) {
      arr[i * 3 + 1] += speeds[i] * 0.015;
      if (arr[i * 3 + 1] > 18) arr[i * 3 + 1] = -1;
    }
    attr.needsUpdate = true;
    ref.current.rotation.y = clock.elapsedTime * 0.01;
  });
  return (
    <points ref={ref} geometry={geom}>
      <pointsMaterial
        color="#7dd3fc"
        size={0.13}
        sizeAttenuation
        transparent
        opacity={0.75}
        toneMapped={false}
      />
    </points>
  );
}

function BackWall({ generation }: { generation: number }) {
  // Engraved frieze + Greek dedication. The Pythia at Delphi was the
  // priestess of Apollo — keep the wording close to what would be carved
  // into the temple architrave.
  return (
    <group position={[0, 4.5, -26]}>
      <Text
        fontSize={2.2}
        color="#0f172a"
        outlineColor="#fbbf24"
        outlineWidth={0.05}
        anchorX="center"
        anchorY="middle"
        letterSpacing={0.5}
      >
        ΟΡΑΚΛΟΝ ΤΟΥ ΣΜΗΝΟΥΣ
      </Text>
      <Text
        position={[0, -1.4, 0]}
        fontSize={0.55}
        color="#475569"
        anchorX="center"
        anchorY="middle"
        letterSpacing={0.4}
      >
        ORACLE OF THE SWARM · DELPHI
      </Text>
      <Text
        position={[0, -2.4, 0]}
        fontSize={0.4}
        color="#334155"
        anchorX="center"
        anchorY="middle"
        letterSpacing={0.6}
      >
        {`Γενεά ${generation.toString().padStart(3, "0")}  ·  GENERATION ${generation.toString().padStart(3, "0")}`}
      </Text>
    </group>
  );
}

/** Constellation field high in the dome. Sparse, twinkling — Greek myths
 *  set their heroes among the stars. Twelve named constellations, one per
 *  Olympian, rendered as twinkling point clusters. */
function Constellations() {
  const ref = useRef<THREE.Points>(null!);
  const count = 220;
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const phase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // Distribute on a hemisphere above the arena
      const u = Math.random();
      const v = Math.random();
      const theta = u * Math.PI * 2;
      const phi = Math.acos(2 * v - 1) * 0.5; // upper hemisphere only
      const r = 70 + Math.random() * 8;
      pos[i * 3] = Math.sin(phi) * Math.cos(theta) * r;
      pos[i * 3 + 1] = Math.cos(phi) * r * 0.7 + 8;
      pos[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * r;
      phase[i] = Math.random() * Math.PI * 2;
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    (g as THREE.BufferGeometry & { userData: { phase: Float32Array } }).userData = { phase };
    return g;
  }, []);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    // Subtle twinkle by rotating the whole field slowly.
    ref.current.rotation.y = clock.elapsedTime * 0.005;
  });
  return (
    <points ref={ref} geometry={geom}>
      <pointsMaterial
        color="#fde68a"
        size={0.45}
        sizeAttenuation
        transparent
        opacity={0.85}
        toneMapped={false}
      />
    </points>
  );
}

function Rig() {
  useFrame(({ camera, clock }) => {
    // Slow drifting boom shot — long focal length, low angle.
    const t = clock.elapsedTime * 0.05;
    const r = 32;
    camera.position.x = Math.sin(t) * r;
    camera.position.z = 18 + Math.cos(t) * 6;
    camera.position.y = 7 + Math.sin(t * 0.7) * 1.2;
    camera.lookAt(0, 2.5, 4);
  });
  return null;
}

/** Animates 0 → 1 over `duration` seconds then holds. */
function useIntro(duration = 4.5) {
  const [p, setP] = useState(0);
  useEffect(() => {
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / 1000 / duration);
      setP(t);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [duration]);
  return p;
}

export function Arena({
  agents,
  generation = 0,
}: {
  agents: AgentStats[];
  generation?: number;
}) {
  const ranked = agents;
  const maxAbsR = Math.max(1, ...ranked.map((a) => Math.abs(a.total_r)));
  const champion = ranked[0] ?? null;
  const introProgress = useIntro(4.5);
  // Shared orb position/velocity map for collision resolution. Lives outside
  // React state so per-frame mutations don't trigger re-renders.
  const orbsRef = useRef<OrbMap>(new Map());

  // Give each agent a stable seedIdx so its blob spot is deterministic
  // even if ranks reshuffle mid-session.
  const seeds = useMemo(() => {
    const m = new Map<string, number>();
    ranked.forEach((a, i) => m.set(a.agent_id, i));
    return m;
  }, [ranked]);

  return (
    <Canvas
      dpr={[1, 2]}
      shadows
      camera={{ position: [0, 8, 28], fov: 42 }}
      gl={{ antialias: true, alpha: true }}
    >
      <color attach="background" args={["#030509"]} />
      <fog attach="fog" args={["#030509", 28, 75]} />
      <Suspense fallback={null}>
        <ambientLight intensity={0.28} />
        <directionalLight
          position={[0, 18, 14]}
          intensity={1.4}
          color="#bae6fd"
          castShadow
        />
        <pointLight position={[0, 10, 8]} intensity={30} color="#fde68a" distance={45} decay={2} />
        <pointLight position={[-22, 6, -12]} intensity={22} color="#34d399" distance={60} decay={2} />
        <pointLight position={[22, 6, -12]} intensity={22} color="#38bdf8" distance={60} decay={2} />
        <spotLight
          position={[0, 18, 8]}
          angle={0.28}
          penumbra={0.7}
          intensity={60}
          color="#fde68a"
          target-position={[0, 0, 8]}
          castShadow
        />
        <EmberField />
        <Constellations />
        <Floor />
        <TempleColonnade />
        <BackWall generation={generation} />
        {/* Only show filaments + champion pedestal once the podium has
            materialised — hides them during the blob phase. */}
        {introProgress > 0.5 ? <EliteLinks ranked={ranked} /> : null}
        <ChampionPedestal champion={champion} introProgress={introProgress} />
        {introProgress > 0.7 ? <LaurelWreath /> : null}
        {ranked.map((a, i) =>
          i === 0 ? null : (
            <AgentOrb
              key={a.agent_id}
              agent={a}
              rank={i}
              seedIdx={seeds.get(a.agent_id) ?? i}
              maxAbsR={maxAbsR}
              introProgress={introProgress}
              orbsRef={orbsRef}
            />
          ),
        )}
        <Rig />
        <OrbitControls
          enablePan={false}
          enableDamping
          dampingFactor={0.08}
          rotateSpeed={0.35}
          maxDistance={75}
          minDistance={18}
          maxPolarAngle={Math.PI / 2.05}
          target={[0, 2.5, 4]}
        />
        <EffectComposer>
          <Bloom
            intensity={1.3}
            luminanceThreshold={0.1}
            luminanceSmoothing={0.28}
            mipmapBlur
          />
          <ChromaticAberration
            blendFunction={BlendFunction.NORMAL}
            offset={new THREE.Vector2(0.0009, 0.0009)}
          />
          <Noise premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={0.4} />
          <Vignette eskil={false} offset={0.2} darkness={0.9} />
        </EffectComposer>
      </Suspense>
    </Canvas>
  );
}
