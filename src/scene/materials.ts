// Materials for the sculpture: liquid chrome, brushed keel, prism glass (transmission + cheap fallback),
// core emissive, shockwave. All of them read a single shared uniform set updated once per frame by Stage.
import {
  AdditiveBlending,
  BackSide,
  Color,
  DataTexture,
  DoubleSide,
  FrontSide,
  LinearFilter,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector4,
  type IUniform,
} from 'three';
import { ACCENT_STOPS } from '../shared/params';
import { PALETTE } from '../config';
import { applyInjections, injectionKey, type InjectionOptions } from './shaders/injections';
import { valueNoise2D } from './shaders/noise';
import { clamp } from '../shared/math';

export interface SceneUniforms {
  uTime: IUniform<number>;
  uTwist: IUniform<number>;
  uLiquidAmp: IUniform<number>;
  uBreath: IUniform<number>;
  /** platinum rim: rgb + strength */
  uRim: IUniform<Vector4>;
  /** glass fallback rim: ice rgb + strength */
  uRimGlass: IUniform<Vector4>;
  uAccent: IUniform<Color>;
  uEnvTint: IUniform<Color>;
  uSeamHeight: IUniform<number>;
  uSeamLight: IUniform<number>;
  uProgress: IUniform<number>;
  uReveal: IUniform<number>;
  uCoreGlow: IUniform<number>;
  uPulsePhase: IUniform<number>;
  uFlowSpeed: IUniform<number>;
  uShock: IUniform<number>;
}

export function createSceneUniforms(): SceneUniforms {
  return {
    uTime: { value: 0 },
    uTwist: { value: 0.15 },
    uLiquidAmp: { value: 1 },
    uBreath: { value: 0.6 },
    uRim: { value: new Vector4(0.788, 0.804, 0.831, 0.35) },
    uRimGlass: { value: new Vector4(0.749, 0.914, 1.0, 0.5) },
    uAccent: { value: new Color(ACCENT_STOPS[0]) },
    uEnvTint: { value: new Color(1, 1, 1) },
    uSeamHeight: { value: 0 },
    uSeamLight: { value: 1 },
    uProgress: { value: 0 },
    uReveal: { value: 1 },
    uCoreGlow: { value: 0.8 },
    uPulsePhase: { value: 0 },
    uFlowSpeed: { value: 1 },
    uShock: { value: 0 },
  };
}

const _stops = ACCENT_STOPS.map((c) => new Color(c));
/** Piecewise lerp of ACCENT_STOPS: 0 citron -> 1 ice -> 2 warm. */
export function accentColor(hue: number, out: Color): Color {
  const h = clamp(hue, 0, 2);
  const i = Math.min(Math.floor(h), 1);
  const t = h - i;
  return out.copy(_stops[i]).lerp(_stops[i + 1], t);
}

/** Procedural 256x256 roughness texture: low-frequency value noise so the mirror has faint waviness. */
export function createRoughnessTexture(): DataTexture {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = x / size;
      const fy = y / size;
      // tileable-ish: two octaves of value noise
      const n = 0.65 * valueNoise2D(fx * 5, fy * 5, 3) + 0.35 * valueNoise2D(fx * 13, fy * 13, 9);
      const v = 0.55 + 0.45 * n; // multiplies material.roughness (0.045) -> 0.025 .. 0.045: polished with faint waviness
      const i = (y * size + x) * 4;
      const b = Math.round(clamp(v, 0, 1) * 255);
      data[i] = b;
      data[i + 1] = b;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function wire(material: MeshPhysicalMaterial, opts: InjectionOptions, uniforms: SceneUniforms, tag: string): MeshPhysicalMaterial {
  const key = `fs-${tag}-${injectionKey(opts)}`;
  material.onBeforeCompile = (shader) => applyInjections(shader, opts, uniforms as unknown as Record<string, IUniform>);
  material.customProgramCacheKey = () => key;
  return material;
}

export interface MaterialSet {
  skin: MeshPhysicalMaterial;
  caps: MeshPhysicalMaterial;
  hub: MeshPhysicalMaterial;
  arc: MeshPhysicalMaterial;
  arcC: MeshPhysicalMaterial;
  keel: MeshPhysicalMaterial;
  glassRibbon: MeshPhysicalMaterial;
  glassCrystal: MeshPhysicalMaterial;
  glassRibbonFallback: MeshPhysicalMaterial;
  glassCrystalFallback: MeshPhysicalMaterial;
  coreEmissive: ShaderMaterial;
  shockwave: ShaderMaterial;
  debugGrey: MeshStandardMaterial;
  roughnessTexture: DataTexture;
  dispose(): void;
}

const CHROME_COLOR = new Color(PALETTE.metal);
const KEEL_COLOR = new Color('#B4B9C2');
const GLASS_COLOR = new Color('#F4F8FF');

export function createMaterials(uniforms: SceneUniforms): MaterialSet {
  const roughnessTexture = createRoughnessTexture();

  const chrome = (roughness: number, tag: string, opts: InjectionOptions, extra: Partial<MeshPhysicalMaterial> = {}): MeshPhysicalMaterial => {
    const m = new MeshPhysicalMaterial({
      color: CHROME_COLOR.clone(),
      metalness: 1,
      roughness,
      clearcoat: 0.5,
      clearcoatRoughness: 0.04,
      envMapIntensity: 1.0,
      specularIntensity: 1,
      side: FrontSide,
    });
    Object.assign(m, extra);
    return wire(m, opts, uniforms, tag);
  };

  const skin = chrome(0.045, 'skin', { twist: true, ripple: true, rim: 'uRim', envTint: true, roughNoise: true }, { roughnessMap: roughnessTexture });
  const caps = chrome(0.06, 'caps', { twist: true, ripple: true, rim: 'uRim', envTint: true, seam: true });
  const hub = chrome(0.05, 'hub', { rim: 'uRim', envTint: true });
  const arc = chrome(0.1, 'arc', { rim: 'uRim', envTint: true });
  const arcC = chrome(0.1, 'arcC', { rim: 'uRim', envTint: true, arcClip: true });

  const keel = new MeshPhysicalMaterial({
    color: KEEL_COLOR.clone(),
    metalness: 1,
    roughness: 0.28,
    anisotropy: 0.6,
    anisotropyRotation: 0,
    envMapIntensity: 1.1,
    clearcoat: 0,
    side: FrontSide,
  });
  wire(keel, { rim: 'uRim', envTint: true }, uniforms, 'keel');

  const glass = (thickness: number, ior: number, tag: string, opts: InjectionOptions): MeshPhysicalMaterial => {
    const m = new MeshPhysicalMaterial({
      color: GLASS_COLOR.clone(),
      metalness: 0,
      roughness: 0.05,
      transmission: 1,
      thickness,
      ior,
      attenuationColor: new Color('#DDE9FF'),
      attenuationDistance: 1.2,
      dispersion: 0.35,
      iridescence: 0.6,
      iridescenceIOR: 1.3,
      iridescenceThicknessRange: [120, 400],
      envMapIntensity: 1.6,
      side: DoubleSide,
      depthWrite: true,
      specularIntensity: 1,
    });
    return wire(m, opts, uniforms, tag);
  };
  const glassRibbon = glass(0.35, 1.55, 'glassRibbon', { reveal: true, ribbonLife: true });
  const glassCrystal = glass(0.5, 1.75, 'glassCrystal', {});
  glassCrystal.emissive = new Color('#1a2000');
  glassCrystal.emissiveIntensity = 0.4;

  const glassFallback = (tag: string, opts: InjectionOptions): MeshPhysicalMaterial => {
    const m = new MeshPhysicalMaterial({
      color: GLASS_COLOR.clone(),
      metalness: 0,
      roughness: 0.05,
      transmission: 0,
      transparent: true,
      opacity: 0.42,
      iridescence: 0.6,
      iridescenceIOR: 1.3,
      iridescenceThicknessRange: [120, 400],
      envMapIntensity: 2.2,
      side: DoubleSide,
      depthWrite: true,
      specularIntensity: 1,
    });
    return wire(m, opts, uniforms, tag);
  };
  const glassRibbonFallback = glassFallback('glassRibbonFb', { rim: 'uRimGlass', reveal: true, ribbonLife: true });
  const glassCrystalFallback = glassFallback('glassCrystalFb', { rim: 'uRimGlass' });
  glassCrystalFallback.emissive = new Color('#1a2000');
  glassCrystalFallback.emissiveIntensity = 0.4;

  const coreEmissive = new ShaderMaterial({
    uniforms: {
      uAccent: uniforms.uAccent,
      uCoreGlow: uniforms.uCoreGlow,
      uPulsePhase: uniforms.uPulsePhase,
      uTime: uniforms.uTime,
    },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vP;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = -mv.xyz;
        vP = position;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uAccent;
      uniform float uCoreGlow;
      uniform float uPulsePhase;
      uniform float uTime;
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vP;
      void main() {
        float ndv = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
        float pulse = 0.8 + 0.2 * sin(uPulsePhase * 6.2831853);
        // inner mottling so the filament is not a flat colour
        float mot = 0.85 + 0.15 * sin(vP.y * 23.0 + uTime * 1.3) * cos(vP.x * 31.0 - uTime * 0.9);
        vec3 col = mix(uAccent, vec3(1.0), pow(1.0 - ndv, 2.0) * 0.55);
        gl_FragColor = vec4(col * uCoreGlow * pulse * mot * 1.6, 1.0);
      }
    `,
    side: FrontSide,
  });

  const shockwave = new ShaderMaterial({
    uniforms: { uAccent: uniforms.uAccent, uShock: uniforms.uShock },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uAccent;
      uniform float uShock;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float ndv = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
        float a = (1.0 - uShock) * (1.0 - uShock);
        vec3 col = mix(uAccent, vec3(1.0), 0.35) * (2.0 + 1.5 * ndv);
        gl_FragColor = vec4(col * a, a);
      }
    `,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });

  const debugGrey = new MeshStandardMaterial({ color: 0x8a8d94, roughness: 0.55, metalness: 0, side: DoubleSide });

  return {
    skin,
    caps,
    hub,
    arc,
    arcC,
    keel,
    glassRibbon,
    glassCrystal,
    glassRibbonFallback,
    glassCrystalFallback,
    coreEmissive,
    shockwave,
    debugGrey,
    roughnessTexture,
    dispose() {
      for (const m of [skin, caps, hub, arc, arcC, keel, glassRibbon, glassCrystal, glassRibbonFallback, glassCrystalFallback, coreEmissive, shockwave, debugGrey]) m.dispose();
      roughnessTexture.dispose();
    },
  };
}

/** Gradient dome material for the environment scene (also reused nowhere else). */
export function createDomeMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {},
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        float h = vDir.y;
        vec3 top = vec3(0.486, 0.510, 0.565) * 0.16;      // #7C8290 scaled -> zenith luminance ~0.08
        vec3 horizon = vec3(0.024, 0.027, 0.039) * 1.2;   // ~0.03
        vec3 nadir = vec3(0.043, 0.047, 0.063) * 0.4;     // ~0.02
        vec3 col = h > 0.0 ? mix(horizon, top, pow(h, 0.8)) : mix(horizon, nadir, pow(-h, 0.7));
        // faint floor-bounce band just below the horizon so downward chrome is grey, not void
        float bounceD = (h + 0.25) / 0.12;
        col += vec3(0.02) * exp(-bounceD * bounceD); // explicit square: pow(negative, 2.0) is NaN on some drivers
        // soft ~8% grey patch behind the camera (+z hemisphere, slightly left) for camera-facing chrome
        float behind = max(dot(vDir, normalize(vec3(-0.25, 0.12, 1.0))), 0.0);
        col += vec3(0.05, 0.052, 0.058) * pow(behind, 6.0);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: BackSide,
    depthWrite: false,
  });
}
