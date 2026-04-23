"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { EquityPoint, TradePoint } from "@/lib/vis-data";

interface Props {
  trades: TradePoint[];
  equity: EquityPoint[];
  width?: number;
  yScale?: number;
  drawProgress?: number;
}

/**
 * One small glowing sphere per trade, positioned on the equity curve.
 * Green = winning trade, red = losing trade. Size scales with |pnl|.
 * InstancedMesh so 578 trades render in one draw call.
 */
export function TradeParticles({
  trades,
  equity,
  width = 80,
  yScale = 20,
  drawProgress = 1.0,
}: Props) {
  const ref = useRef<THREE.InstancedMesh>(null!);
  const mat4 = useMemo(() => new THREE.Matrix4(), []);
  const col = useMemo(() => new THREE.Color(), []);

  const { positions, colors, sizes } = useMemo(() => {
    if (!equity.length) return { positions: [], colors: [], sizes: [] };
    const tMin = equity[0].ts;
    const tMax = equity[equity.length - 1].ts;
    const eMin = Math.log10(Math.max(1, equity[0].equity));
    const eMax = Math.log10(Math.max(1, equity[equity.length - 1].equity));
    // Build a ts→equity lookup for snap-to-curve placement.
    const lut = new Map<number, number>();
    for (const p of equity) lut.set(p.ts, p.equity);

    const pos: [number, number, number][] = [];
    const cols: [number, number, number][] = [];
    const sz: number[] = [];
    const maxAbsPnl = Math.max(...trades.map((t) => Math.abs(t.pnl))) || 1;
    for (const t of trades) {
      // Find nearest equity point for the y.
      let nearestEq = lut.get(t.ts);
      if (nearestEq == null) {
        let best = equity[0];
        let bestD = Infinity;
        for (const p of equity) {
          const d = Math.abs(p.ts - t.ts);
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
        nearestEq = best.equity;
      }
      const x = ((t.ts - tMin) / (tMax - tMin)) * width - width / 2;
      const y =
        ((Math.log10(Math.max(1, nearestEq)) - eMin) / (eMax - eMin)) * yScale;
      pos.push([x, y + 0.25, 0]);
      const win = t.pnl > 0;
      // Winners: mint green. Losers: rose red.
      cols.push(win ? [0.4, 1.0, 0.5] : [1.0, 0.35, 0.45]);
      const s = 0.08 + 0.35 * (Math.abs(t.pnl) / maxAbsPnl);
      sz.push(s);
    }
    return { positions: pos, colors: cols, sizes: sz };
  }, [trades, equity, width, yScale]);

  const count = positions.length;

  useFrame(({ clock }) => {
    if (!ref.current || !count) return;
    const t = clock.elapsedTime;
    const tMin = equity[0].ts;
    const tMax = equity[equity.length - 1].ts;
    for (let i = 0; i < count; i++) {
      const [x, y, z] = positions[i];
      const [r, g, b] = colors[i];
      const baseSize = sizes[i];

      // Progressive reveal as the ribbon draws.
      const normX = (x + 40) / 80; // in [0,1]
      const revealed = normX <= drawProgress;
      const scale = revealed ? baseSize * (1 + 0.15 * Math.sin(t * 3 + i * 0.5)) : 0;

      mat4.makeScale(scale, scale, scale);
      mat4.setPosition(x, y, z);
      ref.current.setMatrixAt(i, mat4);
      col.setRGB(r, g, b);
      ref.current.setColorAt(i, col);
    }
    ref.current.instanceMatrix.needsUpdate = true;
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
  });

  if (!count) return null;

  return (
    <instancedMesh ref={ref} args={[undefined as unknown as THREE.BufferGeometry, undefined, count]}>
      <sphereGeometry args={[1, 12, 12]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}
