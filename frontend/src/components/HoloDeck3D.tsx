import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { AllyShipState, ShipTelemetry } from "../types";

interface HoloDeck3DProps {
  ship: ShipTelemetry;
  fleet: AllyShipState[];
  selectedAlly: AllyShipState | null;
  onSelectAlly: (ally: AllyShipState) => void;
}

const PLANET_LAYOUT: Record<string, { orbit: number; angle: number; color: number; size: number }> = {
  Hurston: { orbit: 4.5, angle: 0.4, color: 0xd97706, size: 0.55 },
  Crusader: { orbit: 7.4, angle: 2.0, color: 0x2dd4bf, size: 0.85 },
  ArcCorp: { orbit: 10.2, angle: 3.9, color: 0xf43f5e, size: 0.6 },
  MicroTech: { orbit: 13.0, angle: 5.3, color: 0xccfbf1, size: 0.68 },
};

/**
 * Full-Viewport Dark Obsidian & Bioluminescent Teal Hologram Deck for Friends / Fleet & Own Ship.
 */
export const HoloDeck3D: React.FC<HoloDeck3DProps> = ({ ship, fleet, selectedAlly, onSelectAlly }) => {
  const [viewMode, setViewMode] = useState<"fleet" | "ship">("fleet");
  const mountRef = useRef<HTMLDivElement | null>(null);
  const dataRef = useRef({ ship, fleet, viewMode });

  useEffect(() => {
    dataRef.current = { ship, fleet, viewMode };
  }, [ship, fleet, viewMode]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(46, width / height, 0.1, 200);
    camera.position.set(0, 14, 19);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    // Subtle dark-teal spatial floor grid matching the acoustic orb palette
    const grid = new THREE.GridHelper(36, 36, 0x14b8a6, 0x072126);
    grid.position.y = -1.6;
    scene.add(grid);

    const fleetGroup = new THREE.Group();
    scene.add(fleetGroup);

    const starMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0xfde68a, wireframe: true, transparent: true, opacity: 0.85 })
    );
    fleetGroup.add(starMesh);

    const planetPositions: Record<string, THREE.Vector3> = {};
    Object.entries(PLANET_LAYOUT).forEach(([name, cfg]) => {
      const orbitRing = new THREE.Mesh(
        new THREE.RingGeometry(cfg.orbit - 0.025, cfg.orbit + 0.025, 110),
        new THREE.MeshBasicMaterial({
          color: 0x2dd4bf,
          transparent: true,
          opacity: 0.16,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      orbitRing.rotation.x = Math.PI / 2;
      fleetGroup.add(orbitRing);

      const px = Math.cos(cfg.angle) * cfg.orbit;
      const pz = Math.sin(cfg.angle) * cfg.orbit;
      planetPositions[name] = new THREE.Vector3(px, 0, pz);

      const pMesh = new THREE.Mesh(
        new THREE.SphereGeometry(cfg.size, 18, 18),
        new THREE.MeshBasicMaterial({ color: cfg.color, wireframe: true, transparent: true, opacity: 0.72 })
      );
      pMesh.position.set(px, 0, pz);
      fleetGroup.add(pMesh);
    });

    const ownMarker = new THREE.Mesh(
      new THREE.ConeGeometry(0.32, 0.82, 4),
      new THREE.MeshBasicMaterial({ color: 0x5eead4, wireframe: true })
    );
    fleetGroup.add(ownMarker);

    const allyMeshes = new Map<string, { mesh: THREE.Mesh; ring: THREE.Mesh }>();

    // Own-Ship 3D Wireframe View
    const shipGroup = new THREE.Group();
    shipGroup.visible = false;
    scene.add(shipGroup);

    const hullGroup = new THREE.Group();
    shipGroup.add(hullGroup);

    const hullMat = new THREE.MeshBasicMaterial({ color: 0x2dd4bf, wireframe: true });
    const fuselage = new THREE.Mesh(new THREE.ConeGeometry(1.15, 5.2, 6), hullMat);
    fuselage.rotation.x = Math.PI / 2;
    const wings = new THREE.Mesh(new THREE.BoxGeometry(6.8, 0.18, 1.9), hullMat);
    wings.position.z = -0.5;
    const tail = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.1, 0.2), hullMat);
    tail.position.set(0, 0.55, -2.1);
    hullGroup.add(fuselage, wings, tail);

    const makeShieldArc = (startAngle: number) => {
      const geo = new THREE.RingGeometry(4.1, 4.42, 28, 1, startAngle, Math.PI / 2 - 0.16);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x2dd4bf,
        transparent: true,
        opacity: 0.65,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      return mesh;
    };
    const shieldFront = makeShieldArc(Math.PI / 4 + 0.08);
    const shieldLeft = makeShieldArc((3 * Math.PI) / 4 + 0.08);
    const shieldBack = makeShieldArc((5 * Math.PI) / 4 + 0.08);
    const shieldRight = makeShieldArc((7 * Math.PI) / 4 + 0.08);
    shipGroup.add(shieldFront, shieldLeft, shieldBack, shieldRight);

    const clock = new THREE.Clock();
    let animId = 0;

    const shieldColor = (pct: number) => (pct < 30 ? 0xef4444 : pct < 65 ? 0xf59e0b : 0x2dd4bf);

    const animate = () => {
      animId = requestAnimationFrame(animate);
      const t = clock.getElapsedTime();
      const { ship: s, fleet: f, viewMode: mode } = dataRef.current;

      fleetGroup.visible = mode === "fleet";
      shipGroup.visible = mode === "ship";

      if (mode === "fleet") {
        camera.position.lerp(new THREE.Vector3(Math.sin(t * 0.08) * 3.5, 14.2, 19.2), 0.04);
        camera.lookAt(0, 0, 0);
        starMesh.rotation.y += 0.005;

        const ownCenter = planetPositions[s.planet] ?? planetPositions.Crusader;
        ownMarker.position.set(
          ownCenter.x + Math.cos(t * 0.5) * 1.65,
          0.35 + Math.sin(t * 2.0) * 0.1,
          ownCenter.z + Math.sin(t * 0.5) * 1.65
        );
        ownMarker.rotation.y = -t * 0.5;

        const activeCallsigns = new Set(f.map((a) => a.callsign));
        for (const [cs, obj] of allyMeshes.entries()) {
          if (!activeCallsigns.has(cs)) {
            fleetGroup.remove(obj.mesh, obj.ring);
            allyMeshes.delete(cs);
          }
        }

        f.forEach((ally) => {
          let entry = allyMeshes.get(ally.callsign);
          if (!entry) {
            const m = new THREE.Mesh(
              new THREE.OctahedronGeometry(ally.ship_class === "Capital" ? 0.42 : 0.28, 0),
              new THREE.MeshBasicMaterial({ color: 0x5eead4, wireframe: true })
            );
            const r = new THREE.Mesh(
              new THREE.RingGeometry(0.45, 0.54, 24),
              new THREE.MeshBasicMaterial({
                color: 0x5eead4,
                transparent: true,
                opacity: 0.48,
                side: THREE.DoubleSide,
                depthWrite: false,
              })
            );
            r.rotation.x = Math.PI / 2;
            fleetGroup.add(m, r);
            entry = { mesh: m, ring: r };
            allyMeshes.set(ally.callsign, entry);
          }

          const center = planetPositions[ally.planet] ?? planetPositions.Crusader;
          const rDist = Math.min(2.3, Math.max(1.2, ally.orbit_radius * 0.72));
          const x = center.x + Math.cos(ally.orbit_angle_rad) * rDist;
          const z = center.z + Math.sin(ally.orbit_angle_rad) * rDist;
          entry.mesh.position.set(x, 0.25, z);
          entry.mesh.rotation.y += 0.02;
          entry.ring.position.set(x, 0.05, z);

          const col =
            ally.under_fire || ally.status === "DISTRESS"
              ? 0xef4444
              : ally.status === "QUANTUM"
                ? 0xc084fc
                : 0x5eead4;
          (entry.mesh.material as THREE.MeshBasicMaterial).color.setHex(col);
          (entry.ring.material as THREE.MeshBasicMaterial).color.setHex(col);

          const pulse = ally.under_fire || ally.status === "DISTRESS" ? 1.0 + Math.abs(Math.sin(t * 7)) * 0.9 : 1.0;
          entry.ring.scale.setScalar(pulse);
        });
      } else {
        camera.position.lerp(new THREE.Vector3(0, 7.2, 10.8), 0.06);
        camera.lookAt(0, 0, 0);

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
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animId);
      renderer.dispose();
    };
  }, []);

  return (
    <div className="holo-fullscreen">
      <div ref={mountRef} style={{ width: "100%", height: "100%" }} />

      {/* Whisper-clean top floating ally pills & view toggle */}
      <div className="holo-top-controls">
        <button className={`btn ${viewMode === "fleet" ? "active" : ""}`} onClick={() => setViewMode("fleet")}>
          Fleet ({fleet.length})
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
                onClick={() => onSelectAlly(ally)}
              >
                <span>{ally.callsign}</span>
                <span style={{ opacity: 0.65, fontSize: 9.5 }}>{ally.planet}</span>
              </button>
            );
          })}
      </div>

      {/* Minimalist glass tactical telemetry readout */}
      <div className="holo-bottom-hud">
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
