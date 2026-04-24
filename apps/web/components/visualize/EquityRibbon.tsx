"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { EquityPoint } from "@/lib/vis-data";

interface Props {
  equity: EquityPoint[];
  width?: number;
  yScale?: number;
  drawProgress?: number; // 0..1, animated externally
}

/**
 * The $1k → $64k equity curve rendered as a glowing ribbon in 3D space.
 *
 * Mapping:
 *   X = normalised time (start → end) ↦ [-40, +40]
 *   Y = log-scaled equity              ↦ [0, +20]
 *   Z = 0 (pure 2D trace in 3D scene)
 *
 * Colour gradient: cold blue at start, hot green at the end. A dashed
 * "baseline" at Y=0 anchors the viewer.
 */
export function EquityRibbon({ equity, width = 80, yScale = 20, drawProgress = 1.0 }: Props) {
  const tubeRef = useRef<THREE.Mesh>(null!);

  const { curve, tubeGeom } = useMemo(() => {
    if (equity.length < 2) {
      return { curve: null, tubeGeom: null };
    }
    const tMin = equity[0].ts;
    const tMax = equity[equity.length - 1].ts;
    const eMin = Math.log10(Math.max(1, equity[0].equity));
    const eMax = Math.log10(Math.max(1, equity[equity.length - 1].equity));
    const pts = equity.map((p) => {
      const x = ((p.ts - tMin) / (tMax - tMin)) * width - width / 2;
      const y = ((Math.log10(Math.max(1, p.equity)) - eMin) / (eMax - eMin)) * yScale;
      return new THREE.Vector3(x, y, 0);
    });
    const curve = new THREE.CatmullRomCurve3(pts);
    const tubeGeom = new THREE.TubeGeometry(curve, 400, 0.15, 16, false);
    return { curve, tubeGeom };
  }, [equity, width, yScale]);

  useFrame(({ clock }) => {
    if (!tubeRef.current) return;
    const material = tubeRef.current.material as THREE.ShaderMaterial;
    if (material.uniforms) {
      material.uniforms.uTime.value = clock.elapsedTime;
      material.uniforms.uProgress.value = drawProgress;
    }
  });

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uProgress: { value: drawProgress },
      },
      vertexShader: /* glsl */ `
        varying float vU;
        varying vec3 vPos;
        void main() {
          // uv.x runs along the tube; stash it for the fragment shader.
          vU = uv.x;
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uProgress;
        varying float vU;
        varying vec3 vPos;

        void main() {
          // Mask past the draw progress → invisible.
          if (vU > uProgress) discard;

          // Cold-to-hot gradient along the curve.
          vec3 cold = vec3(0.2, 0.6, 1.0);      // cyan
          vec3 warm = vec3(0.4, 1.0, 0.6);      // mint green
          vec3 hot  = vec3(1.0, 0.85, 0.3);     // gold
          vec3 col = mix(cold, warm, smoothstep(0.0, 0.7, vU));
          col = mix(col, hot, smoothstep(0.7, 1.0, vU));

          // Pulse travelling forward.
          float pulse = sin((vU - uTime * 0.15) * 25.0);
          col += 0.15 * pulse * vec3(1.0, 0.9, 0.5);

          // Soft edge near the travelling tip.
          float tipGlow = exp(-abs(vU - uProgress) * 40.0) * 2.0;
          col += tipGlow * vec3(1.0, 1.0, 0.8);

          gl_FragColor = vec4(col, 1.0);
        }
      `,
      transparent: false,
    });
  }, [drawProgress]);

  if (!curve || !tubeGeom) return null;

  return (
    <group>
      {/* Baseline grid at Y=0 for scale anchoring */}
      <gridHelper
        args={[width * 1.1, 20, "#1b2430", "#0e1720"]}
        position={[0, -0.01, 0]}
      />
      <mesh ref={tubeRef} geometry={tubeGeom} material={material} />
    </group>
  );
}
