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

const MOOD_PALETTES: Record<string, { primary: number; rim: number; bg: string }> = {
  NOMINAL: { primary: 0x14b8a6, rim: 0x5eead4, bg: "radial-gradient(circle at 50% 48%, rgba(20,184,166,0.22) 0%, rgba(4,16,22,0.92) 66%, rgba(2,8,14,1) 100%)" },
  CAUTION: { primary: 0xd97706, rim: 0xfcd34d, bg: "radial-gradient(circle at 50% 48%, rgba(245,158,11,0.22) 0%, rgba(20,14,6,0.92) 66%, rgba(8,6,4,1) 100%)" },
  COMBAT: { primary: 0xdc2626, rim: 0xfca5a5, bg: "radial-gradient(circle at 50% 48%, rgba(239,68,68,0.24) 0%, rgba(24,6,10,0.92) 66%, rgba(10,3,5,1) 100%)" },
  HUMOR: { primary: 0x9333ea, rim: 0xd8b4fe, bg: "radial-gradient(circle at 50% 48%, rgba(168,85,247,0.22) 0%, rgba(16,8,28,0.92) 66%, rgba(6,4,14,1) 100%)" },
  CALIBRATING: { primary: 0x0ea5e9, rim: 0x67e8f9, bg: "radial-gradient(circle at 50% 48%, rgba(56,189,248,0.24) 0%, rgba(4,16,28,0.92) 66%, rgba(2,8,16,1) 100%)" },
};

// Shared 3D Ashima simplex noise + harmonic acoustic wave displacement GLSL snippet
const NOISE_GLSL = /* glsl */ `
vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}

float snoise(vec3 v){
  const vec2  C = vec2(1.0/6.0, 1.0/3.0);
  const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod(i, 289.0);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0/7.0;
  vec3  ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy,h.x);
  vec3 p1 = vec3(a0.zw,h.y);
  vec3 p2 = vec3(a1.xy,h.z);
  vec3 p3 = vec3(a1.zw,h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

float computeOrbDisplacement(
  vec3 dir,
  float uTime,
  float uVoiceAmp,
  float uBass,
  float uMid,
  float uTreble,
  vec3 uSpikeDir1,
  vec3 uSpikeDir2,
  float uLayerOffset
) {
  // 1. Organic bubbling waves going smoothly in and out
  float bubble1 = snoise(dir * 2.15 + vec3(uTime * 0.42 + uLayerOffset, -uTime * 0.34, uTime * 0.28));
  float bubble2 = snoise(dir * 4.4 - vec3(uTime * 0.65, uTime * 0.52 + uLayerOffset, -uTime * 0.41));
  float idleWave = bubble1 * 0.095 + bubble2 * 0.036;

  // 2. Traveling exterior sound-wave ripple across the rim when talking
  float angleWave = sin(atan(dir.y, dir.x) * 9.0 + uTime * 11.0 + uLayerOffset * 2.0) *
                    cos(dir.z * 6.0 - uTime * 7.5);
  float rimVibration = angleWave * (0.015 + uMid * 0.085 + uTreble * 0.055);

  // 3. Localized vocal spikes erupting outward at dynamic focal locations while speaking
  float focus1 = pow(max(0.0, dot(dir, normalize(uSpikeDir1))), 5.0);
  float focus2 = pow(max(0.0, dot(dir, normalize(uSpikeDir2))), 6.0);
  float fineRipple = 0.65 + 0.35 * snoise(dir * 7.5 + vec3(uTime * 3.8));
  float localizedSpike = (focus1 * (0.34 * uVoiceAmp + 0.14 * uBass) +
                          focus2 * (0.24 * uVoiceAmp + 0.12 * uTreble)) * fineRipple;

  return idleWave * (1.0 + uVoiceAmp * 0.65) + rimVibration + localizedSpike;
}
`;

const MEMBRANE_VERT = /* glsl */ `
uniform float uTime;
uniform float uVoiceAmp;
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform vec3 uSpikeDir1;
uniform vec3 uSpikeDir2;
uniform float uLayerOffset;
uniform float uDispScale;

varying vec3 vNormalView;
varying vec3 vViewPos;
varying float vDisp;
varying vec3 vLocalDir;

${NOISE_GLSL}

void main() {
  vec3 dir = normalize(position);
  float disp = computeOrbDisplacement(
    dir, uTime, uVoiceAmp, uBass, uMid, uTreble, uSpikeDir1, uSpikeDir2, uLayerOffset
  ) * uDispScale;

  // Approximate perturbed normal via finite differences along tangent frame for crisp Fresnel contour
  vec3 up = abs(dir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t1 = normalize(cross(up, dir));
  vec3 t2 = cross(dir, t1);
  float eps = 0.045;
  vec3 d1 = normalize(dir + t1 * eps);
  vec3 d2 = normalize(dir + t2 * eps);
  float disp1 = computeOrbDisplacement(d1, uTime, uVoiceAmp, uBass, uMid, uTreble, uSpikeDir1, uSpikeDir2, uLayerOffset) * uDispScale;
  float disp2 = computeOrbDisplacement(d2, uTime, uVoiceAmp, uBass, uMid, uTreble, uSpikeDir1, uSpikeDir2, uLayerOffset) * uDispScale;

  vec3 p0 = dir * (length(position) + disp);
  vec3 p1 = d1 * (length(position) + disp1);
  vec3 p2 = d2 * (length(position) + disp2);
  vec3 perturbedNormal = normalize(cross(p1 - p0, p2 - p0));
  if (dot(perturbedNormal, dir) < 0.0) perturbedNormal = -perturbedNormal;

  vDisp = disp;
  vLocalDir = dir;
  vNormalView = normalize(normalMatrix * perturbedNormal);
  vec4 mvPos = modelViewMatrix * vec4(p0, 1.0);
  vViewPos = -mvPos.xyz;
  gl_Position = projectionMatrix * mvPos;
}
`;

const MEMBRANE_FRAG = /* glsl */ `
uniform vec3 uPrimaryColor;
uniform vec3 uRimColor;
uniform float uOpacity;
uniform float uRimPower;
uniform float uTime;
uniform float uVoiceAmp;

varying vec3 vNormalView;
varying vec3 vViewPos;
varying float vDisp;
varying vec3 vLocalDir;

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 V = normalize(vViewPos);
  vec3 N = normalize(vNormalView);
  float ndotv = abs(dot(N, V));

  // Razor-luminous exterior contour with transparent misty interior
  float fresnel = pow(1.0 - ndotv, uRimPower);
  float innerMist = pow(1.0 - ndotv, 1.4) * 0.18;

  // Fine holographic stipple grain along the membrane silhouette (matching reference texture)
  float grain = hash31(floor(vLocalDir * 68.0 + vec3(floor(uTime * 4.0) * 0.13)));
  float stipple = mix(0.76, 1.26, grain);

  // Brighten spikes where sound waves push outward
  float spikeGlow = smoothstep(0.04, 0.24, vDisp) * (0.45 + uVoiceAmp * 0.75);

  vec3 col = mix(uPrimaryColor, uRimColor, clamp(fresnel * 1.15 + spikeGlow, 0.0, 1.0));
  float alpha = clamp((fresnel * 0.95 + innerMist + spikeGlow * 0.35) * stipple * uOpacity, 0.0, 1.0);
  gl_FragColor = vec4(col * (1.0 + spikeGlow * 0.6), alpha);
}
`;

const RIM_PARTICLE_VERT = /* glsl */ `
uniform float uTime;
uniform float uVoiceAmp;
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform vec3 uSpikeDir1;
uniform vec3 uSpikeDir2;
uniform float uLayerOffset;

varying float vRim;
varying float vSpark;

${NOISE_GLSL}

void main() {
  vec3 dir = normalize(position);
  float disp = computeOrbDisplacement(
    dir, uTime, uVoiceAmp, uBass, uMid, uTreble, uSpikeDir1, uSpikeDir2, uLayerOffset
  );
  vec3 displaced = dir * (length(position) + disp);
  vec4 mvPos = modelViewMatrix * vec4(displaced, 1.0);
  vec3 viewDir = normalize(-mvPos.xyz);
  vec3 normView = normalize(normalMatrix * dir);
  vRim = pow(1.0 - abs(dot(normView, viewDir)), 1.9);
  vSpark = smoothstep(0.03, 0.22, disp);

  gl_PointSize = (1.5 + vRim * 2.4 + vSpark * 2.6) * (3.8 / max(1.0, -mvPos.z));
  gl_Position = projectionMatrix * mvPos;
}
`;

const RIM_PARTICLE_FRAG = /* glsl */ `
uniform vec3 uRimColor;
varying float vRim;
varying float vSpark;

void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  if (d > 0.5) discard;
  float soft = smoothstep(0.5, 0.05, d);
  float alpha = soft * (0.14 + vRim * 0.72 + vSpark * 0.35);
  gl_FragColor = vec4(uRimColor * (1.1 + vSpark * 0.5), clamp(alpha, 0.0, 0.95));
}
`;

/**
 * Bioluminescent Bubbling Acoustic Orb AI Core (inspired by user's uploaded teal energy orb):
 * - Dual Fresnel bubbling outer energy membranes + matching stippled particle shell
 * - Localized vocal spike eruptions & rim sound-wave vibrations synced to ElevenLabs Web Audio FFT
 * - Delicate middle scalloped wave-petal halo
 * - Inner rotating latitude/longitude dotted core sphere
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
  const stateRef = useRef({ mood, speaking, listening });

  useEffect(() => {
    stateRef.current = { mood, speaking, listening };
  }, [mood, speaking, listening]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || 320;
    const height = container.clientHeight || 260;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
    camera.position.set(0, 0, 4.35);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    const root = new THREE.Group();
    scene.add(root);

    const primaryColor = new THREE.Color(0x14b8a6);
    const rimColor = new THREE.Color(0x5eead4);
    const targetPrimary = new THREE.Color(0x14b8a6);
    const targetRim = new THREE.Color(0x5eead4);

    // Shared reactive shader uniforms
    const makeMembraneUniforms = (layerOffset: number, opacity: number, rimPower: number, dispScale: number) => ({
      uTime: { value: 0 },
      uVoiceAmp: { value: 0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uTreble: { value: 0 },
      uSpikeDir1: { value: new THREE.Vector3(0.85, 0.4, 0.25).normalize() },
      uSpikeDir2: { value: new THREE.Vector3(-0.7, -0.55, 0.35).normalize() },
      uLayerOffset: { value: layerOffset },
      uDispScale: { value: dispScale },
      uPrimaryColor: { value: primaryColor.clone() },
      uRimColor: { value: rimColor.clone() },
      uOpacity: { value: opacity },
      uRimPower: { value: rimPower },
    });

    // === 1. OUTER BUBBLING ACOUSTIC MEMBRANE ===
    const outerUniforms = makeMembraneUniforms(0.0, 0.96, 2.85, 1.0);
    const outerGeo = new THREE.IcosahedronGeometry(1.42, 6);
    const outerMat = new THREE.ShaderMaterial({
      uniforms: outerUniforms,
      vertexShader: MEMBRANE_VERT,
      fragmentShader: MEMBRANE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const outerShell = new THREE.Mesh(outerGeo, outerMat);
    root.add(outerShell);

    // === 2. SECONDARY NESTED FLUID MEMBRANE (double-rim wave look from reference) ===
    const innerMemUniforms = makeMembraneUniforms(2.4, 0.72, 3.1, 0.85);
    const innerMemGeo = new THREE.IcosahedronGeometry(1.25, 5);
    const innerMemMat = new THREE.ShaderMaterial({
      uniforms: innerMemUniforms,
      vertexShader: MEMBRANE_VERT,
      fragmentShader: MEMBRANE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const innerMemShell = new THREE.Mesh(innerMemGeo, innerMemMat);
    root.add(innerMemShell);

    // === 3. STIPPLED LUMINOUS PARTICLE CRUST ALONG THE OUTER RIM ===
    const crustUniforms = {
      uTime: { value: 0 },
      uVoiceAmp: { value: 0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uTreble: { value: 0 },
      uSpikeDir1: { value: new THREE.Vector3(0.85, 0.4, 0.25).normalize() },
      uSpikeDir2: { value: new THREE.Vector3(-0.7, -0.55, 0.35).normalize() },
      uLayerOffset: { value: 0.0 },
      uRimColor: { value: rimColor.clone() },
    };
    const crustCount = 1600;
    const crustPositions = new Float32Array(crustCount * 3);
    for (let i = 0; i < crustCount; i++) {
      // Fibonacci sphere distribution for smooth stipple crust
      const phi = Math.acos(1 - (2 * (i + 0.5)) / crustCount);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const r = 1.42 + (Math.random() - 0.5) * 0.03;
      crustPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      crustPositions[i * 3 + 1] = r * Math.cos(phi);
      crustPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const crustGeo = new THREE.BufferGeometry();
    crustGeo.setAttribute("position", new THREE.BufferAttribute(crustPositions, 3));
    const crustMat = new THREE.ShaderMaterial({
      uniforms: crustUniforms,
      vertexShader: RIM_PARTICLE_VERT,
      fragmentShader: RIM_PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const crustPoints = new THREE.Points(crustGeo, crustMat);
    root.add(crustPoints);

    // === 4. MIDDLE SCALLOPED WAVE-PETAL HALO RING ===
    const scallopSegments = 180;
    const scallopPts = new Float32Array((scallopSegments + 1) * 3);
    const scallopGeo = new THREE.BufferGeometry();
    scallopGeo.setAttribute("position", new THREE.BufferAttribute(scallopPts, 3));
    const scallopMat = new THREE.LineBasicMaterial({
      color: 0x2dd4bf,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
    });
    const scallopRing = new THREE.LineLoop(scallopGeo, scallopMat);
    root.add(scallopRing);

    const haloCircleGeo = new THREE.RingGeometry(0.84, 0.855, 72);
    const haloCircleMat = new THREE.MeshBasicMaterial({
      color: 0x2dd4bf,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const haloCircle = new THREE.Mesh(haloCircleGeo, haloCircleMat);
    root.add(haloCircle);

    // === 5. INNER DOTTED MERIDIAN CORE SPHERE (exact dotted globe center) ===
    const coreGroup = new THREE.Group();
    root.add(coreGroup);

    const coreDotPositions: number[] = [];
    const latRings = 11;
    const coreRadius = 0.52;
    for (let li = 1; li < latRings; li++) {
      const phi = (li / latRings) * Math.PI;
      const ringR = Math.sin(phi) * coreRadius;
      const y = Math.cos(phi) * coreRadius;
      const dotsInRing = Math.max(8, Math.round(28 * Math.sin(phi)));
      for (let di = 0; di < dotsInRing; di++) {
        const th = (di / dotsInRing) * Math.PI * 2;
        coreDotPositions.push(ringR * Math.cos(th), y, ringR * Math.sin(th));
      }
    }
    const coreDotsGeo = new THREE.BufferGeometry();
    coreDotsGeo.setAttribute("position", new THREE.Float32BufferAttribute(coreDotPositions, 3));
    const coreDotsMat = new THREE.PointsMaterial({
      color: 0x5eead4,
      size: 0.036,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const coreDots = new THREE.Points(coreDotsGeo, coreDotsMat);
    coreGroup.add(coreDots);

    // Crisp luminous inner core rim ring
    const coreRimGeo = new THREE.RingGeometry(coreRadius - 0.014, coreRadius + 0.01, 64);
    const coreRimMat = new THREE.MeshBasicMaterial({
      color: 0x5eead4,
      transparent: true,
      opacity: 0.58,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const coreRim = new THREE.Mesh(coreRimGeo, coreRimMat);
    root.add(coreRim);

    // Subtle dark-teal inner glass sphere for depth
    const coreTint = new THREE.Mesh(
      new THREE.SphereGeometry(coreRadius - 0.01, 24, 24),
      new THREE.MeshBasicMaterial({
        color: 0x0d9488,
        transparent: true,
        opacity: 0.14,
        depthWrite: false,
      })
    );
    coreGroup.add(coreTint);

    // === 6. AMBIENT FLOATING ATMOSPHERIC SPARKS ===
    const ambientCount = 75;
    const ambPos = new Float32Array(ambientCount * 3);
    for (let i = 0; i < ambientCount; i++) {
      const r = 1.55 + Math.random() * 1.15;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      ambPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      ambPos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
      ambPos[i * 3 + 2] = r * Math.cos(ph);
    }
    const ambGeo = new THREE.BufferGeometry();
    ambGeo.setAttribute("position", new THREE.BufferAttribute(ambPos, 3));
    const ambMat = new THREE.PointsMaterial({
      color: 0x5eead4,
      size: 0.025,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const ambientSparks = new THREE.Points(ambGeo, ambMat);
    root.add(ambientSparks);

    // Smooth animation state for audio reactivity & wandering spike focal locations
    let smoothAmp = 0;
    let smoothBass = 0;
    let smoothMid = 0;
    let smoothTreble = 0;
    let spikeAngle1 = 0.7;
    let spikeAngle2 = 3.8;
    const spikeDir1 = new THREE.Vector3(1, 0, 0);
    const spikeDir2 = new THREE.Vector3(-1, 0, 0);

    const clock = new THREE.Clock();
    let animId = 0;

    const animate = () => {
      animId = requestAnimationFrame(animate);
      const t = clock.getElapsedTime();
      const { mood: m, speaking: isSpeaking, listening: isListening } = stateRef.current;

      // Update palette colors smoothly by mood
      const pal = MOOD_PALETTES[m] || MOOD_PALETTES.NOMINAL;
      targetPrimary.setHex(pal.primary);
      targetRim.setHex(pal.rim);
      if (m === "CALIBRATING") {
        const sweep = (Math.sin(t * 4.5) + 1) * 0.5;
        targetRim.lerp(new THREE.Color(0xfbbf24), sweep * 0.55);
      }
      primaryColor.lerp(targetPrimary, 0.08);
      rimColor.lerp(targetRim, 0.08);

      // Extract real bass / mid / treble energy from ElevenLabs AnalyserNode (or clean fallback when speaking)
      let rawAmp = audioLevelRef.current || 0;
      let rawBass = 0;
      let rawMid = 0;
      let rawTreble = 0;
      const freq = audioFreqRef.current;

      if (isSpeaking && freq && freq.length >= 32 && rawAmp > 0.008) {
        let bSum = 0;
        let mSum = 0;
        let tSum = 0;
        for (let i = 1; i < 8; i++) bSum += freq[i];
        for (let i = 8; i < 24; i++) mSum += freq[i];
        for (let i = 24; i < 48 && i < freq.length; i++) tSum += freq[i];
        rawBass = Math.min(1.0, (bSum / (7 * 255)) * 1.45);
        rawMid = Math.min(1.0, (mSum / (16 * 255)) * 1.65);
        rawTreble = Math.min(1.0, (tSum / (24 * 255)) * 1.9);
      } else if (isSpeaking) {
        // Fallback harmonic speech envelope if browser speechSynthesis is used
        rawAmp = 0.35 + Math.abs(Math.sin(t * 11.5)) * 0.45;
        rawBass = 0.3 + Math.abs(Math.sin(t * 7.2)) * 0.4;
        rawMid = 0.35 + Math.abs(Math.cos(t * 14.3)) * 0.45;
        rawTreble = 0.25 + Math.abs(Math.sin(t * 19.0)) * 0.35;
      } else if (m === "CALIBRATING") {
        rawAmp = 0.28 + Math.sin(t * 6.0) * 0.14;
        rawMid = 0.35;
      } else if (isListening) {
        rawAmp = 0.14 + Math.sin(t * 4.5) * 0.06;
        rawMid = 0.18;
      }

      smoothAmp += (rawAmp - smoothAmp) * 0.22;
      smoothBass += (rawBass - smoothBass) * 0.22;
      smoothMid += (rawMid - smoothMid) * 0.22;
      smoothTreble += (rawTreble - smoothTreble) * 0.22;

      // Move localized speech spike focal points dynamically around the exterior silhouette!
      const wanderSpeed = isSpeaking ? 1.85 + smoothAmp * 2.6 : 0.35;
      spikeAngle1 += 0.016 * wanderSpeed;
      spikeAngle2 -= 0.021 * wanderSpeed;
      spikeDir1.set(Math.cos(spikeAngle1), Math.sin(spikeAngle1), Math.sin(t * 1.4) * 0.28).normalize();
      spikeDir2.set(Math.cos(spikeAngle2), Math.sin(spikeAngle2), Math.cos(t * 1.7) * 0.28).normalize();

      // Update uniforms across outer membrane, nested membrane, and stipple crust
      const updateUniforms = (u: any) => {
        u.uTime.value = t;
        u.uVoiceAmp.value = smoothAmp;
        u.uBass.value = smoothBass;
        u.uMid.value = smoothMid;
        u.uTreble.value = smoothTreble;
        u.uSpikeDir1.value.copy(spikeDir1);
        u.uSpikeDir2.value.copy(spikeDir2);
        if (u.uPrimaryColor) u.uPrimaryColor.value.copy(primaryColor);
        u.uRimColor.value.copy(rimColor);
      };
      updateUniforms(outerUniforms);
      updateUniforms(innerMemUniforms);
      updateUniforms(crustUniforms);

      // Update scalloped wave-petal middle ring dynamically
      const posAttr = scallopGeo.attributes.position as THREE.BufferAttribute;
      const arr = posAttr.array as Float32Array;
      for (let i = 0; i <= scallopSegments; i++) {
        const a = (i / scallopSegments) * Math.PI * 2;
        const petals = Math.abs(Math.sin(a * 6.0 + t * 0.45)) * (0.075 + smoothMid * 0.09);
        const r = 0.72 + petals;
        arr[i * 3] = Math.cos(a) * r;
        arr[i * 3 + 1] = Math.sin(a) * r;
        arr[i * 3 + 2] = 0;
      }
      posAttr.needsUpdate = true;
      scallopMat.color.copy(rimColor);
      scallopMat.opacity = 0.22 + smoothAmp * 0.35;
      haloCircleMat.color.copy(primaryColor);
      coreDotsMat.color.copy(rimColor);
      coreRimMat.color.copy(rimColor);
      ambMat.color.copy(rimColor);

      // Smooth organic rotation of the bubbling orb & inner dotted globe
      const rotBoost = m === "CALIBRATING" ? 2.6 : isSpeaking ? 1.45 : 1.0;
      outerShell.rotation.y += 0.0028 * rotBoost;
      outerShell.rotation.x = Math.sin(t * 0.35) * 0.14;
      innerMemShell.rotation.y -= 0.0038 * rotBoost;
      innerMemShell.rotation.z += 0.002 * rotBoost;
      crustPoints.rotation.y = outerShell.rotation.y;
      crustPoints.rotation.x = outerShell.rotation.x;

      coreGroup.rotation.y += 0.0085 * rotBoost;
      coreGroup.rotation.x = Math.sin(t * 0.5) * 0.22;
      const coreBreath = 1.0 + Math.sin(t * 2.4) * 0.025 + smoothBass * 0.08;
      coreGroup.scale.setScalar(coreBreath);
      coreRim.scale.setScalar(coreBreath);
      ambientSparks.rotation.y -= 0.0018;

      renderer.render(scene, camera);
    };

    animate();

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || 320;
      const h = container.clientHeight || 260;
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

  const palette = MOOD_PALETTES[mood] || MOOD_PALETTES.NOMINAL;

  return (
    <div
      style={{
        width: "100%",
        height: "calc(100% - 36px)",
        position: "relative",
        background: palette.bg,
        overflow: "hidden",
      }}
    >
      <div ref={mountRef} style={{ width: "100%", height: "100%" }} />
      <div
        style={{
          position: "absolute",
          bottom: 6,
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
        <span>ACOUSTIC CORE</span>
      </div>
    </div>
  );
};
