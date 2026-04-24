"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Text, Line } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import { Suspense, useMemo, useRef } from "react";
import * as THREE from "three";
import { agentFamily, FAMILY_COLORS, type AgentStats } from "@/lib/swarm";

/** Converts a signed total_r into a normalised score in [-1, 1]. */
function normR(r: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(-1, Math.min(1, r / max));
}

/** Agent position on the arena surface.
 *  Rank 0 (champion) floats at the top pedestal; remainder are spread
 *  around an ellipsoid band whose elevation depends on rank.
 */
function arenaPosition(rank: number, total: number): THREE.Vector3 {
  if (rank === 0) return new THREE.Vector3(0, 14, 0);
  // Band: distribute rank 1..N around a widening circle as rank grows.
  const ringT = (rank - 1) / Math.max(1, total - 1); // 0..1
  const angle = (rank - 1) * ((Math.PI * 2) / Math.max(1, total - 1)) * 2.1;
  const y = 10 - ringT * 16; // from 10 down to -6
  const radius = 11 + ringT * 10; // inner 11 to outer 21
  return new THREE.Vector3(
    Math.cos(angle) * radius,
    y,
    Math.sin(angle) * radius,
  );
}

function AgentOrb({
  agent,
  rank,
  total,
  maxAbsR,
  isChampion,
}: {
  agent: AgentStats;
  rank: number;
  total: number;
  maxAbsR: number;
  isChampion: boolean;
}) {
  const group = useRef<THREE.Group>(null!);
  const target = useMemo(() => arenaPosition(rank, total), [rank, total]);
  const family = agentFamily(agent.agent_id);
  const color = FAMILY_COLORS[family] ?? "#94a3b8";
  const score = normR(agent.total_r, maxAbsR);
  const size = 0.35 + Math.abs(score) * 0.95 + (isChampion ? 0.6 : 0);
  const emissive = score >= 0 ? color : "#9a1c1c";
  const intensity = 0.9 + Math.abs(score) * 1.8 + (isChampion ? 1.2 : 0);
  const phase = useMemo(() => Math.random() * Math.PI * 2, []);

  useFrame(({ clock }) => {
    if (!group.current) return;
    const t = clock.elapsedTime + phase;
    // Smoothly ease toward target on rerank.
    const p = group.current.position;
    p.x += (target.x - p.x) * 0.05;
    p.y += (target.y + Math.sin(t * 0.9) * 0.25 - p.y) * 0.05;
    p.z += (target.z - p.z) * 0.05;
    // Gentle spin on the champion pedestal.
    if (isChampion) {
      group.current.rotation.y = t * 0.4;
    }
  });

  return (
    <group ref={group} position={target}>
      <mesh castShadow>
        <icosahedronGeometry args={[size, isChampion ? 2 : 1]} />
        <meshStandardMaterial
          color={color}
          emissive={emissive}
          emissiveIntensity={intensity}
          roughness={0.25}
          metalness={0.4}
        />
      </mesh>
      {/* Halo for the champion. */}
      {isChampion ? (
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[size * 1.7, 0.08, 16, 96]} />
          <meshBasicMaterial color="#fde68a" toneMapped={false} />
        </mesh>
      ) : null}
      {/* Rank chip for top-5. */}
      {rank < 5 ? (
        <Text
          position={[0, size + 0.8, 0]}
          fontSize={0.55}
          color="#e2e8f0"
          anchorX="center"
          anchorY="middle"
        >
          {`#${rank + 1}  ${agent.agent_id}`}
        </Text>
      ) : null}
    </group>
  );
}

function ChampionBeam({ enabled }: { enabled: boolean }) {
  const ref = useRef<THREE.Mesh>(null!);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const s = 0.5 + Math.sin(clock.elapsedTime * 2.1) * 0.12;
    ref.current.scale.set(s, 1, s);
    (ref.current.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.25 * Math.sin(clock.elapsedTime * 1.6);
  });
  if (!enabled) return null;
  return (
    <mesh ref={ref} position={[0, 5, 0]}>
      <cylinderGeometry args={[0.6, 3.5, 18, 32, 1, true]} />
      <meshBasicMaterial
        color="#fde68a"
        transparent
        opacity={0.4}
        side={THREE.DoubleSide}
        toneMapped={false}
      />
    </mesh>
  );
}

function AgreementLines({ agents }: { agents: AgentStats[] }) {
  // Draw faint filaments between the top-5 champions to imply consensus.
  const top = agents.slice(0, 5);
  const points: Array<{ from: THREE.Vector3; to: THREE.Vector3; key: string }> = [];
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const a = arenaPosition(i, agents.length);
      const b = arenaPosition(j, agents.length);
      points.push({ from: a, to: b, key: `${i}-${j}` });
    }
  }
  return (
    <group>
      {points.map((p) => (
        <Line
          key={p.key}
          points={[p.from.toArray(), p.to.toArray()]}
          color="#38bdf8"
          lineWidth={0.8}
          transparent
          opacity={0.18}
        />
      ))}
    </group>
  );
}

function FloorGrid() {
  // A subtle grid floor — emphasises the sense of place.
  return (
    <group position={[0, -7, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <gridHelper args={[80, 40, "#0ea5e9", "#1b222d"]} />
      <mesh>
        <circleGeometry args={[32, 64]} />
        <meshBasicMaterial color="#050811" transparent opacity={0.7} />
      </mesh>
    </group>
  );
}

function StarField() {
  const ref = useRef<THREE.Points>(null!);
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const n = 800;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 60 + Math.random() * 60;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi) - 10;
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
  }, []);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    ref.current.rotation.y = clock.elapsedTime * 0.015;
  });
  return (
    <points ref={ref} geometry={geom}>
      <pointsMaterial color="#64748b" size={0.25} sizeAttenuation transparent opacity={0.75} />
    </points>
  );
}

function Rig() {
  useFrame(({ camera, clock }) => {
    const t = clock.elapsedTime * 0.12;
    const r = 42;
    camera.position.x = Math.cos(t) * r;
    camera.position.z = Math.sin(t) * r;
    camera.position.y = 12 + Math.sin(t * 0.6) * 2;
    camera.lookAt(0, 4, 0);
  });
  return null;
}

export function Arena({ agents }: { agents: AgentStats[] }) {
  const ranked = agents;
  const maxAbsR = Math.max(
    1,
    ...ranked.map((a) => Math.abs(a.total_r)),
  );
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [40, 14, 0], fov: 50 }}
      gl={{ antialias: true, alpha: true }}
    >
      <color attach="background" args={["#050811"]} />
      <fog attach="fog" args={["#050811", 55, 160]} />
      <Suspense fallback={null}>
        <ambientLight intensity={0.32} />
        <pointLight position={[20, 30, 20]} intensity={55} color="#5ec7ff" />
        <pointLight position={[-25, 12, -25]} intensity={36} color="#34d399" />
        <pointLight position={[0, 20, 0]} intensity={22} color="#fde68a" />
        <StarField />
        <FloorGrid />
        <AgreementLines agents={ranked} />
        <ChampionBeam enabled={ranked.length > 0} />
        {ranked.map((a, i) => (
          <AgentOrb
            key={a.agent_id}
            agent={a}
            rank={i}
            total={ranked.length}
            maxAbsR={maxAbsR}
            isChampion={i === 0}
          />
        ))}
        <Rig />
        <OrbitControls
          enablePan={false}
          enableDamping
          dampingFactor={0.07}
          rotateSpeed={0.4}
          maxDistance={85}
          minDistance={25}
        />
        <EffectComposer>
          <Bloom
            intensity={1.1}
            luminanceThreshold={0.08}
            luminanceSmoothing={0.3}
            mipmapBlur
          />
          <Vignette eskil={false} offset={0.25} darkness={0.85} />
        </EffectComposer>
      </Suspense>
    </Canvas>
  );
}
