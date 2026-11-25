import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Crosshair, Minus, Plus, RotateCcw } from "lucide-react";
import { AllyShipState, ShipTelemetry } from "../types";

export interface HologramCommand {
  id: number;
  action:
    | "open"
    | "close"
    | "focus_self"
    | "focus_ally"
    | "focus_planet"
    | "zoom_in"
    | "zoom_out"
    | "reset_view"
    | "set_view_mode";
  target?: string;
  steps?: number;
  view_mode?: "fleet" | "ship";
}

interface HoloDeck3DProps {
  ship: ShipTelemetry;
  fleet: AllyShipState[];
  selectedAlly: AllyShipState | null;
  onSelectAlly: (ally: AllyShipState) => void;
  shipName?: string;
  holoCommand?: HologramCommand | null;
}

interface MoonDef {
  name: string;
  orbit: number;
  angle: number;
  speed: number;
  size: number;
  color: number;
  ring?: boolean;
}

interface PlanetDef {
  name: string;
  orbit: number;
  angle: number;
  size: number;
  primary: number;
  rim: number;
  gasBands?: boolean;
  moons: MoonDef[];
}

// Star Citizen — Stanton System Celestial Catalog (Planets + Authentic Moons)
const STANTON_PLANETS: PlanetDef[] = [
  {
    name: "Hurston",
    orbit: 5.4,
    angle: 0.45,
    size: 0.62,
    primary: 0xb45309,
    rim: 0xfbbf24,
    moons: [
      { name: "Arial", orbit: 1.15, angle: 0.5, speed: 0.32, size: 0.12, color: 0xf59e0b },
      { name: "Aberdeen", orbit: 1.52, angle: 2.1, speed: 0.24, size: 0.14, color: 0xd97706 },
      { name: "Magda", orbit: 1.9, angle: 3.9, speed: 0.19, size: 0.12, color: 0x38bdf8 },
      { name: "Ita", orbit: 2.26, angle: 5.4, speed: 0.15, size: 0.13, color: 0x5eead4 },
    ],
  },
  {
    name: "Crusader",
    orbit: 9.4,
    angle: 2.15,
    size: 0.96,
    primary: 0x0d9488,
    rim: 0x5eead4,
    gasBands: true,
    moons: [
      { name: "Cellin", orbit: 1.55, angle: 0.8, speed: 0.28, size: 0.14, color: 0x99f6e4 },
      { name: "Daymar", orbit: 2.02, angle: 2.7, speed: 0.21, size: 0.16, color: 0xfcd34d },
      { name: "Yela", orbit: 2.55, angle: 4.9, speed: 0.16, size: 0.15, color: 0x67e8f9, ring: true },
    ],
  },
  {
    name: "ArcCorp",
    orbit: 13.6,
    angle: 4.0,
    size: 0.68,
    primary: 0xbe123c,
    rim: 0xfb7185,
    moons: [
      { name: "Lyria", orbit: 1.25, angle: 1.4, speed: 0.26, size: 0.13, color: 0x7dd3fc },
      { name: "Wala", orbit: 1.72, angle: 4.2, speed: 0.19, size: 0.14, color: 0x5eead4 },
    ],
  },
  {
    name: "MicroTech",
    orbit: 18.0,
    angle: 5.42,
    size: 0.76,
    primary: 0x0284c7,
    rim: 0xa5f3fc,
    moons: [
      { name: "Calliope", orbit: 1.32, angle: 0.3, speed: 0.25, size: 0.13, color: 0xbae6fd },
      { name: "Clio", orbit: 1.78, angle: 2.5, speed: 0.19, size: 0.14, color: 0x67e8f9 },
      { name: "Euterpe", orbit: 2.22, angle: 4.7, speed: 0.15, size: 0.12, color: 0xcffafe },
    ],
  },
];

// Futuristic Holographic Fresnel Shell Shader (shares visual DNA with the AETHER Orb)
const HOLO_PLANET_VERT = /* glsl */ `
varying vec3 vNormalView;
varying vec3 vViewDir;
varying vec3 vLocalPos;

void main() {
  vLocalPos = position;
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  vNormalView = normalize(normalMatrix * normal);
  vViewDir = normalize(-mvPos.xyz);
  gl_Position = projectionMatrix * mvPos;
}
`;

const HOLO_PLANET_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uPrimary;
uniform vec3 uRim;
uniform float uBands;
uniform float uOpacity;

varying vec3 vNormalView;
varying vec3 vViewDir;
varying vec3 vLocalPos;

void main() {
  float ndv = abs(dot(normalize(vNormalView), normalize(vViewDir)));
  float fresnel = pow(1.0 - ndv, 2.35);
  float innerGlow = pow(1.0 - ndv, 1.25) * 0.28;

  // Fine horizontal holographic scan bands + subtle pole-to-pole sweep pulse
  float latScan = sin(vLocalPos.y * 34.0 - uTime * 1.4) * 0.5 + 0.5;
  float bandWave = uBands > 0.5 ? (sin(vLocalPos.y * 12.0 + sin(vLocalPos.x * 4.0 + uTime * 0.4)) * 0.5 + 0.5) : 0.0;
  float sweep = smoothstep(0.92, 1.0, sin(vLocalPos.y * 2.2 - uTime * 0.95));

  vec3 col = mix(uPrimary, uRim, clamp(fresnel * 1.15 + sweep * 0.45, 0.0, 1.0));
  col += uRim * (sweep * 0.35 + bandWave * 0.14);

  float alpha = (innerGlow + fresnel * 0.88 + latScan * 0.06 + sweep * 0.18 + bandWave * 0.08) * uOpacity;
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.95));
}
`;

// Build a dotted latitude/longitude holographic point sphere (signature AETHER orb lattice)
function createDottedGlobe(radius: number, colorHex: number, latRings: number, dotSize: number, opacity: number): THREE.Points {
  const pts: number[] = [];
  for (let li = 1; li < latRings; li++) {
    const phi = (li / latRings) * Math.PI;
    const r = Math.sin(phi) * radius;
    const y = Math.cos(phi) * radius;
    const count = Math.max(8, Math.round(latRings * 2.5 * Math.sin(phi)));
    for (let di = 0; di < count; di++) {
      const th = (di / count) * Math.PI * 2;
      pts.push(r * Math.cos(th), y, r * Math.sin(th));
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.PointsMaterial({
    color: colorHex,
    size: dotSize,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Points(geo, mat);
}

// Build a smooth glowing circle line in XZ plane
function createOrbitLine(radius: number, colorHex: number, opacity: number, segments = 128): THREE.LineLoop {
  const pts: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(Math.cos(a) * radius, 0, Math.sin(a) * radius);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({
    color: colorHex,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.LineLoop(geo, mat);
}

interface ProjectedLabel {
  id: string;
  text: string;
  sub?: string;
  kind: "star" | "planet" | "moon" | "self" | "ally" | "alert";
  x: number;
  y: number;
  visible: boolean;
}

/**
 * Full-Viewport Futuristic Star Citizen 3D Holographic Command & Control (C2) Deck.
 * Shares AETHER's bioluminescent GLSL Fresnel & dotted-globe aesthetic with full
 * voice-controlled camera focus (own ship grid, connected friends, Stanton planets/moons) & progressive zoom.
 */
export const HoloDeck3D: React.FC<HoloDeck3DProps> = ({
  ship,
  fleet,
  selectedAlly,
  onSelectAlly,
  shipName,
  holoCommand,
}) => {
  const [viewMode, setViewMode] = useState<"fleet" | "ship">("fleet");
  const [focusLabel, setFocusLabel] = useState<string>("STANTON SYSTEM OVERVIEW");
  const [zoomBand, setZoomBand] = useState<string>("SYSTEM");
  const [labels, setLabels] = useState<ProjectedLabel[]>([]);

  const mountRef = useRef<HTMLDivElement | null>(null);
  const dataRef = useRef({ ship, fleet, viewMode, selectedAlly, shipName });

  // Camera Director state shared between React commands, mouse drag/wheel, and Three.js rAF loop
  const camCtrlRef = useRef({
    focusMode: "system" as "system" | "self" | "ally" | "planet" | "moon",
    focusKey: "Stanton",
    desiredDist: 25.0,
    currentDist: 25.0,
    desiredYaw: 0.32,
    currentYaw: 0.32,
    desiredPitch: 0.56,
    currentPitch: 0.56,
    currentTarget: new THREE.Vector3(0, 0, 0),
    dragging: false,
    lastX: 0,
    lastY: 0,
  });

  useEffect(() => {
    dataRef.current = { ship, fleet, viewMode, selectedAlly, shipName };
  }, [ship, fleet, viewMode, selectedAlly, shipName]);

  // Execute voice/LLM Hologram Director commands smoothly
  useEffect(() => {
    if (!holoCommand) return;
    const ctrl = camCtrlRef.current;
    const steps = Math.max(1, Math.min(4, holoCommand.steps || 1));

    if (holoCommand.action === "set_view_mode") {
      setViewMode(holoCommand.view_mode === "ship" ? "ship" : "fleet");
      setFocusLabel(holoCommand.view_mode === "ship" ? "OWN SHIP TACTICAL WIREFRAME" : "STANTON SYSTEM OVERVIEW");
      return;
    }

    if (holoCommand.action === "zoom_in") {
      setViewMode("fleet");
      ctrl.desiredDist = Math.max(2.3, ctrl.desiredDist * Math.pow(0.58, steps));
      return;
    }

    if (holoCommand.action === "zoom_out") {
      setViewMode("fleet");
      ctrl.desiredDist = Math.min(38.0, ctrl.desiredDist * Math.pow(1.68, steps));
      if (ctrl.desiredDist >= 22.0 && ctrl.focusMode !== "system") {
        ctrl.focusMode = "system";
        ctrl.focusKey = "Stanton";
        setFocusLabel("STANTON SYSTEM OVERVIEW");
      }
      return;
    }

    if (holoCommand.action === "reset_view") {
      setViewMode("fleet");
      ctrl.focusMode = "system";
      ctrl.focusKey = "Stanton";
      ctrl.desiredDist = 25.0;
      ctrl.desiredPitch = 0.56;
      setFocusLabel("STANTON SYSTEM OVERVIEW");
      return;
    }

    if (holoCommand.action === "focus_self") {
      setViewMode("fleet");
      ctrl.focusMode = "self";
      ctrl.focusKey = "SELF";
      ctrl.desiredDist = 4.2;
      ctrl.desiredPitch = 0.62;
      setFocusLabel(`OWN SHIP GRID · ${dataRef.current.ship.zone.toUpperCase()}`);
      return;
    }

    if (holoCommand.action === "focus_ally") {
      setViewMode("fleet");
      const rawT = (holoCommand.target || "").toLowerCase();
      const all = dataRef.current.fleet;
      const found =
        all.find(
          (a) =>
            rawT &&
            `${a.callsign} ${a.pilot_name} ${a.ship_name} ${a.squad}`.toLowerCase().includes(rawT)
        ) ||
        all.find((a) => a.relay_source && a.relay_source !== "simulator") ||
        all[0];

      if (found) {
        onSelectAlly(found);
        ctrl.focusMode = "ally";
        ctrl.focusKey = found.callsign;
        ctrl.desiredDist = 4.4;
        ctrl.desiredPitch = 0.58;
        setFocusLabel(`ALLY LOCK · ${found.callsign.toUpperCase()} (${found.planet.toUpperCase()})`);
      }
      return;
    }

    if (holoCommand.action === "focus_planet") {
      setViewMode("fleet");
      const rawT = (holoCommand.target || "Crusader").trim().toLowerCase();
      if (rawT === "stanton" || rawT === "star" || rawT === "system") {
        ctrl.focusMode = "system";
        ctrl.focusKey = "Stanton";
        ctrl.desiredDist = 24.0;
        setFocusLabel("STANTON SYSTEM OVERVIEW");
        return;
      }
      const pMatch = STANTON_PLANETS.find((p) => p.name.toLowerCase() === rawT || rawT.includes(p.name.toLowerCase()));
      if (pMatch) {
        ctrl.focusMode = "planet";
        ctrl.focusKey = pMatch.name;
        ctrl.desiredDist = 6.2;
        ctrl.desiredPitch = 0.52;
        setFocusLabel(`PLANET ORBIT · ${pMatch.name.toUpperCase()}`);
        return;
      }
      for (const p of STANTON_PLANETS) {
        const mMatch = p.moons.find((m) => m.name.toLowerCase() === rawT || rawT.includes(m.name.toLowerCase()));
        if (mMatch) {
          ctrl.focusMode = "moon";
          ctrl.focusKey = mMatch.name;
          ctrl.desiredDist = 3.2;
          ctrl.desiredPitch = 0.48;
          setFocusLabel(`MOON ORBIT · ${mMatch.name.toUpperCase()} (${p.name.toUpperCase()})`);
          return;
        }
      }
    }
  }, [holoCommand]);

  // Quick helper actions for manual UI controls
  const quickZoom = (factor: number) => {
    const ctrl = camCtrlRef.current;
    ctrl.desiredDist = Math.max(2.3, Math.min(38.0, ctrl.desiredDist * factor));
    if (ctrl.desiredDist >= 23.0 && ctrl.focusMode !== "system") {
      ctrl.focusMode = "system";
      ctrl.focusKey = "Stanton";
      setFocusLabel("STANTON SYSTEM OVERVIEW");
    }
  };

  const quickFocusSelf = () => {
    setViewMode("fleet");
    const ctrl = camCtrlRef.current;
    ctrl.focusMode = "self";
    ctrl.focusKey = "SELF";
    ctrl.desiredDist = 4.2;
    ctrl.desiredPitch = 0.62;
    setFocusLabel(`OWN SHIP GRID · ${ship.zone.toUpperCase()}`);
  };

  const quickFocusAlly = (ally: AllyShipState) => {
    onSelectAlly(ally);
    setViewMode("fleet");
    const ctrl = camCtrlRef.current;
    ctrl.focusMode = "ally";
    ctrl.focusKey = ally.callsign;
    ctrl.desiredDist = 4.5;
    ctrl.desiredPitch = 0.58;
    setFocusLabel(`ALLY LOCK · ${ally.callsign.toUpperCase()} (${ally.planet.toUpperCase()})`);
  };

  const quickReset = () => {
    setViewMode("fleet");
    const ctrl = camCtrlRef.current;
    ctrl.focusMode = "system";
    ctrl.focusKey = "Stanton";
    ctrl.desiredDist = 25.0;
    ctrl.desiredPitch = 0.56;
    setFocusLabel("STANTON SYSTEM OVERVIEW");
  };

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(44, width / height, 0.1, 260);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    const fleetGroup = new THREE.Group();
    scene.add(fleetGroup);

    // === 1. FUTURISTIC POLAR TACTICAL HOLOGRAPHIC FLOOR GRID ===
    const floorY = -2.1;
    const gridGroup = new THREE.Group();
    gridGroup.position.y = floorY;
    fleetGroup.add(gridGroup);

    for (const r of [3.5, 7.5, 11.5, 15.8, 20.5, 25.5]) {
      gridGroup.add(createOrbitLine(r, 0x14b8a6, r === 20.5 ? 0.16 : 0.085, 128));
    }
    // 12 radial azimuth bearing lines
    const spokePositions: number[] = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      spokePositions.push(Math.cos(a) * 2.2, 0, Math.sin(a) * 2.2);
      spokePositions.push(Math.cos(a) * 25.5, 0, Math.sin(a) * 25.5);
    }
    const spokeGeo = new THREE.BufferGeometry();
    spokeGeo.setAttribute("position", new THREE.Float32BufferAttribute(spokePositions, 3));
    gridGroup.add(
      new THREE.LineSegments(
        spokeGeo,
        new THREE.LineBasicMaterial({
          color: 0x0d9488,
          transparent: true,
          opacity: 0.085,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      )
    );

    // Subtle deep-space ambient teal dust field
    const dustCount = 340;
    const dustPos = new Float32Array(dustCount * 3);
    for (let i = 0; i < dustCount; i++) {
      const r = 4 + Math.random() * 34;
      const th = Math.random() * Math.PI * 2;
      dustPos[i * 3] = Math.cos(th) * r;
      dustPos[i * 3 + 1] = (Math.random() - 0.5) * 14;
      dustPos[i * 3 + 2] = Math.sin(th) * r;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute("position", new THREE.Float32BufferAttribute(dustPos, 3));
    fleetGroup.add(
      new THREE.Points(
        dustGeo,
        new THREE.PointsMaterial({
          color: 0x5eead4,
          size: 0.06,
          transparent: true,
          opacity: 0.28,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      )
    );

    // === 2. STANTON STAR (FUTURISTIC DUAL FRESNEL + CORONA LATTICE + ASTROLABE RINGS) ===
    const planetShaders: Array<{ uTime: { value: number } }> = [];
    const starGroup = new THREE.Group();
    fleetGroup.add(starGroup);

    const starUniforms = {
      uTime: { value: 0 },
      uPrimary: { value: new THREE.Color(0xf59e0b) },
      uRim: { value: new THREE.Color(0xfef08a) },
      uBands: { value: 1.0 },
      uOpacity: { value: 0.96 },
    };
    planetShaders.push(starUniforms);

    starGroup.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(1.18, 48, 48),
        new THREE.ShaderMaterial({
          uniforms: starUniforms,
          vertexShader: HOLO_PLANET_VERT,
          fragmentShader: HOLO_PLANET_FRAG,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        })
      )
    );
    const starDots = createDottedGlobe(0.92, 0xfef08a, 14, 0.055, 0.85);
    starGroup.add(starDots);

    const starRing1 = createOrbitLine(1.75, 0xfde68a, 0.34, 96);
    starRing1.rotation.x = 0.28;
    const starRing2 = createOrbitLine(2.1, 0x5eead4, 0.18, 96);
    starRing2.rotation.z = -0.35;
    starGroup.add(starRing1, starRing2);

    // === 3. STANTON PLANETS + 12 AUTHENTIC MOONS (AETHER ORB SHADER DNA) ===
    const planetPositions: Record<string, THREE.Vector3> = { Stanton: new THREE.Vector3(0, 0, 0) };
    const moonPositions: Record<string, THREE.Vector3> = {};
    const planetSpinners: THREE.Object3D[] = [];
    const moonUpdaters: Array<{
      name: string;
      parentPos: THREE.Vector3;
      orbit: number;
      baseAngle: number;
      speed: number;
      group: THREE.Group;
    }> = [];

    STANTON_PLANETS.forEach((p) => {
      // Main Stanton orbital track
      fleetGroup.add(createOrbitLine(p.orbit, 0x2dd4bf, 0.16, 160));

      const px = Math.cos(p.angle) * p.orbit;
      const pz = Math.sin(p.angle) * p.orbit;
      const pVec = new THREE.Vector3(px, 0, pz);
      planetPositions[p.name] = pVec;

      const pGroup = new THREE.Group();
      pGroup.position.copy(pVec);
      fleetGroup.add(pGroup);

      // Fresnel translucent scan-shell (matches AETHER orb glow!)
      const u = {
        uTime: { value: 0 },
        uPrimary: { value: new THREE.Color(p.primary) },
        uRim: { value: new THREE.Color(p.rim) },
        uBands: { value: p.gasBands ? 1.0 : 0.0 },
        uOpacity: { value: 0.92 },
      };
      planetShaders.push(u);

      const shell = new THREE.Mesh(
        new THREE.SphereGeometry(p.size, 44, 44),
        new THREE.ShaderMaterial({
          uniforms: u,
          vertexShader: HOLO_PLANET_VERT,
          fragmentShader: HOLO_PLANET_FRAG,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        })
      );
      pGroup.add(shell);

      // Inner dotted meridian lattice sphere (identical aesthetic to AETHER orb core!)
      const dottedCore = createDottedGlobe(p.size * 0.78, p.rim, 12, 0.042, 0.78);
      pGroup.add(dottedCore);
      planetSpinners.push(dottedCore);

      // Futuristic tilted equatorial holo-reticle ring
      const eqRing = createOrbitLine(p.size * 1.38, p.rim, 0.42, 72);
      eqRing.rotation.x = p.gasBands ? 0.18 : 0.08;
      pGroup.add(eqRing);

      if (p.gasBands) {
        const gasRing = createOrbitLine(p.size * 1.68, 0x5eead4, 0.22, 84);
        gasRing.rotation.x = -0.14;
        pGroup.add(gasRing);
      }

      // Holographic drop-stem down to floor grid + base anchor ring
      const stemGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, -p.size * 1.05, 0),
        new THREE.Vector3(0, floorY, 0),
      ]);
      pGroup.add(
        new THREE.Line(
          stemGeo,
          new THREE.LineBasicMaterial({
            color: p.rim,
            transparent: true,
            opacity: 0.22,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          })
        )
      );
      const baseRing = createOrbitLine(p.size * 0.72, p.rim, 0.24, 48);
      baseRing.position.y = floorY;
      pGroup.add(baseRing);

      // Orbiting Star Citizen Moons
      p.moons.forEach((m) => {
        const mTrack = createOrbitLine(m.orbit, 0x5eead4, 0.11, 72);
        pGroup.add(mTrack);

        const mGroup = new THREE.Group();
        fleetGroup.add(mGroup);

        const mu = {
          uTime: { value: 0 },
          uPrimary: { value: new THREE.Color(m.color) },
          uRim: { value: new THREE.Color(0xe0f2fe) },
          uBands: { value: 0.0 },
          uOpacity: { value: 0.85 },
        };
        planetShaders.push(mu);

        mGroup.add(
          new THREE.Mesh(
            new THREE.SphereGeometry(m.size, 24, 24),
            new THREE.ShaderMaterial({
              uniforms: mu,
              vertexShader: HOLO_PLANET_VERT,
              fragmentShader: HOLO_PLANET_FRAG,
              transparent: true,
              depthWrite: false,
              blending: THREE.AdditiveBlending,
              side: THREE.DoubleSide,
            })
          )
        );
        mGroup.add(createDottedGlobe(m.size * 0.82, m.color, 7, 0.025, 0.75));
        if (m.ring) {
          // Yela's iconic icy asteroid belt ring
          const yelaBelt = createOrbitLine(m.size * 2.15, 0x67e8f9, 0.45, 56);
          yelaBelt.rotation.x = 0.25;
          mGroup.add(yelaBelt);
        }

        const mx = pVec.x + Math.cos(m.angle) * m.orbit;
        const mz = pVec.z + Math.sin(m.angle) * m.orbit;
        mGroup.position.set(mx, 0, mz);
        moonPositions[m.name] = new THREE.Vector3(mx, 0, mz);
        moonUpdaters.push({
          name: m.name,
          parentPos: pVec,
          orbit: m.orbit,
          baseAngle: m.angle,
          speed: m.speed,
          group: mGroup,
        });
      });
    });

    // === 4. OWN-SHIP LIVE HOLOGRAPHIC BEACON + LOCAL TACTICAL GRID ===
    const ownGroup = new THREE.Group();
    fleetGroup.add(ownGroup);

    const ownBeacon = new THREE.Mesh(
      new THREE.ConeGeometry(0.18, 0.56, 4),
      new THREE.MeshBasicMaterial({
        color: 0x5eead4,
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
      })
    );
    ownBeacon.rotation.x = Math.PI / 2;
    ownGroup.add(ownBeacon);

    // Local precision range rings around own ship (super crisp when zoomed in on "where are we?")
    const ownGridRing1 = createOrbitLine(0.58, 0x5eead4, 0.55, 64);
    const ownGridRing2 = createOrbitLine(1.15, 0x2dd4bf, 0.26, 64);
    const ownCrossGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-1.3, 0, 0),
      new THREE.Vector3(1.3, 0, 0),
      new THREE.Vector3(0, 0, -1.3),
      new THREE.Vector3(0, 0, 1.3),
    ]);
    const ownCross = new THREE.LineSegments(
      ownCrossGeo,
      new THREE.LineBasicMaterial({
        color: 0x2dd4bf,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    ownGroup.add(ownGridRing1, ownGridRing2, ownCross);

    const ownStemGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, floorY, 0),
    ]);
    ownGroup.add(
      new THREE.Line(
        ownStemGeo,
        new THREE.LineBasicMaterial({
          color: 0x5eead4,
          transparent: true,
          opacity: 0.36,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      )
    );

    // === 5. PULSING HOLOGRAPHIC TARGET LOCK-ON RETICLE ===
    const lockReticle = new THREE.Group();
    const lockOuter = createOrbitLine(0.75, 0x5eead4, 0.8, 64);
    const lockInner = createOrbitLine(0.46, 0x99f6e4, 0.65, 48);
    lockReticle.add(lockOuter, lockInner);
    lockReticle.visible = false;
    fleetGroup.add(lockReticle);

    // === 6. CONNECTED FRIENDS / ALLIED SHIPS ===
    const allyNodes = new Map<
      string,
      { group: THREE.Group; core: THREE.Mesh; ring: THREE.LineLoop; outerRing: THREE.LineLoop }
    >();

    // === 7. OWN-SHIP 3D TACTICAL WIREFRAME VIEW (UPGRADED FRESNEL + DOTTED) ===
    const shipGroup = new THREE.Group();
    shipGroup.visible = false;
    scene.add(shipGroup);

    const hullGroup = new THREE.Group();
    shipGroup.add(hullGroup);

    const hullMat = new THREE.MeshBasicMaterial({
      color: 0x5eead4,
      wireframe: true,
      transparent: true,
      opacity: 0.78,
      blending: THREE.AdditiveBlending,
    });
    const fuselage = new THREE.Mesh(new THREE.ConeGeometry(1.15, 5.4, 6), hullMat);
    fuselage.rotation.x = Math.PI / 2;
    const wings = new THREE.Mesh(new THREE.BoxGeometry(6.8, 0.16, 1.9), hullMat);
    wings.position.z = -0.5;
    const tail = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.05, 0.18), hullMat);
    tail.position.set(0, 0.55, -2.1);
    hullGroup.add(fuselage, wings, tail);
    shipGroup.add(createOrbitLine(4.65, 0x14b8a6, 0.22, 96));

    const makeShieldArc = (startAngle: number) => {
      const geo = new THREE.RingGeometry(4.0, 4.34, 36, 1, startAngle, Math.PI / 2 - 0.14);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x2dd4bf,
        transparent: true,
        opacity: 0.65,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      return mesh;
    };
    const shieldFront = makeShieldArc(Math.PI / 4 + 0.07);
    const shieldLeft = makeShieldArc((3 * Math.PI) / 4 + 0.07);
    const shieldBack = makeShieldArc((5 * Math.PI) / 4 + 0.07);
    const shieldRight = makeShieldArc((7 * Math.PI) / 4 + 0.07);
    shipGroup.add(shieldFront, shieldLeft, shieldBack, shieldRight);

    // Interactive mouse orbit + wheel zoom
    const domEl = renderer.domElement;
    const onPointerDown = (e: PointerEvent) => {
      camCtrlRef.current.dragging = true;
      camCtrlRef.current.lastX = e.clientX;
      camCtrlRef.current.lastY = e.clientY;
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!camCtrlRef.current.dragging) return;
      const dx = e.clientX - camCtrlRef.current.lastX;
      const dy = e.clientY - camCtrlRef.current.lastY;
      camCtrlRef.current.lastX = e.clientX;
      camCtrlRef.current.lastY = e.clientY;
      camCtrlRef.current.desiredYaw -= dx * 0.006;
      camCtrlRef.current.desiredPitch = Math.max(0.14, Math.min(1.38, camCtrlRef.current.desiredPitch + dy * 0.005));
    };
    const onPointerUp = () => {
      camCtrlRef.current.dragging = false;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const ctrl = camCtrlRef.current;
      const factor = e.deltaY > 0 ? 1.14 : 0.88;
      ctrl.desiredDist = Math.max(2.3, Math.min(38.0, ctrl.desiredDist * factor));
    };

    domEl.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    domEl.addEventListener("wheel", onWheel, { passive: false });

    const clock = new THREE.Clock();
    let animId = 0;
    let frameCount = 0;
    const shieldColor = (pct: number) => (pct < 30 ? 0xef4444 : pct < 65 ? 0xf59e0b : 0x2dd4bf);
    const projVec = new THREE.Vector3();

    const animate = () => {
      animId = requestAnimationFrame(animate);
      frameCount++;
      const t = clock.getElapsedTime();
      const { ship: s, fleet: f, viewMode: mode, shipName: sName } = dataRef.current;
      const ctrl = camCtrlRef.current;

      fleetGroup.visible = mode === "fleet";
      shipGroup.visible = mode === "ship";

      planetShaders.forEach((u) => {
        u.uTime.value = t;
      });

      if (mode === "fleet") {
        // Gentle orbital rotation of star, dotted cores, and Stanton moons
        starDots.rotation.y += 0.004;
        starRing1.rotation.z += 0.0025;
        starRing2.rotation.y -= 0.003;
        planetSpinners.forEach((sp) => {
          sp.rotation.y += 0.0045;
        });

        moonUpdaters.forEach((m) => {
          const a = m.baseAngle + t * m.speed * 0.25;
          const mx = m.parentPos.x + Math.cos(a) * m.orbit;
          const mz = m.parentPos.z + Math.sin(a) * m.orbit;
          m.group.position.set(mx, 0, mz);
          m.group.rotation.y += 0.008;
          moonPositions[m.name].set(mx, 0, mz);
        });

        // Position own ship in its live Star Citizen planet orbit
        const ownCenter = planetPositions[s.planet] ?? planetPositions.Crusader;
        const ownAngle = t * 0.18 + 0.9;
        const ownX = ownCenter.x + Math.cos(ownAngle) * 1.48;
        const ownZ = ownCenter.z + Math.sin(ownAngle) * 1.48;
        ownGroup.position.set(ownX, 0.18 + Math.sin(t * 2.0) * 0.05, ownZ);
        ownBeacon.rotation.z = -ownAngle;
        ownGridRing1.rotation.y += 0.008;

        // Sync connected friends / allies
        const activeCallsigns = new Set(f.map((a) => a.callsign));
        for (const [cs, obj] of allyNodes.entries()) {
          if (!activeCallsigns.has(cs)) {
            fleetGroup.remove(obj.group);
            allyNodes.delete(cs);
          }
        }

        const allyWorldPos: Record<string, THREE.Vector3> = {};
        f.forEach((ally) => {
          let entry = allyNodes.get(ally.callsign);
          if (!entry) {
            const g = new THREE.Group();
            const core = new THREE.Mesh(
              new THREE.OctahedronGeometry(ally.ship_class === "Capital" ? 0.34 : 0.22, 0),
              new THREE.MeshBasicMaterial({
                color: 0x5eead4,
                transparent: true,
                opacity: 0.92,
                blending: THREE.AdditiveBlending,
              })
            );
            const ring = createOrbitLine(0.42, 0x5eead4, 0.65, 40);
            const outerRing = createOrbitLine(0.64, 0x2dd4bf, 0.28, 48);
            const stem = new THREE.Line(
              new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, floorY, 0)]),
              new THREE.LineBasicMaterial({
                color: 0x2dd4bf,
                transparent: true,
                opacity: 0.24,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
              })
            );
            g.add(core, ring, outerRing, stem);
            fleetGroup.add(g);
            entry = { group: g, core, ring, outerRing };
            allyNodes.set(ally.callsign, entry);
          }

          const center = planetPositions[ally.planet] ?? planetPositions.Crusader;
          const rDist = Math.min(2.65, Math.max(1.3, ally.orbit_radius * 0.88));
          const ax = center.x + Math.cos(ally.orbit_angle_rad) * rDist;
          const az = center.z + Math.sin(ally.orbit_angle_rad) * rDist;
          entry.group.position.set(ax, 0.22, az);
          entry.core.rotation.y += 0.02;
          entry.outerRing.rotation.y -= 0.01;
          allyWorldPos[ally.callsign] = new THREE.Vector3(ax, 0.22, az);

          const col =
            ally.under_fire || ally.status === "DISTRESS"
              ? 0xef4444
              : ally.status === "QUANTUM"
                ? 0xc084fc
                : 0x5eead4;
          (entry.core.material as THREE.MeshBasicMaterial).color.setHex(col);
          (entry.ring.material as THREE.LineBasicMaterial).color.setHex(col);
          (entry.outerRing.material as THREE.LineBasicMaterial).color.setHex(col);
          const pulse = ally.under_fire || ally.status === "DISTRESS" ? 1.0 + Math.abs(Math.sin(t * 7)) * 0.6 : 1.0;
          entry.ring.scale.setScalar(pulse);
        });

        // Resolve desired 3D focus target for smooth voice/manual camera fly-to
        const desiredTarget = new THREE.Vector3(0, 0, 0);
        if (ctrl.focusMode === "self") {
          desiredTarget.copy(ownGroup.position);
          lockReticle.visible = true;
          lockReticle.position.copy(ownGroup.position);
          lockReticle.scale.setScalar(1.0 + Math.sin(t * 3.2) * 0.08);
        } else if (ctrl.focusMode === "ally" && allyWorldPos[ctrl.focusKey]) {
          desiredTarget.copy(allyWorldPos[ctrl.focusKey]);
          lockReticle.visible = true;
          lockReticle.position.copy(desiredTarget);
          lockReticle.scale.setScalar(1.05 + Math.sin(t * 3.8) * 0.1);
        } else if (ctrl.focusMode === "planet" && planetPositions[ctrl.focusKey]) {
          desiredTarget.copy(planetPositions[ctrl.focusKey]);
          lockReticle.visible = true;
          lockReticle.position.copy(desiredTarget);
          lockReticle.scale.setScalar(1.85 + Math.sin(t * 2.4) * 0.06);
        } else if (ctrl.focusMode === "moon" && moonPositions[ctrl.focusKey]) {
          desiredTarget.copy(moonPositions[ctrl.focusKey]);
          lockReticle.visible = true;
          lockReticle.position.copy(desiredTarget);
          lockReticle.scale.setScalar(0.62 + Math.sin(t * 3.0) * 0.06);
        } else {
          lockReticle.visible = false;
        }
        lockOuter.rotation.y += 0.012;
        lockInner.rotation.y -= 0.018;

        // Subtle ambient drift when hands-off in system overview
        if (!ctrl.dragging && ctrl.focusMode === "system") {
          ctrl.desiredYaw += 0.00055;
        }

        // Smooth camera interpolation (fly-to + progressive zoom)
        ctrl.currentTarget.lerp(desiredTarget, 0.065);
        ctrl.currentDist += (ctrl.desiredDist - ctrl.currentDist) * 0.075;
        ctrl.currentYaw += (ctrl.desiredYaw - ctrl.currentYaw) * 0.09;
        ctrl.currentPitch += (ctrl.desiredPitch - ctrl.currentPitch) * 0.09;

        const horiz = Math.cos(ctrl.currentPitch) * ctrl.currentDist;
        const camX = ctrl.currentTarget.x + Math.sin(ctrl.currentYaw) * horiz;
        const camY = ctrl.currentTarget.y + Math.sin(ctrl.currentPitch) * ctrl.currentDist;
        const camZ = ctrl.currentTarget.z + Math.cos(ctrl.currentYaw) * horiz;
        camera.position.set(camX, camY, camZ);
        camera.lookAt(ctrl.currentTarget);

        // Project crisp holographic screen-space labels every 3 frames
        if (frameCount % 3 === 0) {
          const w = container.clientWidth || window.innerWidth;
          const h = container.clientHeight || window.innerHeight;
          const nextLabels: ProjectedLabel[] = [];
          const pushLabel = (
            id: string,
            pos: THREE.Vector3,
            text: string,
            kind: ProjectedLabel["kind"],
            sub?: string,
            yOff = 0.55
          ) => {
            projVec.set(pos.x, pos.y + yOff, pos.z).project(camera);
            const visible = projVec.z >= -1 && projVec.z <= 1;
            const sx = (projVec.x * 0.5 + 0.5) * w;
            const sy = (-projVec.y * 0.5 + 0.5) * h;
            if (visible && sx > 20 && sx < w - 20 && sy > 52 && sy < h - 75) {
              nextLabels.push({ id, text, sub, kind, x: sx, y: sy, visible: true });
            }
          };

          pushLabel("star-stanton", planetPositions.Stanton, "STANTON", "star", "G2V", 1.5);
          STANTON_PLANETS.forEach((p) => {
            pushLabel(`p-${p.name}`, planetPositions[p.name], p.name.toUpperCase(), "planet", `${p.moons.length} MOONS`, p.size + 0.42);
            // Reveal moon labels smoothly when zoomed into local / planetary scale
            if (ctrl.currentDist < 12.5) {
              p.moons.forEach((m) => {
                const mp = moonPositions[m.name];
                if (mp && mp.distanceTo(ctrl.currentTarget) < 7.5) {
                  pushLabel(`m-${m.name}`, mp, m.name.toUpperCase(), "moon", undefined, m.size + 0.24);
                }
              });
            }
          });

          const shortShip = (sName || s.zone).replace(/\s*\([^)]*\)/g, "").trim();
          pushLabel("own-ship", ownGroup.position, "YOU", "self", shortShip, 0.56);

          f.forEach((ally) => {
            const ap = allyWorldPos[ally.callsign];
            if (ap) {
              const isAlert = ally.under_fire || ally.status === "DISTRESS";
              pushLabel(
                `ally-${ally.callsign}`,
                ap,
                ally.callsign.toUpperCase(),
                isAlert ? "alert" : "ally",
                ally.ship_name,
                0.56
              );
            }
          });

          // Gentle 2D label declutter so nearby ship & planet tags never overlap
          for (let i = 0; i < nextLabels.length; i++) {
            for (let j = i + 1; j < nextLabels.length; j++) {
              const a = nextLabels[i];
              const b = nextLabels[j];
              if (Math.abs(a.x - b.x) < 92 && Math.abs(a.y - b.y) < 30) {
                b.y -= 30;
              }
            }
          }

          setLabels(nextLabels);
          const band =
            ctrl.currentDist < 5.8
              ? "LOCAL GRID"
              : ctrl.currentDist < 13.0
                ? "PLANETARY"
                : ctrl.currentDist < 26.5
                  ? "STANTON SYSTEM"
                  : "DEEP SECTOR";
          setZoomBand(band);
        }
      } else {
        camera.position.lerp(new THREE.Vector3(0, 7.0, 10.6), 0.06);
        camera.lookAt(0, 0, 0);
        if (frameCount % 6 === 0) setLabels([]);

        hullGroup.rotation.x = THREE.MathUtils.degToRad(s.pitch_deg);
        hullGroup.rotation.z = THREE.MathUtils.degToRad(-s.roll_deg);
        hullGroup.rotation.y = THREE.MathUtils.degToRad(s.yaw_deg * 0.25);

        const updateArc = (arc: THREE.Mesh, pct: number) => {
          const mat = arc.material as THREE.MeshBasicMaterial;
          mat.color.setHex(shieldColor(pct));
          mat.opacity = Math.max(0.12, (pct / 100) * 0.85);
        };
        updateArc(shieldFront, s.shields.front);
        updateArc(shieldBack, s.shields.back);
        updateArc(shieldLeft, s.shields.left);
        updateArc(shieldRight, s.shields.right);
      }

      renderer.render(scene, camera);
    };

    animate();

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      domEl.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      domEl.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animId);
      renderer.dispose();
    };
  }, []);

  return (
    <div className="holo-fullscreen">
      <div ref={mountRef} style={{ width: "100%", height: "100%", cursor: "grab" }} />

      {/* Crisp Futuristic 3D-Projected Screen-Space Hologram Labels */}
      {viewMode === "fleet" && (
        <div className="holo-label-layer">
          {labels.map((lb) => (
            <div
              key={lb.id}
              className={`holo-tag holo-tag-${lb.kind}`}
              style={{ transform: `translate(${lb.x}px, ${lb.y}px) translate(-50%, -100%)` }}
            >
              <span className="holo-tag-title">{lb.text}</span>
              {lb.sub && <span className="holo-tag-sub">{lb.sub}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Whisper-clean top floating ally pills & view toggle */}
      <div className="holo-top-controls">
        <button className={`btn ${viewMode === "fleet" ? "active" : ""}`} onClick={quickReset}>
          Stanton ({fleet.length})
        </button>
        <button className="btn" onClick={quickFocusSelf} title="Zoom to Your Live Ship Grid">
          <Crosshair size={12} /> My Grid
        </button>
        <button className={`btn ${viewMode === "ship" ? "active" : ""}`} onClick={() => setViewMode("ship")}>
          Own Ship
        </button>
        {viewMode === "fleet" &&
          fleet.map((ally) => {
            const isAlert = ally.under_fire || ally.status === "DISTRESS";
            const isSelected = selectedAlly?.callsign === ally.callsign;
            return (
              <button
                key={ally.callsign}
                className={`btn ${isSelected ? "active" : ""} ${isAlert ? "danger" : ""}`}
                onClick={() => quickFocusAlly(ally)}
                title={`Snap hologram to ${ally.callsign} (${ally.ship_name})`}
              >
                <span>{ally.callsign}</span>
                <span style={{ opacity: 0.65, fontSize: 9.5 }}>{ally.planet}</span>
              </button>
            );
          })}
      </div>

      {/* Minimalist glass tactical telemetry + focus & zoom controls */}
      <div className="holo-bottom-hud">
        <div className="hud-glass-card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div>
            <div style={{ fontSize: 9, color: "var(--teal-dim)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
              SCALE · {zoomBand}
            </div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--teal-bright)", marginTop: 2 }}>
              {focusLabel}
            </div>
          </div>
          {viewMode === "fleet" && (
            <div style={{ display: "flex", gap: 4 }}>
              <button className="btn icon-only" onClick={() => quickZoom(0.62)} title="Zoom In">
                <Plus size={12} />
              </button>
              <button className="btn icon-only" onClick={() => quickZoom(1.58)} title="Zoom Out">
                <Minus size={12} />
              </button>
              <button className="btn icon-only" onClick={quickReset} title="Reset Stanton Overview">
                <RotateCcw size={12} />
              </button>
            </div>
          )}
        </div>

        {selectedAlly && viewMode === "fleet" && (
          <div className="hud-glass-card">
            <div style={{ fontSize: 9.5, color: "var(--teal-dim)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
              {selectedAlly.squad} Squad · {selectedAlly.status}
            </div>
            <div style={{ fontWeight: 600, color: "var(--teal-bright)", marginTop: 3 }}>
              {selectedAlly.callsign} — {selectedAlly.ship_name}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
              {selectedAlly.zone} · SHD {selectedAlly.shields_pct.toFixed(0)}% · HULL {selectedAlly.hull_pct.toFixed(0)}%
            </div>
          </div>
        )}

        <div className="hud-glass-card">
          <div className="metric-row">
            <div className="metric">
              <span className="metric-label">Mode</span>
              <span className="metric-val">{ship.master_mode}</span>
            </div>
            <div className="metric">
              <span className="metric-label">Speed</span>
              <span className="metric-val">{ship.speed_mps.toFixed(0)} m/s</span>
            </div>
            <div className="metric">
              <span className="metric-label">H2 / QT</span>
              <span className="metric-val">
                {ship.hydrogen_fuel_pct.toFixed(0)}% / {ship.quantum_fuel_pct.toFixed(0)}%
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
