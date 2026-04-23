"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { Suspense, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { EquityPoint, TradePoint } from "@/lib/vis-data";
import { AmbientField } from "./AmbientField";
import { EquityRibbon } from "./EquityRibbon";
import { TradeParticles } from "./TradeParticles";

function CameraRig({ paused }: { paused: boolean }) {
  const anchor = useRef<THREE.Group>(null!);
  useFrame(({ camera, clock }) => {
    if (paused) return;
    const t = clock.elapsedTime * 0.12;
    const r = 58;
    camera.position.x = Math.cos(t) * r;
    camera.position.z = Math.sin(t) * r;
    camera.position.y = 14 + Math.sin(t * 0.6) * 3;
    camera.lookAt(0, 8, 0);
  });
  return <group ref={anchor} />;
}

/** Animates the ribbon's draw progress from 0 → 1 over 4 s. */
function useDrawProgress(duration = 4.0) {
  const [p, setP] = useState(0);
  useEffect(() => {
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const elapsed = (performance.now() - start) / 1000;
      const t = Math.min(1, elapsed / duration);
      // Ease out cubic.
      setP(1 - Math.pow(1 - t, 3));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [duration]);
  return p;
}

export function HeroCanvas({
  equity,
  trades,
  paused = false,
}: {
  equity: EquityPoint[];
  trades: TradePoint[];
  paused?: boolean;
}) {
  const progress = useDrawProgress(5);
  return (
    <div className="absolute inset-0">
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [60, 18, 0], fov: 50 }}
        gl={{ antialias: true, alpha: true }}
      >
        <color attach="background" args={["#050811"]} />
        <fog attach="fog" args={["#050811", 80, 260]} />
        <Suspense fallback={null}>
          <ambientLight intensity={0.35} />
          <pointLight position={[20, 30, 20]} intensity={60} color="#5ec7ff" />
          <pointLight position={[-20, 10, -20]} intensity={40} color="#34d399" />
          <AmbientField />
          <EquityRibbon equity={equity} drawProgress={progress} />
          <TradeParticles equity={equity} trades={trades} drawProgress={progress} />
          <CameraRig paused={paused} />
          <OrbitControls
            enablePan={false}
            enableDamping
            dampingFactor={0.06}
            rotateSpeed={0.4}
            maxDistance={140}
            minDistance={30}
          />
          <EffectComposer>
            <Bloom
              intensity={0.9}
              luminanceThreshold={0.1}
              luminanceSmoothing={0.35}
              mipmapBlur
            />
          </EffectComposer>
        </Suspense>
      </Canvas>
    </div>
  );
}
