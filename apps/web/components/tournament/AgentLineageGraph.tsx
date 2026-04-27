"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import {
  agentFamily,
  FAMILY_COLORS,
  FAMILY_LABEL,
  type AgentStats,
} from "@/lib/swarm";

// ───────────────────────────────────────────────────────────────────
// Galaxy field — Three.js spiral disc inspired by Bruno Simon's
// galaxy lesson. Particles spawn on N branches with a power-law
// radial jitter and the vertex shader winds them into spirals via
// differential rotation (`uTime / sqrt(distance)`). Champion lives
// as a glowing sun at the centre; the other agents sit as planets
// along the outer arms and orbit at the matching shader rotation.
//
// Production differences from the design prototype:
//   - Family-color palette is the Hail Mary set in lib/swarm.ts
//     (astrophage teal, Tau Ceti amber, Petrova magenta, etc.)
//   - Particle count scales with viewport so phones don't melt.
//   - Pulse trigger comes from the parent (pulseKey) — no internal
//     auto-event timer, since production events arrive from the
//     AutoPilot poller / EventSimulator already.
//   - HTML overlay handles the agent details panel and the family
//     legend, layered over the WebGL canvas.
//
// Gestures:
//   - Drag empty space        → orbit yaw / pitch
//   - Shift-drag (or right)   → pan
//   - Scroll wheel            → zoom
//   - Tap a satellite         → pin its details panel
//   - Tap empty space         → clear selection

type Props = {
  agents: AgentStats[];
  championId?: string | null;
  generation?: number;
  /** Increments on every event the parent fires; the galaxy uses
   *  the change to pulse the matching specialist agent (or a
   *  random one if no specialist is provided). */
  pulseKey?: number;
  /** Optional agent ID of the most recent event's specialist —
   *  used to pick which planet to pulse on a pulseKey bump. */
  pulseAgentId?: string | null;
};

const GALAXY_RADIUS = 4.1;
const BRANCHES = 5;
const SPIN = 1.1;
const RANDOMNESS = 0.22;
const RANDOMNESS_POWER = 3.0;
const INSIDE_COLOR = new THREE.Color("#ed7b4d"); // warm core
const OUTSIDE_COLOR = new THREE.Color("#4657de"); // purple rim

const VERT = /* glsl */ `
uniform float uTime;
uniform float uSize;
attribute float aScale;
attribute vec3 aColor;
varying vec3 vColor;
void main() {
  vec4 modelPosition = modelMatrix * vec4(position, 1.0);
  float distanceToCenter = length(modelPosition.xz);
  float angle = atan(modelPosition.x, modelPosition.z);
  float angleOffset = (1.0 / max(distanceToCenter, 0.1)) * uTime * 0.05;
  angle += angleOffset;
  modelPosition.x = cos(angle) * distanceToCenter;
  modelPosition.z = sin(angle) * distanceToCenter;
  vec4 viewPosition = viewMatrix * modelPosition;
  vec4 projectedPosition = projectionMatrix * viewPosition;
  gl_Position = projectedPosition;
  gl_PointSize = uSize * aScale;
  gl_PointSize *= (1.0 / -viewPosition.z);
  vColor = aColor;
}
`;

const FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  float d = distance(gl_PointCoord, vec2(0.5));
  float strength = 1.0 - smoothstep(0.0, 0.5, d);
  gl_FragColor = vec4(vColor * strength, strength);
}
`;

function omegaAt(r: number): number {
  return 0.05 / Math.max(0.1, r);
}

function familyColorOrFallback(agentId: string): THREE.Color {
  const fam = agentFamily(agentId);
  const hex = (FAMILY_COLORS as Record<string, string>)[fam] ?? "#94a3b8";
  return new THREE.Color(hex);
}

function softSprite(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  if (ctx) {
    const grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.3, "rgba(255,255,255,0.7)");
    grd.addColorStop(0.6, "rgba(255,255,255,0.18)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 64, 64);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Particle count scales with viewport — phones get a thinner cloud
// so the canvas hits 60 fps without melting battery, desktops get
// the full Bruno-Simon-density experience.
function particleCountFor(width: number): number {
  if (width < 640) return 25_000;
  if (width < 1024) return 50_000;
  return 80_000;
}

type AgentRecord = {
  id: string;
  family: ReturnType<typeof agentFamily>;
  agent: AgentStats;
  isChampion: boolean;
  r: number;
  theta: number;
  group: THREE.Group;
  planet: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  halo: THREE.Sprite;
  haloMat: THREE.SpriteMaterial;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  ringMat: THREE.MeshBasicMaterial;
  baseColor: THREE.Color;
  activity: number;
};

export function AgentLineageGraph({
  agents,
  championId = null,
  generation = 0,
  pulseKey = 0,
  pulseAgentId = null,
}: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  // React-side state for the HTML overlay.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Frozen agents — we only sync the latest snapshot when the user
  // isn't actively studying a selection. Otherwise the snapshot
  // refresh would yank planets out from under the cursor.
  const [frozenAgents, setFrozenAgents] = useState(agents);

  // Stash the latest props on a ref so the long-lived rAF loop reads
  // them without us having to tear down the scene on every prop change.
  type SceneState = {
    updateAgents: (a: AgentStats[], champion: string | null) => void;
    pulse: (agentId: string | null) => void;
    resetView: () => void;
    pickAgentAt: (clientX: number, clientY: number) => string | null;
  };
  const sceneRef = useRef<SceneState | null>(null);
  // Latest selection state, mirrored to a ref so the animate loop
  // can read without re-mounting the scene.
  const selectedRef = useRef<string | null>(null);
  const hoveredRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);
  useEffect(() => {
    hoveredRef.current = hoveredId;
  }, [hoveredId]);

  // Sync frozen agents when the user isn't interacting.
  useEffect(() => {
    if (selectedId === null) {
      setFrozenAgents(agents);
    }
  }, [agents, selectedId]);

  // On tab return, catch up to whatever's freshest (the snapshot
  // probably refreshed while the user was away).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (!document.hidden && selectedId === null) {
        setFrozenAgents(agents);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () =>
      document.removeEventListener("visibilitychange", onVisibility);
  }, [agents, selectedId]);

  // ── Scene mount (one-shot)
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const W = mount.clientWidth;
    const H = mount.clientHeight;
    const PARTICLE_COUNT = particleCountFor(W);

    const scene = new THREE.Scene();
    scene.background = null; // transparent over the panel

    const camera = new THREE.PerspectiveCamera(45, W / H, 0.05, 200);
    const DEFAULT_VIEW = { yaw: 0.4, pitch: 0.7, dist: 7.0, panX: 0, panZ: 0 };

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(W, H);
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    // ── Particle field — branch-based spiral with a soft bulge in
    // the centre and tighter, defined arms toward the rim.
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const aColor = new Float32Array(PARTICLE_COUNT * 3);
    const aScale = new Float32Array(PARTICLE_COUNT);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const ix = i * 3;
      const rNorm = Math.pow(Math.random(), 2.4);
      const r = rNorm * GALAXY_RADIUS;
      const branchAngle = ((i % BRANCHES) / BRANCHES) * Math.PI * 2;
      const spinAngle = r * SPIN;
      const theta = branchAngle + spinAngle;

      // High randomness near the centre (soft bulge), low at the rim
      // (sharp lanes). Wider bulge: slow exp falloff.
      const coreBlend = Math.exp(-rNorm * 3.2);
      const armCrisp = 0.22;
      const rJ = RANDOMNESS * r * (armCrisp + 8 * coreBlend);
      const sgn = () => (Math.random() < 0.5 ? 1 : -1);
      const rx =
        Math.pow(Math.random(), RANDOMNESS_POWER) * sgn() * rJ;
      const ry =
        Math.pow(Math.random(), RANDOMNESS_POWER) * sgn() * rJ * 0.35;
      const rz =
        Math.pow(Math.random(), RANDOMNESS_POWER) * sgn() * rJ;

      positions[ix] = Math.cos(theta) * r + rx;
      positions[ix + 1] = ry;
      positions[ix + 2] = Math.sin(theta) * r + rz;

      const tColor = Math.min(1, r / GALAXY_RADIUS);
      const mixed = INSIDE_COLOR.clone().lerp(OUTSIDE_COLOR, tColor);
      const corePunch = Math.max(0, 1 - r / (GALAXY_RADIUS * 0.42));
      mixed.r = Math.min(1, mixed.r + corePunch * 0.55);
      mixed.g = Math.min(1, mixed.g + corePunch * 0.42);
      mixed.b = Math.min(1, mixed.b + corePunch * 0.28);
      const jitter = 0.85 + Math.random() * 0.3;
      aColor[ix] = mixed.r * jitter;
      aColor[ix + 1] = mixed.g * jitter;
      aColor[ix + 2] = mixed.b * jitter;

      aScale[i] = 0.5 + Math.random() * 0.8;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setAttribute("aColor", new THREE.BufferAttribute(aColor, 3));
    geom.setAttribute("aScale", new THREE.BufferAttribute(aScale, 1));

    const uniforms: { uTime: { value: number }; uSize: { value: number } } = {
      uTime: { value: 0 },
      uSize: { value: 12 * renderer.getPixelRatio() },
    };
    const pMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geom, pMat);
    scene.add(points);

    const sprite = softSprite();

    // ── Champion sun at the galactic centre.
    const sunGroup = new THREE.Group();
    scene.add(sunGroup);
    const sunCore = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 32, 32),
      new THREE.MeshBasicMaterial({ color: 0xfff1c8 }),
    );
    sunGroup.add(sunCore);
    const sunGlowMat = new THREE.SpriteMaterial({
      map: sprite,
      color: new THREE.Color("#fbbf24"),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sunGlow = new THREE.Sprite(sunGlowMat);
    sunGlow.scale.set(2.4, 2.4, 1);
    sunGroup.add(sunGlow);
    const sunWashMat = new THREE.SpriteMaterial({
      map: sprite,
      color: new THREE.Color("#f59e0b"),
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sunWash = new THREE.Sprite(sunWashMat);
    sunWash.scale.set(5.2, 5.2, 1);
    sunGroup.add(sunWash);

    // ── Agent satellites — populated in updateAgents.
    const agentGroup = new THREE.Group();
    scene.add(agentGroup);
    let records: AgentRecord[] = [];

    function clearAgents() {
      for (const r of records) {
        agentGroup.remove(r.group);
        r.planet.geometry.dispose();
        r.planet.material.dispose();
        r.haloMat.dispose();
        r.ring.geometry.dispose();
        r.ringMat.dispose();
      }
      records = [];
    }

    function buildAgents(list: AgentStats[], champion: string | null) {
      clearAgents();
      // Sort by total_r so the strongest agents sit on the inner arms,
      // weakest on the rim — reads as a pecking order around the sun.
      const ranked = [...list]
        .filter((a) => a.agent_id !== champion)
        .sort((a, b) => b.total_r - a.total_r);
      const N = ranked.length;
      ranked.forEach((a, i) => {
        const fam = agentFamily(a.agent_id);
        const baseColor = familyColorOrFallback(a.agent_id);
        // Distribute across mid → outer arms, skip the very core.
        const rNorm = N <= 1 ? 0.6 : 0.32 + (i / (N - 1)) * 0.62;
        const r = rNorm * GALAXY_RADIUS;
        const branch = i % BRANCHES;
        const branchAngle = (branch / BRANCHES) * Math.PI * 2;
        const theta =
          branchAngle + r * SPIN + ((i * 73 + 11) % 19) * 0.01;

        const group = new THREE.Group();
        const planet = new THREE.Mesh(
          new THREE.SphereGeometry(0.07, 16, 16),
          new THREE.MeshBasicMaterial({ color: 0xffffff }),
        );
        group.add(planet);
        const haloMat = new THREE.SpriteMaterial({
          map: sprite,
          color: baseColor,
          transparent: true,
          opacity: 0.6,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        const halo = new THREE.Sprite(haloMat);
        halo.scale.set(0.4, 0.4, 1);
        group.add(halo);

        const ringMat = new THREE.MeshBasicMaterial({
          color: baseColor,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
        });
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.1, 0.12, 48),
          ringMat,
        );
        ring.rotation.x = -Math.PI / 2;
        group.add(ring);

        // userData for raycast hits
        group.userData.agentId = a.agent_id;
        planet.userData.agentId = a.agent_id;
        halo.userData.agentId = a.agent_id;

        agentGroup.add(group);

        records.push({
          id: a.agent_id,
          family: fam,
          agent: a,
          isChampion: false,
          r,
          theta,
          group,
          planet,
          halo,
          haloMat,
          ring,
          ringMat,
          baseColor,
          activity: 0,
        });
      });
    }

    // ── Camera controls (orbit + pan + wheel zoom)
    const ctl = { ...DEFAULT_VIEW };
    let dragging:
      | {
          id: number;
          mode: "orbit" | "pan";
          startX: number;
          startY: number;
          yaw0: number;
          pitch0: number;
          panX0: number;
          panZ0: number;
          moved: boolean;
        }
      | null = null;
    const dom = renderer.domElement;
    dom.style.touchAction = "none";
    dom.style.cursor = "grab";

    const onPointerDown = (e: PointerEvent) => {
      dom.setPointerCapture(e.pointerId);
      dom.style.cursor = "grabbing";
      const pan = e.button === 2 || e.shiftKey;
      dragging = {
        id: e.pointerId,
        mode: pan ? "pan" : "orbit",
        startX: e.clientX,
        startY: e.clientY,
        yaw0: ctl.yaw,
        pitch0: ctl.pitch,
        panX0: ctl.panX,
        panZ0: ctl.panZ,
        moved: false,
      };
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging || dragging.id !== e.pointerId) return;
      const dx = e.clientX - dragging.startX;
      const dy = e.clientY - dragging.startY;
      if (Math.abs(dx) + Math.abs(dy) > 6) dragging.moved = true;
      if (dragging.mode === "orbit") {
        ctl.yaw = dragging.yaw0 - dx * 0.005;
        ctl.pitch = Math.max(
          0.05,
          Math.min(Math.PI / 2 - 0.02, dragging.pitch0 + dy * 0.005),
        );
      } else {
        const cosY = Math.cos(ctl.yaw);
        const sinY = Math.sin(ctl.yaw);
        ctl.panX =
          dragging.panX0 - dx * 0.012 * cosY - dy * 0.012 * sinY;
        ctl.panZ =
          dragging.panZ0 + dx * 0.012 * sinY - dy * 0.012 * cosY;
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!dragging || dragging.id !== e.pointerId) return;
      const wasDrag = dragging.moved;
      dragging = null;
      dom.style.cursor = "grab";
      // Tap (no drag) → attempt selection via raycast.
      if (!wasDrag) {
        const hit = pickAgentAt(e.clientX, e.clientY);
        if (hit) {
          setSelectedId((cur) => (cur === hit ? null : hit));
        } else {
          setSelectedId(null);
        }
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      ctl.dist = Math.max(
        2.5,
        Math.min(25, ctl.dist * (e.deltaY > 0 ? 1.1 : 1 / 1.1)),
      );
    };
    dom.addEventListener("pointerdown", onPointerDown);
    dom.addEventListener("pointermove", onPointerMove);
    dom.addEventListener("pointerup", onPointerUp);
    dom.addEventListener("pointercancel", onPointerUp);
    dom.addEventListener("contextmenu", (e) => e.preventDefault());
    dom.addEventListener("wheel", onWheel, { passive: false });

    // ── Raycaster for agent picking.
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 0.05 };
    const ndc = new THREE.Vector2();

    function pickAgentAt(clientX: number, clientY: number): string | null {
      const rect = dom.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      // Build a flat list of pickable meshes with userData.
      const candidates: THREE.Object3D[] = [];
      for (const r of records) {
        candidates.push(r.planet, r.halo);
      }
      const hits = raycaster.intersectObjects(candidates, false);
      for (const h of hits) {
        const id = h.object.userData?.agentId;
        if (typeof id === "string") return id;
      }
      return null;
    }

    // ── Hover detection (mouse only — touch uses tap).
    const onPointerHover = (e: PointerEvent) => {
      if (e.pointerType === "touch" || dragging) return;
      const id = pickAgentAt(e.clientX, e.clientY);
      hoveredRef.current = id;
      setHoveredId(id);
    };
    dom.addEventListener("pointermove", onPointerHover);
    const onPointerLeave = () => {
      hoveredRef.current = null;
      setHoveredId(null);
    };
    dom.addEventListener("pointerleave", onPointerLeave);

    // ── Resize observer.
    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h);
      uniforms.uSize.value = 12 * renderer.getPixelRatio();
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    // ── Animation loop.
    let raf = 0;
    const start = performance.now();

    const animate = () => {
      raf = requestAnimationFrame(animate);
      const now = performance.now();
      const t = (now - start) / 1000;
      uniforms.uTime.value = t;

      // Camera position on a sphere around (panX, 0, panZ).
      const tx = ctl.panX;
      const tz = ctl.panZ;
      const r = ctl.dist;
      camera.position.set(
        tx + Math.cos(ctl.pitch) * Math.sin(ctl.yaw) * r,
        Math.sin(ctl.pitch) * r,
        tz + Math.cos(ctl.pitch) * Math.cos(ctl.yaw) * r,
      );
      camera.lookAt(tx, 0, tz);
      if (!dragging) ctl.yaw += 0.0005;

      // Sun breathe.
      const sunPulse = 1 + 0.06 * Math.sin(t * 1.1);
      sunCore.scale.setScalar(sunPulse);
      sunGlow.scale.set(2.4 * sunPulse, 2.4 * sunPulse, 1);
      sunWash.scale.set(5.2 * sunPulse, 5.2 * sunPulse, 1);
      sunGlowMat.opacity = 0.85 + 0.1 * Math.sin(t * 1.1);

      // Decay activity and reposition each satellite along its arm.
      for (const rec of records) {
        rec.activity *= 0.93;
        const ang = rec.theta + t * omegaAt(rec.r);
        rec.group.position.set(
          Math.cos(ang) * rec.r,
          0,
          Math.sin(ang) * rec.r,
        );
        const breathe = 1 + 0.07 * Math.sin(t * 1.5 + rec.theta);
        const isSelected = selectedRef.current === rec.id;
        const isHovered = hoveredRef.current === rec.id;
        const focusBoost = isSelected ? 1.5 : isHovered ? 1.2 : 1;
        const act = rec.activity;
        rec.planet.scale.setScalar((1 + act * 1.6) * breathe * focusBoost);
        const baseHalo = 0.4;
        const haloS = baseHalo + act * 0.9 + (isSelected ? 0.25 : 0);
        rec.halo.scale.set(haloS, haloS, 1);
        rec.haloMat.opacity =
          0.55 + act * 0.45 + (isSelected ? 0.25 : isHovered ? 0.1 : 0);
        rec.ringMat.opacity = act * 0.85 + (isSelected ? 0.35 : 0);
        rec.ring.scale.setScalar(1 + act * 5 + (isSelected ? 1.6 : 0));
      }

      renderer.render(scene, camera);
    };
    animate();

    // ── Expose imperative handles via ref.
    sceneRef.current = {
      updateAgents: (list, champion) => buildAgents(list, champion),
      pulse: (agentId) => {
        if (records.length === 0) return;
        let target: AgentRecord | undefined;
        if (agentId) target = records.find((r) => r.id === agentId);
        if (!target)
          target = records[Math.floor(Math.random() * records.length)];
        target.activity = Math.max(target.activity, 1);
      },
      resetView: () => Object.assign(ctl, DEFAULT_VIEW),
      pickAgentAt,
    };

    // Initial agent build.
    buildAgents(frozenAgents, championId);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      dom.removeEventListener("pointerdown", onPointerDown);
      dom.removeEventListener("pointermove", onPointerMove);
      dom.removeEventListener("pointerup", onPointerUp);
      dom.removeEventListener("pointercancel", onPointerUp);
      dom.removeEventListener("pointermove", onPointerHover);
      dom.removeEventListener("pointerleave", onPointerLeave);
      dom.removeEventListener("wheel", onWheel);
      clearAgents();
      sprite.dispose();
      geom.dispose();
      pMat.dispose();
      sunCore.geometry.dispose();
      (sunCore.material as THREE.Material).dispose();
      sunGlowMat.dispose();
      sunWashMat.dispose();
      renderer.dispose();
      if (dom.parentNode === mount) mount.removeChild(dom);
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Re-bind agent meshes when the agent list or champion changes.
  useEffect(() => {
    sceneRef.current?.updateAgents(frozenAgents, championId);
  }, [frozenAgents, championId]);

  // ── Pulse on parent's pulseKey bump.
  const lastPulseKey = useRef(pulseKey);
  useEffect(() => {
    if (pulseKey !== lastPulseKey.current && pulseKey > 0) {
      lastPulseKey.current = pulseKey;
      sceneRef.current?.pulse(pulseAgentId ?? null);
    }
  }, [pulseKey, pulseAgentId]);

  // ── Selection + hover overlay derivations.
  const selected = useMemo(
    () => frozenAgents.find((a) => a.agent_id === selectedId) ?? null,
    [frozenAgents, selectedId],
  );
  const hovered = useMemo(
    () => frozenAgents.find((a) => a.agent_id === hoveredId) ?? null,
    [frozenAgents, hoveredId],
  );

  const championAgent = useMemo(
    () => frozenAgents.find((a) => a.agent_id === championId) ?? null,
    [frozenAgents, championId],
  );

  return (
    <section className="panel p-4 sm:p-5 relative">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div className="text-xs uppercase tracking-[0.3em] text-amber/80">
          Pythian galaxy · swarm field
        </div>
        <div className="text-[0.65rem] text-mist num">
          gen {generation} · {frozenAgents.length} agents
        </div>
      </div>
      <p className="text-[0.65rem] text-mist mb-3 max-w-2xl leading-relaxed">
        Drag to orbit · scroll to zoom · shift-drag (or right-drag) to pan.
        Champion is the sun at the core; satellites sit on the spiral
        arms in rank order, brightest closest in. Tap a satellite for
        its record.
      </p>
      <div className="relative">
        <div
          ref={mountRef}
          className="w-full aspect-[16/10] rounded-sm bg-black border border-edge/40 select-none touch-none overflow-hidden"
          aria-label="Pythian galaxy — agent satellites"
        />

        {/* Reset view button. */}
        <div className="absolute top-2 left-2 flex flex-col gap-1.5 z-10">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              sceneRef.current?.resetView();
            }}
            className="w-9 h-9 rounded-sm bg-black/85 hover:bg-black border border-edge/60 hover:border-cyan/40 text-mist hover:text-slate-100 text-sm leading-none flex items-center justify-center"
            aria-label="Reset view"
            title="Reset"
          >
            ⟲
          </button>
        </div>

        {/* Champion callout — always pinned top-right when one exists. */}
        {championAgent ? (
          <div className="hidden sm:flex absolute top-3 right-3 z-10 items-center gap-2 px-3 py-1.5 rounded-sm bg-black/85 border border-amber/60 backdrop-blur-sm pointer-events-none">
            <span className="text-[0.6rem] tracking-[0.3em] text-amber uppercase">
              👑 Champion
            </span>
            <span className="font-mono text-[0.7rem] text-slate-100">
              {championAgent.agent_id.replace(/^gen\d+-mut\d+-/, "")}
            </span>
            <span className="num text-[0.65rem] text-green">
              {championAgent.total_r >= 0 ? "+" : ""}
              {championAgent.total_r.toFixed(0)}R
            </span>
          </div>
        ) : null}

        {/* Selection panel — full-width bottom on mobile, top-right on
            desktop. Hover preview only fires on desktop pointer (touch
            taps go straight to selected). */}
        <div ref={overlayRef} />
        {selected ? (
          <div
            className="absolute left-2 right-2 bottom-2 sm:left-auto sm:right-3 sm:top-14 sm:bottom-auto sm:max-w-[300px] panel p-3 bg-black/95 backdrop-blur-sm text-[0.7rem] num shadow-2xl ring-1 ring-cyan/30 z-20"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2 mb-1">
              <div className="font-mono text-slate-100 break-all text-[0.7rem]">
                {selected.agent_id === championId ? "👑 " : ""}
                {selected.agent_id.replace(/^gen\d+-mut\d+-/, "")}
              </div>
              <button
                onClick={() => setSelectedId(null)}
                className="text-mist hover:text-slate-100 text-base leading-none px-1 shrink-0"
                aria-label="Close details"
              >
                ×
              </button>
            </div>
            <div
              className="text-[0.6rem] text-mist mb-2"
              title={FAMILY_LABEL[agentFamily(selected.agent_id)]}
            >
              family: {agentFamily(selected.agent_id)}
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <span>
                <span className="text-mist">Σ R</span>{" "}
                <span
                  className={selected.total_r >= 0 ? "text-green" : "text-red"}
                >
                  {selected.total_r >= 0 ? "+" : ""}
                  {selected.total_r.toFixed(2)}
                </span>
              </span>
              <span>
                <span className="text-mist">WR</span>{" "}
                {(selected.win_rate * 100).toFixed(1)}%
              </span>
              <span>
                <span className="text-mist">trades</span>{" "}
                {selected.wins + selected.losses}
              </span>
              <span>
                <span className="text-mist">Sharpe</span>{" "}
                {selected.rolling_sharpe.toFixed(2)}
              </span>
              <span className="col-span-2">
                <span className="text-mist">last R</span>{" "}
                <span
                  className={selected.last_r >= 0 ? "text-green" : "text-red"}
                >
                  {selected.last_r >= 0 ? "+" : ""}
                  {selected.last_r.toFixed(2)}
                </span>
              </span>
              {selected.expectancy_r != null ? (
                <span className="col-span-2">
                  <span className="text-mist">E[R]</span>{" "}
                  <span
                    className={
                      selected.expectancy_r >= 0 ? "text-green" : "text-red"
                    }
                  >
                    {selected.expectancy_r >= 0 ? "+" : ""}
                    {selected.expectancy_r.toFixed(3)}
                  </span>
                </span>
              ) : null}
            </div>
          </div>
        ) : hovered ? (
          <div className="hidden sm:block absolute top-14 right-3 panel p-2.5 bg-black/90 backdrop-blur-sm max-w-[260px] text-[0.65rem] num pointer-events-none ring-1 ring-edge/40 z-10">
            <div className="font-mono text-slate-100 break-all text-[0.7rem]">
              {hovered.agent_id === championId ? "👑 " : ""}
              {hovered.agent_id.replace(/^gen\d+-mut\d+-/, "")}
            </div>
            <div className="text-[0.55rem] text-mist mt-0.5 mb-1.5">
              {agentFamily(hovered.agent_id)} · tap to pin
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
              <span>
                <span className="text-mist">Σ R</span>{" "}
                <span
                  className={hovered.total_r >= 0 ? "text-green" : "text-red"}
                >
                  {hovered.total_r >= 0 ? "+" : ""}
                  {hovered.total_r.toFixed(2)}
                </span>
              </span>
              <span>
                <span className="text-mist">WR</span>{" "}
                {(hovered.win_rate * 100).toFixed(1)}%
              </span>
              <span>
                <span className="text-mist">trades</span>{" "}
                {hovered.wins + hovered.losses}
              </span>
              <span>
                <span className="text-mist">Sharpe</span>{" "}
                {hovered.rolling_sharpe.toFixed(2)}
              </span>
            </div>
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
