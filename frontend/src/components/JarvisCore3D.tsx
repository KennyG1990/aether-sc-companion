import React, { useEffect, useRef } from "react";
import * as THREE from "three";

interface JarvisCore3DProps {
  mood: string; // CALM | HAPPY | PLAYFUL | CURIOUS | FOCUSED | ALERT | SOLEMN | CALIBRATING (+ NOMINAL/HUMOR/CAUTION/COMBAT aliases)
  speaking: boolean;
  listening: boolean;
  audioLevelRef: React.MutableRefObject<number>;
  audioFreqRef: React.MutableRefObject<Uint8Array | null>;
  showReflection?: boolean;
}

const MOOD_PALETTES: Record<string, { primary: number; rim: number; pace: number }> = {
  CALM: { primary: 0x14b8a6, rim: 0x5eead4, pace: 1.0 },
  NOMINAL: { primary: 0x14b8a6, rim: 0x5eead4, pace: 1.0 },
  HAPPY: { primary: 0x10b981, rim: 0x6ee7b7, pace: 1.25 },
  PLAYFUL: { primary: 0x8b5cf6, rim: 0xd8b4fe, pace: 1.38 },
  HUMOR: { primary: 0x8b5cf6, rim: 0xd8b4fe, pace: 1.38 },
  CURIOUS: { primary: 0x2563eb, rim: 0x7dd3fc, pace: 1.15 },
  FOCUSED: { primary: 0xd97706, rim: 0xfcd34d, pace: 1.08 },
  CAUTION: { primary: 0xd97706, rim: 0xfcd34d, pace: 1.08 },
  ALERT: { primary: 0xdc2626, rim: 0xfca5a5, pace: 1.55 },
  COMBAT: { primary: 0xdc2626, rim: 0xfca5a5, pace: 1.55 },
  SOLEMN: { primary: 0x4f46e5, rim: 0xa5b4fc, pace: 0.72 },
  CALIBRATING: { primary: 0x0ea5e9, rim: 0x67e8f9, pace: 2.2 },
};

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
  float bubble1 = snoise(dir * 2.15 + vec3(uTime * 0.42 + uLayerOffset, -uTime * 0.34, uTime * 0.28));
  float bubble2 = snoise(dir * 4.4 - vec3(uTime * 0.65, uTime * 0.52 + uLayerOffset, -uTime * 0.41));
  float idleWave = bubble1 * 0.095 + bubble2 * 0.036;

  float angleWave = sin(atan(dir.y, dir.x) * 9.0 + uTime * 11.0 + uLayerOffset * 2.0) *
                    cos(dir.z * 6.0 - uTime * 7.5);
  float rimVibration = angleWave * (0.014 + uMid * 0.09 + uTreble * 0.06);

  float focus1 = pow(max(0.0, dot(dir, normalize(uSpikeDir1))), 5.0);
  float focus2 = pow(max(0.0, dot(dir, normalize(uSpikeDir2))), 6.0);
  float fineRipple = 0.65 + 0.35 * snoise(dir * 7.5 + vec3(uTime * 3.8));
  float localizedSpike = (focus1 * (0.36 * uVoiceAmp + 0.16 * uBass) +
                          focus2 * (0.26 * uVoiceAmp + 0.14 * uTreble)) * fineRipple;

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

  float fresnel = pow(1.0 - ndotv, uRimPower);
  float innerMist = pow(1.0 - ndotv, 1.45) * 0.16;

  float grain = hash31(floor(vLocalDir * 68.0 + vec3(floor(uTime * 4.0) * 0.13)));
  float stipple = mix(0.76, 1.26, grain);

  float spikeGlow = smoothstep(0.04, 0.24, vDisp) * (0.45 + uVoiceAmp * 0.78);

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
 * Floating Bioluminescent Bubbling Acoustic Orb with optional live blurred obsidian-floor reflection.
 */
export const JarvisCore3D: React.FC<JarvisCore3DProps> = ({
  mood,
  speaking,
  listening,
  audioLevelRef,
  audioFreqRef,
  showReflection = false,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const reflectCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef({ mood, speaking, listening });

  useEffect(() => {
    stateRef.current = { mood, speaking, listening };
  }, [mood, speaking, listening]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || 380;
    const height = container.clientHeight || 380;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
    camera.position.set(0, 0, 4.35);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: showReflection,
    });
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

    const outerUniforms = makeMembraneUniforms(0.0, 0.96, 2.85, 1.0);
    const outerShell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.42, 6),
      new THREE.ShaderMaterial({
        uniforms: outerUniforms,
        vertexShader: MEMBRANE_VERT,
        fragmentShader: MEMBRANE_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      })
    );
    root.add(outerShell);

    const innerMemUniforms = makeMembraneUniforms(2.4, 0.72, 3.1, 0.85);
    const innerMemShell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.25, 5),
      new THREE.ShaderMaterial({
        uniforms: innerMemUniforms,
        vertexShader: MEMBRANE_VERT,
        fragmentShader: MEMBRANE_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      })
    );
    root.add(innerMemShell);

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
      const phi = Math.acos(1 - (2 * (i + 0.5)) / crustCount);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const r = 1.42 + (Math.random() - 0.5) * 0.03;
      crustPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      crustPositions[i * 3 + 1] = r * Math.cos(phi);
      crustPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const crustGeo = new THREE.BufferGeometry();
    crustGeo.setAttribute("position", new THREE.BufferAttribute(crustPositions, 3));
    const crustPoints = new THREE.Points(
      crustGeo,
      new THREE.ShaderMaterial({
        uniforms: crustUniforms,
        vertexShader: RIM_PARTICLE_VERT,
        fragmentShader: RIM_PARTICLE_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    root.add(crustPoints);

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
    root.add(new THREE.LineLoop(scallopGeo, scallopMat));

    const haloCircleMat = new THREE.MeshBasicMaterial({
      color: 0x2dd4bf,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    root.add(new THREE.Mesh(new THREE.RingGeometry(0.84, 0.855, 72), haloCircleMat));

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
    coreGroup.add(new THREE.Points(coreDotsGeo, coreDotsMat));

    const coreRimMat = new THREE.MeshBasicMaterial({
      color: 0x5eead4,
      transparent: true,
      opacity: 0.58,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const coreRim = new THREE.Mesh(new THREE.RingGeometry(coreRadius - 0.014, coreRadius + 0.01, 64), coreRimMat);
    root.add(coreRim);

    const ambCount = 70;
    const ambPos = new Float32Array(ambCount * 3);
    for (let i = 0; i < ambCount; i++) {
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
      size: 0.024,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const ambientSparks = new THREE.Points(ambGeo, ambMat);
    root.add(ambientSparks);

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
    let frameCount = 0;

    const animate = () => {
      animId = requestAnimationFrame(animate);
      frameCount++;
      const t = clock.getElapsedTime();
      const { mood: m, speaking: isSpeaking, listening: isListening } = stateRef.current;

      const pal = MOOD_PALETTES[m] || MOOD_PALETTES.CALM;
      targetPrimary.setHex(pal.primary);
      targetRim.setHex(pal.rim);
      if (m === "CALIBRATING") {
        const sweep = (Math.sin(t * 4.5) + 1) * 0.5;
        targetRim.lerp(new THREE.Color(0xfbbf24), sweep * 0.55);
      }
      // Smooth, unhurried emotional color glide (~2s organic shift across orb + reflection)
      primaryColor.lerp(targetPrimary, 0.025);
      rimColor.lerp(targetRim, 0.025);

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

      const wanderSpeed = isSpeaking ? 1.85 + smoothAmp * 2.6 : 0.35;
      spikeAngle1 += 0.016 * wanderSpeed;
      spikeAngle2 -= 0.021 * wanderSpeed;
      spikeDir1.set(Math.cos(spikeAngle1), Math.sin(spikeAngle1), Math.sin(t * 1.4) * 0.28).normalize();
      spikeDir2.set(Math.cos(spikeAngle2), Math.sin(spikeAngle2), Math.cos(t * 1.7) * 0.28).normalize();

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

      const moodPace = (MOOD_PALETTES[m] || MOOD_PALETTES.CALM).pace;
      const rotBoost = (m === "CALIBRATING" ? 2.4 : isSpeaking ? 1.45 : 1.0) * moodPace;
      // Gentle levitation float
      root.position.y = Math.sin(t * 1.45 * Math.min(1.3, moodPace)) * 0.06;
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

      // Gently mirror the live rendered orb onto the glossy dark obsidian floor underneath
      if (showReflection && reflectCanvasRef.current && frameCount % 2 === 0) {
        const rCanvas = reflectCanvasRef.current;
        const rCtx = rCanvas.getContext("2d");
        if (rCtx) {
          const rw = rCanvas.width;
          const rh = rCanvas.height;
          const destH = Math.round(rh * 1.48);
          const originY = Math.round(destH * 0.87 + 4);
          rCtx.clearRect(0, 0, rw, rh);
          rCtx.save();
          rCtx.translate(0, originY);
          rCtx.scale(1, -1);
          rCtx.globalAlpha = 0.72;
          rCtx.drawImage(renderer.domElement, 0, 0, rw, destH);
          rCtx.restore();
        }
      }
    };

    animate();

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || 380;
      const h = container.clientHeight || 380;
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
  }, [showReflection]);

  if (!showReflection) {
    return <div ref={mountRef} style={{ width: "100%", height: "100%" }} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%" }}>
      <div className="orb-hero-wrap">
        <div ref={mountRef} style={{ width: "100%", height: "100%" }} />
      </div>
      <div className="orb-reflection-floor">
        <div className="orb-floor-sheen" />
        <canvas
          ref={reflectCanvasRef}
          width={420}
          height={132}
          style={{ width: "100%", height: "100%", filter: "blur(2.6px)" }}
        />
      </div>
    </div>
  );
};
