"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { Suspense, useMemo, useRef } from "react";
import * as THREE from "three";
import type { GridRow } from "@/lib/vis-data";

/**
 * 3D scatter: the full 30-variant grid. Axes:
 *   X = risk %  (0..6)
 *   Y = log ROI %
 *   Z = MaxDD % (0..30)
 *
 * Realistic variants glow green; unrealistic (theoretical 3 %+ compound
 * rows) are dimmer amber. Winner pulses.
 */
export function GridScatter({ grid }: { grid: GridRow[] }) {
  return (
    <div className="relative h-[560px] w-full rounded-2xl overflow-hidden border border-edge">
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [8, 6, 12], fov: 45 }}
        gl={{ antialias: true, alpha: true }}
      >
        <color attach="background" args={["#080c14"]} />
        <Suspense fallback={null}>
          <ambientLight intensity={0.4} />
          <pointLight position={[8, 10, 8]} intensity={50} color="#22d3ee" />
          <Axes />
          <Points grid={grid} />
          <OrbitControls enableDamping dampingFactor={0.08} maxDistance={25} />
          <EffectComposer>
            <Bloom
              intensity={0.6}
              luminanceThreshold={0.15}
              luminanceSmoothing={0.4}
              mipmapBlur
            />
          </EffectComposer>
        </Suspense>
      </Canvas>
      <div className="absolute top-3 left-3 text-[10px] uppercase tracking-widest text-mist space-y-1">
        <div>X · risk % per trade</div>
        <div>Y · log ROI %</div>
        <div>Z · max drawdown %</div>
      </div>
      <div className="absolute bottom-3 right-3 text-[10px] text-mist">
        drag to orbit · scroll to zoom · {grid.length} strategies plotted
      </div>
    </div>
  );
}

function Axes() {
  return (
    <group>
      {/* X, Y, Z axis gridlines */}
      <gridHelper args={[10, 10, "#1b2430", "#0e1720"]} position={[0, 0, 0]} />
      <mesh position={[5, 0, 0]}>
        <boxGeometry args={[10, 0.02, 0.02]} />
        <meshBasicMaterial color="#1e2a3a" />
      </mesh>
      <mesh position={[0, 5, 0]}>
        <boxGeometry args={[0.02, 10, 0.02]} />
        <meshBasicMaterial color="#1e2a3a" />
      </mesh>
      <mesh position={[0, 0, 5]}>
        <boxGeometry args={[0.02, 0.02, 10]} />
        <meshBasicMaterial color="#1e2a3a" />
      </mesh>
    </group>
  );
}

function Points({ grid }: { grid: GridRow[] }) {
  const ref = useRef<THREE.InstancedMesh>(null!);
  const m4 = useMemo(() => new THREE.Matrix4(), []);
  const col = useMemo(() => new THREE.Color(), []);

  const mapped = useMemo(() => {
    // Map: risk 0..6 → x 0..10; log-roi → y 0..10; maxdd 0..30 → z 0..10
    return grid.map((g) => {
      const x = (g.risk * 100) / 6 * 10;
      // Log-safe Y (some grids have huge ROI from 5% compound)
      const y = Math.max(0, Math.log10(Math.max(1, g.roi))) * 2;
      const z = Math.min(1, g.max_dd / 0.3) * 10;
      // winner highlight: the realistic 1%-compound liq-trend row
      const isWinner =
        g.realistic && g.compound && g.risk === 0.01 && g.name.startsWith("liq-trend");
      return { x, y, z, row: g, isWinner };
    });
  }, [grid]);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.elapsedTime;
    for (let i = 0; i < mapped.length; i++) {
      const { x, y, z, row, isWinner } = mapped[i];
      const scale = (row.realistic ? 0.3 : 0.2) * (isWinner ? 1.4 + 0.2 * Math.sin(t * 2) : 1);
      m4.makeScale(scale, scale, scale);
      m4.setPosition(x - 5, y, z - 5);
      ref.current.setMatrixAt(i, m4);
      if (isWinner) {
        col.setRGB(1.0, 0.85, 0.3);
      } else if (row.realistic) {
        col.setRGB(0.4, 1.0, 0.6);
      } else if (row.roi > 0) {
        col.setRGB(0.6, 0.5, 1.0);
      } else {
        col.setRGB(1.0, 0.4, 0.5);
      }
      ref.current.setColorAt(i, col);
    }
    ref.current.instanceMatrix.needsUpdate = true;
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={ref} args={[undefined as unknown as THREE.BufferGeometry, undefined, mapped.length]}>
      <sphereGeometry args={[1, 14, 14]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}
