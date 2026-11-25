import React, { useEffect, useRef } from "react";
import * as THREE from "three";

interface JarvisCore3DProps {
  mood: string; // NOMINAL | CAUTION | COMBAT | HUMOR
  speaking: boolean;
  listening: boolean;
}

const MOOD_COLORS: Record<string, number> = {
  NOMINAL: 0x22d3ee,
  CAUTION: 0xf59e0b,
  COMBAT: 0xef4444,
  HUMOR: 0xa855f7,
};

export const JarvisCore3D: React.FC<JarvisCore3DProps> = ({ mood, speaking, listening }) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef({ mood, speaking, listening });

  useEffect(() => {
    stateRef.current = { mood, speaking, listening };
  }, [mood, speaking, listening]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || 320;
    const height = container.clientHeight || 225;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.z = 5.2;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    const root = new THREE.Group();
    scene.add(root);

    // Inner holographic "face / neural core" icosahedron
    const coreGeo = new THREE.IcosahedronGeometry(1.15, 2);
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      wireframe: true,
      transparent: true,
      opacity: 0.72,
    });
    const coreMesh = new THREE.Mesh(coreGeo, coreMat);
    root.add(coreMesh);

    // Glowing inner nucleus
    const innerGeo = new THREE.OctahedronGeometry(0.55, 1);
    const innerMat = new THREE.MeshBasicMaterial({
      color: 0x67e8f9,
      wireframe: true,
      transparent: true,
      opacity: 0.9,
    });
    const innerMesh = new THREE.Mesh(innerGeo, innerMat);
    root.add(innerMesh);

    // Three counter-rotating Jarvis gyro rings
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
    });
    const ring1 = new THREE.Mesh(new THREE.RingGeometry(1.52, 1.58, 64), ringMat);
    const ring2 = new THREE.Mesh(new THREE.RingGeometry(1.78, 1.82, 64), ringMat.clone());
    const ring3 = new THREE.Mesh(new THREE.RingGeometry(2.02, 2.05, 48), ringMat.clone());
    ring2.rotation.x = Math.PI / 3;
    ring3.rotation.y = Math.PI / 2.6;
    root.add(ring1, ring2, ring3);

    // Orbital neural particles
    const particleCount = 160;
    const positions = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
      const r = 1.35 + Math.random() * 1.1;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const pMat = new THREE.PointsMaterial({
      color: 0x22d3ee,
      size: 0.045,
      transparent: true,
      opacity: 0.85,
    });
    const particles = new THREE.Points(pGeo, pMat);
    root.add(particles);

    const targetColor = new THREE.Color(0x22d3ee);
    const currentColor = new THREE.Color(0x22d3ee);
    let animId = 0;
    const clock = new THREE.Clock();

    const animate = () => {
      animId = requestAnimationFrame(animate);
      const t = clock.getElapsedTime();
      const { mood: m, speaking: isSpeaking, listening: isListening } = stateRef.current;

      targetColor.setHex(MOOD_COLORS[m] ?? 0x22d3ee);
      currentColor.lerp(targetColor, 0.08);
      coreMat.color.copy(currentColor);
      innerMat.color.copy(currentColor);
      ringMat.color.copy(currentColor);
      (ring2.material as THREE.MeshBasicMaterial).color.copy(currentColor);
      (ring3.material as THREE.MeshBasicMaterial).color.copy(currentColor);
      pMat.color.copy(currentColor);

      // Voice/listening pulse
      const voicePulse = isSpeaking
        ? 1.0 + Math.abs(Math.sin(t * 14.0)) * 0.16 + Math.sin(t * 23.0) * 0.05
        : isListening
          ? 1.08 + Math.sin(t * 7.0) * 0.06
          : 1.0 + Math.sin(t * 2.2) * 0.03;

      coreMesh.scale.setScalar(voicePulse);
      innerMesh.scale.setScalar(0.95 + (voicePulse - 1.0) * 1.6);

      const spinBoost = isSpeaking ? 2.4 : isListening ? 1.8 : 1.0;
      coreMesh.rotation.y += 0.006 * spinBoost;
      coreMesh.rotation.x += 0.003 * spinBoost;
      innerMesh.rotation.y -= 0.015 * spinBoost;
      innerMesh.rotation.z += 0.01 * spinBoost;

      ring1.rotation.z += 0.008 * spinBoost;
      ring1.rotation.x = Math.sin(t * 0.7) * 0.35;
      ring2.rotation.y -= 0.011 * spinBoost;
      ring3.rotation.x += 0.009 * spinBoost;
      particles.rotation.y += 0.0035 * spinBoost;

      renderer.render(scene, camera);
    };

    animate();

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || 320;
      const h = container.clientHeight || 225;
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
    <div style={{ width: "100%", height: "calc(100% - 36px)", position: "relative" }}>
      <div ref={mountRef} style={{ width: "100%", height: "100%" }} />
      <div
        style={{
          position: "absolute",
          bottom: 8,
          left: 12,
          right: 12,
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10,
          letterSpacing: "0.14em",
          color: "#7ea3c4",
          textTransform: "uppercase",
          pointerEvents: "none",
        }}
      >
        <span>STATE: {speaking ? "TRANSMITTING" : listening ? "LISTENING..." : mood}</span>
        <span>NEURAL CORE // v0.1</span>
      </div>
    </div>
  );
};
