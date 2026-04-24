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
import { Suspense, useMemo, useRef } from "react";
import * as THREE from "three";
import { agentFamily, FAMILY_COLORS, type AgentStats } from "@/lib/swarm";

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
  maxAbsR,
}: {
  agent: AgentStats;
  rank: number;
  maxAbsR: number;
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

  useFrame(({ clock }) => {
    if (!group.current) return;
    const t = clock.elapsedTime + phase;
    // Smoothly ease toward target on rerank.
    const p = group.current.position;
    p.x += (target.x - p.x) * 0.05;
    p.y += (target.y + Math.sin(t * 0.8) * 0.18 - p.y) * 0.05;
    p.z += (target.z - p.z) * 0.05;
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

function ChampionPedestal({ champion }: { champion: AgentStats | null }) {
  const coreRef = useRef<THREE.Mesh>(null!);
  const haloRef = useRef<THREE.Mesh>(null!);
  const beamRef = useRef<THREE.Mesh>(null!);

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
  });

  if (!champion) return null;

  const family = agentFamily(champion.agent_id);
  const color = FAMILY_COLORS[family] ?? "#fde68a";
  const positive = champion.total_r >= 0;

  return (
    <group position={[0, 0, 8]}>
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
  // Obsidian disc + radial ridges.
  return (
    <group position={[0, -1.5, 3]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[50, 128]} />
        <meshStandardMaterial
          color="#05080d"
          emissive="#0b1a2a"
          emissiveIntensity={0.4}
          roughness={0.35}
          metalness={0.6}
        />
      </mesh>
      {/* Concentric faint rings. */}
      {[8, 14, 20, 28].map((r, i) => (
        <mesh key={r} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
          <ringGeometry args={[r - 0.03, r, 128]} />
          <meshBasicMaterial
            color="#0ea5e9"
            transparent
            opacity={0.18 - i * 0.035}
            toneMapped={false}
          />
        </mesh>
      ))}
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
  // Subtle back-wall signage for atmosphere + generation readout.
  return (
    <group position={[0, 4.5, -26]}>
      <Text
        fontSize={2.2}
        color="#0f172a"
        outlineColor="#1e293b"
        outlineWidth={0.04}
        anchorX="center"
        anchorY="middle"
        letterSpacing={0.45}
      >
        PYTHIA · TOURNAMENT
      </Text>
      <Text
        position={[0, -1.5, 0]}
        fontSize={0.45}
        color="#334155"
        anchorX="center"
        anchorY="middle"
        letterSpacing={0.6}
      >
        {`GENERATION ${generation.toString().padStart(3, "0")}`}
      </Text>
    </group>
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
        <Floor />
        <BackWall generation={generation} />
        <EliteLinks ranked={ranked} />
        <ChampionPedestal champion={champion} />
        {ranked.map((a, i) =>
          i === 0 ? null : (
            <AgentOrb key={a.agent_id} agent={a} rank={i} maxAbsR={maxAbsR} />
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
