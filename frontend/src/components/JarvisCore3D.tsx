import React, { useEffect, useRef } from "react";
import * as THREE from "three";

interface JarvisCore3DProps {
  mood: string; // NOMINAL | CAUTION | COMBAT | HUMOR | CALIBRATING
  speaking: boolean;
  listening: boolean;
  aiName: string;
  audioLevelRef: React.MutableRefObject<number>;
  audioFreqRef: React.MutableRefObject<Uint8Array | null>;
}

const MOOD_COLORS: Record<string, number> = {
  NOMINAL: 0x22d3ee,
  CAUTION: 0xf59e0b,
  COMBAT: 0xef4444,
  HUMOR: 0xa855f7,
  CALIBRATING: 0x38bdf8,
};

const MOOD_CSS: Record<string, string> = {
  NOMINAL: "#22d3ee",
  CAUTION: "#f59e0b",
  COMBAT: "#ef4444",
  HUMOR: "#c084fc",
  CALIBRATING: "#38bdf8",
};

/**
 * Halo Cortana-Style 3D Holographic Humanoid Avatar + Live Sound-Wave Equalizer underneath.
 * Animates eyes (blinking), speaking mouth/jaw, articulated arms/hands, posture, and 28-bar
 * audio waveform driven directly by ElevenLabs Web Audio API AnalyserNode.
 */
export const JarvisCore3D: React.FC<JarvisCore3DProps> = ({
  mood,
  speaking,
  listening,
  aiName,
  audioLevelRef,
  audioFreqRef,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null);
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
    const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 100);
    camera.position.set(0, 0.65, 4.9);
    camera.lookAt(0, 0.45, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    const root = new THREE.Group();
    scene.add(root);

    // Holographic materials (Cortana translucent energy shell + glowing circuit wireframe)
    const holoFillMat = new THREE.MeshBasicMaterial({
      color: 0x0ea5e9,
      transparent: true,
      opacity: 0.24,
    });
    const holoWireMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      wireframe: true,
      transparent: true,
      opacity: 0.62,
    });
    const holoAccentMat = new THREE.MeshBasicMaterial({
      color: 0xe0f2fe,
      transparent: true,
      opacity: 0.95,
    });
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
    });

    const makeHoloPart = (geo: THREE.BufferGeometry): THREE.Group => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(geo, holoFillMat));
      g.add(new THREE.Mesh(geo, holoWireMat));
      return g;
    };

    // === HOLOGRAPHIC PEDESTAL & PROJECTION BEAM ===
    const pedestalRing1 = new THREE.Mesh(new THREE.RingGeometry(1.02, 1.12, 48), ringMat);
    pedestalRing1.rotation.x = Math.PI / 2;
    pedestalRing1.position.y = -0.92;

    const pedestalRing2 = new THREE.Mesh(new THREE.RingGeometry(0.66, 0.72, 48), ringMat.clone());
    pedestalRing2.rotation.x = Math.PI / 2;
    pedestalRing2.position.y = -0.88;

    const beamGeo = new THREE.CylinderGeometry(0.95, 0.68, 1.85, 24, 1, true);
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.06,
      side: THREE.DoubleSide,
    });
    const beamMesh = new THREE.Mesh(beamGeo, beamMat);
    beamMesh.position.y = 0.0;
    root.add(pedestalRing1, pedestalRing2, beamMesh);

    // === CORTANA-STYLE HUMANOID FIGURE ===
    const figure = new THREE.Group();
    root.add(figure);

    // Torso (tapered upper body + chest energy core)
    const torso = makeHoloPart(new THREE.CylinderGeometry(0.44, 0.28, 1.05, 14, 4));
    torso.position.y = 0.1;
    figure.add(torso);

    const chestCore = new THREE.Mesh(new THREE.OctahedronGeometry(0.14, 0), holoAccentMat);
    chestCore.position.set(0, 0.28, 0.36);
    figure.add(chestCore);

    // Shoulder bridge
    const shoulders = makeHoloPart(new THREE.CapsuleGeometry(0.14, 0.82, 6, 12));
    shoulders.rotation.z = Math.PI / 2;
    shoulders.position.y = 0.56;
    figure.add(shoulders);

    // Neck
    const neck = makeHoloPart(new THREE.CylinderGeometry(0.12, 0.14, 0.24, 10));
    neck.position.y = 0.72;
    figure.add(neck);

    // === HEAD & ANIMATED FACE ===
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 1.12, 0);
    figure.add(headGroup);

    const skull = makeHoloPart(new THREE.SphereGeometry(0.36, 18, 14));
    skull.scale.set(0.88, 1.08, 0.94);
    headGroup.add(skull);

    // Cortana holographic hair / crest sweep
    const crest = makeHoloPart(new THREE.SphereGeometry(0.38, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.52));
    crest.scale.set(0.92, 1.06, 0.98);
    crest.position.set(0, 0.03, -0.04);
    headGroup.add(crest);

    // Luminous Eyes (Left & Right)
    const eyeGeo = new THREE.SphereGeometry(0.044, 10, 8);
    const leftEye = new THREE.Mesh(eyeGeo, holoAccentMat);
    leftEye.scale.set(1.3, 0.75, 0.5);
    leftEye.position.set(-0.115, 0.05, 0.31);

    const rightEye = new THREE.Mesh(eyeGeo, holoAccentMat);
    rightEye.scale.set(1.3, 0.75, 0.5);
    rightEye.position.set(0.115, 0.05, 0.31);

    // Subtle brow contour line
    const browGeo = new THREE.BoxGeometry(0.31, 0.014, 0.02);
    const brow = new THREE.Mesh(browGeo, holoWireMat);
    brow.position.set(0, 0.125, 0.32);

    // Animated Speaking Mouth (outer lip ring + dynamic vocal core)
    const mouthGroup = new THREE.Group();
    mouthGroup.position.set(0, -0.11, 0.325);
    const upperLip = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.016, 0.02), holoAccentMat);
    upperLip.position.y = 0.014;
    const lowerLip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.016, 0.02), holoAccentMat);
    lowerLip.position.y = -0.014;
    const mouthGlow = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.05), holoAccentMat);
    mouthGlow.scale.y = 0.15;
    mouthGroup.add(upperLip, lowerLip, mouthGlow);

    headGroup.add(leftEye, rightEye, brow, mouthGroup);

    // === ARTICULATED ARMS (SHOULDER -> UPPER ARM -> ELBOW -> FOREARM -> HAND) ===
    const buildArm = (side: -1 | 1) => {
      const shoulderJoint = new THREE.Group();
      shoulderJoint.position.set(side * 0.52, 0.54, 0);

      const upperArm = makeHoloPart(new THREE.CapsuleGeometry(0.085, 0.44, 5, 10));
      upperArm.position.y = -0.25;
      shoulderJoint.add(upperArm);

      const elbowJoint = new THREE.Group();
      elbowJoint.position.set(0, -0.5, 0);
      shoulderJoint.add(elbowJoint);

      const forearm = makeHoloPart(new THREE.CapsuleGeometry(0.072, 0.42, 5, 10));
      forearm.position.y = -0.22;
      elbowJoint.add(forearm);

      const hand = new THREE.Mesh(new THREE.OctahedronGeometry(0.075, 0), holoAccentMat);
      hand.position.y = -0.46;
      elbowJoint.add(hand);

      figure.add(shoulderJoint);
      return { shoulderJoint, elbowJoint };
    };

    const leftArm = buildArm(-1);
    const rightArm = buildArm(1);

    // Floating holographic data halo & particles
    const haloRing = new THREE.Mesh(new THREE.RingGeometry(1.18, 1.21, 64), ringMat.clone());
    haloRing.position.set(0, 0.55, -0.35);
    root.add(haloRing);

    const particleCount = 110;
    const pPos = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
      const r = 0.75 + Math.random() * 0.95;
      const th = Math.random() * Math.PI * 2;
      pPos[i * 3] = Math.cos(th) * r;
      pPos[i * 3 + 1] = -0.85 + Math.random() * 2.35;
      pPos[i * 3 + 2] = Math.sin(th) * r;
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
    const pMat = new THREE.PointsMaterial({ color: 0x22d3ee, size: 0.036, transparent: true, opacity: 0.78 });
    const particles = new THREE.Points(pGeo, pMat);
    root.add(particles);

    const targetColor = new THREE.Color(0x22d3ee);
    const currentColor = new THREE.Color(0x22d3ee);
    const clock = new THREE.Clock();
    let animId = 0;
    let nextBlink = 2.6;

    const drawSoundWaves = (t: number, amp: number, m: string, isSpeaking: boolean, isListening: boolean) => {
      const canvas = waveCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const cw = canvas.width;
      const ch = canvas.height;
      ctx.clearRect(0, 0, cw, ch);

      const bars = 30;
      const gap = 3;
      const barW = (cw - gap * (bars - 1)) / bars;
      const freq = audioFreqRef.current;
      const color = MOOD_CSS[m] || "#22d3ee";

      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = isSpeaking ? 10 : 4;

      const mid = (bars - 1) / 2;
      for (let i = 0; i < bars; i++) {
        const distFromCenter = Math.abs(i - mid) / mid;
        const envelope = 1.0 - distFromCenter * 0.65;

        let energy = 0.08 + Math.sin(t * 3.0 + i * 0.45) * 0.04;
        if (isSpeaking) {
          if (freq && freq.length > 8 && amp > 0.01) {
            const binIdx = Math.min(freq.length - 1, Math.floor((Math.abs(i - mid) / mid) * 28) + 2);
            energy = Math.max(0.14, (freq[binIdx] / 255) * 0.95 * envelope);
          } else {
            energy = (0.22 + Math.abs(Math.sin(t * 13 + i * 0.7)) * 0.68) * envelope;
          }
        } else if (m === "CALIBRATING") {
          const wave = Math.sin(t * 9 - i * 0.45) * 0.5 + 0.5;
          energy = 0.16 + wave * 0.62 * envelope;
        } else if (isListening) {
          energy = (0.18 + Math.abs(Math.sin(t * 6 + i * 0.5)) * 0.34) * envelope;
        }

        const bh = Math.max(3, energy * (ch - 4));
        const x = i * (barW + gap);
        const y = (ch - bh) / 2;
        ctx.globalAlpha = 0.45 + Math.min(0.55, energy * 0.7);
        ctx.fillRect(x, y, barW, bh);
      }
      ctx.globalAlpha = 1.0;
    };

    const animate = () => {
      animId = requestAnimationFrame(animate);
      const t = clock.getElapsedTime();
      const { mood: m, speaking: isSpeaking, listening: isListening } = stateRef.current;
      const amp = audioLevelRef.current || 0;

      if (m === "CALIBRATING") {
        const mix = (Math.sin(t * 5.0) + 1) * 0.5;
        targetColor.setHex(0xf59e0b).lerp(new THREE.Color(0x22d3ee), mix);
      } else {
        targetColor.setHex(MOOD_COLORS[m] ?? 0x22d3ee);
      }
      currentColor.lerp(targetColor, 0.1);
      holoWireMat.color.copy(currentColor);
      holoFillMat.color.copy(currentColor);
      beamMat.color.copy(currentColor);
      ringMat.color.copy(currentColor);
      (pedestalRing2.material as THREE.MeshBasicMaterial).color.copy(currentColor);
      (haloRing.material as THREE.MeshBasicMaterial).color.copy(currentColor);
      pMat.color.copy(currentColor);

      // Gentle holographic levitation & breathing
      figure.position.y = Math.sin(t * 1.9) * 0.045;
      chestCore.rotation.y += 0.025;
      pedestalRing1.rotation.z += m === "CALIBRATING" ? 0.045 : 0.009;
      pedestalRing2.rotation.z -= m === "CALIBRATING" ? 0.055 : 0.012;
      haloRing.rotation.z += 0.005;
      particles.rotation.y += m === "CALIBRATING" ? 0.02 : 0.004;

      // Natural Eye Blinking
      let eyeScaleY = m === "COMBAT" ? 0.55 : 0.75;
      if (t >= nextBlink) {
        if (t < nextBlink + 0.11) {
          eyeScaleY = 0.08;
        } else {
          nextBlink = t + 2.8 + Math.random() * 2.8;
        }
      }
      leftEye.scale.y = eyeScaleY;
      rightEye.scale.y = eyeScaleY;

      // === ANIMATED MOUTH SYNCED TO SPEECH ===
      const mouthOpen = isSpeaking
        ? amp > 0.01
          ? Math.min(1.0, amp * 1.65)
          : 0.25 + Math.abs(Math.sin(t * 17.0)) * 0.65
        : 0.04;
      upperLip.position.y = 0.012 + mouthOpen * 0.028;
      lowerLip.position.y = -0.012 - mouthOpen * 0.036;
      mouthGlow.scale.y = Math.max(0.08, mouthOpen * 1.35);

      // === HEAD MOTION ===
      if (isSpeaking) {
        headGroup.rotation.y = Math.sin(t * 2.4) * 0.14;
        headGroup.rotation.x = Math.sin(t * 4.2) * 0.06 + mouthOpen * 0.05;
        headGroup.rotation.z = Math.cos(t * 1.8) * 0.05;
      } else if (isListening) {
        headGroup.rotation.y = Math.sin(t * 1.1) * 0.08;
        headGroup.rotation.x = 0.06;
        headGroup.rotation.z = 0.09; // Attentive slight head tilt
      } else if (m === "CALIBRATING") {
        headGroup.rotation.y = Math.sin(t * 2.8) * 0.25;
        headGroup.rotation.x = Math.cos(t * 2.2) * 0.08;
        headGroup.rotation.z = 0;
      } else {
        headGroup.rotation.y = Math.sin(t * 0.65) * 0.1;
        headGroup.rotation.x = Math.sin(t * 0.9) * 0.03;
        headGroup.rotation.z = Math.sin(t * 0.5) * 0.03;
      }

      // === ANIMATED ARMS & HANDS ===
      if (m === "CALIBRATING") {
        // Holographic diagnostic arm sweep
        leftArm.shoulderJoint.rotation.z = -0.58 + Math.sin(t * 3.5) * 0.16;
        leftArm.shoulderJoint.rotation.x = -0.35;
        leftArm.elbowJoint.rotation.x = -0.75 + Math.cos(t * 3.5) * 0.2;

        rightArm.shoulderJoint.rotation.z = 0.58 - Math.sin(t * 3.5) * 0.16;
        rightArm.shoulderJoint.rotation.x = -0.35;
        rightArm.elbowJoint.rotation.x = -0.75 - Math.cos(t * 3.5) * 0.2;
      } else if (isSpeaking) {
        // Expressive Cortana-like conversational hand gestures driven by voice energy
        const g = 0.35 + mouthOpen * 0.55;
        leftArm.shoulderJoint.rotation.z = -0.26 - Math.sin(t * 3.2) * 0.18 * g;
        leftArm.shoulderJoint.rotation.x = -0.42 - Math.cos(t * 2.7) * 0.22 * g;
        leftArm.elbowJoint.rotation.x = -0.88 - Math.sin(t * 4.4) * 0.35 * g;

        rightArm.shoulderJoint.rotation.z = 0.28 + Math.cos(t * 3.6) * 0.22 * g;
        rightArm.shoulderJoint.rotation.x = -0.55 - Math.sin(t * 3.1) * 0.26 * g;
        rightArm.elbowJoint.rotation.x = -0.96 - Math.cos(t * 4.9) * 0.38 * g;
      } else if (isListening) {
        // Attentive listening posture (one hand raised slightly)
        leftArm.shoulderJoint.rotation.z = -0.18;
        leftArm.shoulderJoint.rotation.x = -0.15;
        leftArm.elbowJoint.rotation.x = -0.45;

        rightArm.shoulderJoint.rotation.z = 0.22;
        rightArm.shoulderJoint.rotation.x = -0.55 + Math.sin(t * 2.5) * 0.05;
        rightArm.elbowJoint.rotation.x = -1.15;
      } else if (m === "COMBAT") {
        // Alert tactical posture
        leftArm.shoulderJoint.rotation.z = -0.32;
        leftArm.shoulderJoint.rotation.x = -0.35;
        leftArm.elbowJoint.rotation.x = -0.95;

        rightArm.shoulderJoint.rotation.z = 0.32;
        rightArm.shoulderJoint.rotation.x = -0.35;
        rightArm.elbowJoint.rotation.x = -0.95;
      } else {
        // Calm idle breathing sway
        leftArm.shoulderJoint.rotation.z = -0.16 + Math.sin(t * 1.4) * 0.04;
        leftArm.shoulderJoint.rotation.x = -0.12 + Math.cos(t * 1.1) * 0.04;
        leftArm.elbowJoint.rotation.x = -0.42 + Math.sin(t * 1.2) * 0.06;

        rightArm.shoulderJoint.rotation.z = 0.16 - Math.sin(t * 1.4) * 0.04;
        rightArm.shoulderJoint.rotation.x = -0.14 - Math.cos(t * 1.1) * 0.04;
        rightArm.elbowJoint.rotation.x = -0.48 - Math.sin(t * 1.2) * 0.06;
      }

      renderer.render(scene, camera);
      drawSoundWaves(t, amp, m, isSpeaking, isListening);
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
      <div ref={mountRef} style={{ width: "100%", height: "calc(100% - 34px)" }} />

      {/* Live Sound-Wave Equalizer Bar underneath the Cortana Hologram */}
      <div
        style={{
          position: "absolute",
          bottom: 18,
          left: 16,
          right: 16,
          height: 26,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <canvas ref={waveCanvasRef} width={280} height={26} style={{ width: "100%", height: 26 }} />
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 4,
          left: 12,
          right: 12,
          display: "flex",
          justifyContent: "space-between",
          fontSize: 9.5,
          letterSpacing: "0.14em",
          color: "#7ea3c4",
          textTransform: "uppercase",
          pointerEvents: "none",
        }}
      >
        <span>
          {aiName.toUpperCase()} //{" "}
          {mood === "CALIBRATING" ? "CALIBRATING" : speaking ? "SPEAKING" : listening ? "LISTENING" : mood}
        </span>
        <span>HOLO-AVATAR v0.3</span>
      </div>
    </div>
  );
};
