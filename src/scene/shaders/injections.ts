// onBeforeCompile injections for MeshPhysicalMaterial (three r185 chunk names verified against
// node_modules/three/src/renderers/shaders/ShaderChunk). Every replace is asserted: a chunk that is
// not found logs a warning instead of silently doing nothing.
import type { WebGLProgramParametersWithUniforms, IUniform } from 'three';
import { GLSL_SNOISE } from './noise';

export type ShaderParams = WebGLProgramParametersWithUniforms;

export function injectChunk(src: string, chunk: string, code: string, where: 'before' | 'after' | 'replace', label: string): string {
  const token = `#include <${chunk}>`;
  if (!src.includes(token)) {
    console.warn(`[scene/shaders] chunk <${chunk}> not found while injecting "${label}" - effect disabled`);
    return src;
  }
  const replacement = where === 'before' ? `${code}\n${token}` : where === 'after' ? `${token}\n${code}` : code;
  const out = src.replace(token, replacement);
  if (out === src) console.warn(`[scene/shaders] injection "${label}" did not change the shader`);
  return out;
}

/** Inserts declarations (uniforms / varyings / attributes / functions) right before `void main()`. */
export function declare(src: string, decl: string, label: string): string {
  const i = src.indexOf('void main()');
  if (i < 0) {
    console.warn(`[scene/shaders] no main() found while declaring "${label}"`);
    return `${decl}\n${src}`;
  }
  return `${src.slice(0, i)}${decl}\n${src.slice(i)}`;
}

export interface InjectionOptions {
  /** vertex twist about Y (uniform uTwist, rad at the poles) */
  twist?: boolean;
  /** liquid ripple displacement + normal correction (uLiquidAmp, uBreath, uTime) */
  ripple?: boolean;
  /** fresnel rim emissive; value = name of the vec4 uniform (rgb + strength) */
  rim?: string;
  /** mode colour in glancing indirect specular (uEnvTint) */
  envTint?: boolean;
  /** noise-zoned roughness modulation on the chrome skins */
  roughNoise?: boolean;
  /** progress seam light on the panel caps (attribute aV, uSeamHeight, uSeamLight, uAccent) */
  seam?: boolean;
  /** progress arc clip + hot tip (attribute aT, uProgress, uAccent) */
  arcClip?: boolean;
  /** ribbon draw-on reveal (attribute aT, uReveal, uAccent) */
  reveal?: boolean;
  /** ribbon surface life (attribute aT, uTime) */
  ribbonLife?: boolean;
}

export function injectionKey(o: InjectionOptions): string {
  return [
    o.twist ? 'tw' : '',
    o.ripple ? 'rp' : '',
    o.rim ? `rim:${o.rim}` : '',
    o.envTint ? 'et' : '',
    o.roughNoise ? 'rn' : '',
    o.seam ? 'sm' : '',
    o.arcClip ? 'ac' : '',
    o.reveal ? 'rv' : '',
    o.ribbonLife ? 'rl' : '',
  ].join('|');
}

const VERT_TWIST = /* glsl */ `
{
  float twA = uTwist * (transformed.y / 1.6);
  float twC = cos(twA);
  float twS = sin(twA);
  mat2 twM = mat2(twC, -twS, twS, twC);
  transformed.xz = twM * transformed.xz;
  objectNormal.xz = twM * objectNormal.xz;
  #ifdef USE_TANGENT
  objectTangent.xz = twM * objectTangent.xz;
  #endif
}
`;

const VERT_RIPPLE = /* glsl */ `
{
  float rip = uLiquidAmp * uBreath * 0.016;
  if (rip > 0.0001) {
    vec3 rp = transformed * 1.35 + vec3(0.0, uTime * 0.11, uTime * 0.07);
    float n0 = snoise(rp);
    vec3 rdir = normalize(vec3(transformed.x, 0.35 * transformed.y, transformed.z) + vec3(1e-4, 0.0, 0.0));
    float re = 0.08;
    vec3 rg = vec3(snoise(rp + vec3(re, 0.0, 0.0)) - n0, snoise(rp + vec3(0.0, re, 0.0)) - n0, snoise(rp + vec3(0.0, 0.0, re)) - n0) / re;
    transformed += rdir * (rip * n0);
    vec3 rgt = rg - objectNormal * dot(rg, objectNormal);
    objectNormal = normalize(objectNormal - rgt * (rip * 1.35 * 2.2));
  }
}
`;

const VERT_RIBBON_LIFE = /* glsl */ `
{
  vec3 rlDir = normalize(vec3(transformed.x, 0.0, transformed.z) + vec3(1e-4, 0.0, 0.0));
  transformed += rlDir * (0.012 * sin(9.0 * aT + 1.7 * uTime));
}
`;

const FRAG_RIM = (u: string): string => /* glsl */ `
{
  float rimF = pow(1.0 - saturate(dot(normalize(vViewPosition), normal)), 3.0);
  totalEmissiveRadiance += ${u}.rgb * rimF * ${u}.a;
}
`;

const FRAG_ENVTINT = /* glsl */ `
{
  float etNdv = saturate(dot(geometryNormal, geometryViewDir));
  radiance *= mix(vec3(1.0), uEnvTint, 1.0 - etNdv * etNdv);
}
`;

const FRAG_ROUGH_NOISE = /* glsl */ `
{
  float rz = snoise(vFsPos * 0.9 + vec3(3.1, 0.0, 7.7));
  roughnessFactor = clamp(roughnessFactor * (1.0 + 0.35 * rz), 0.02, 0.12);
}
`;

const FRAG_SEAM = /* glsl */ `
{
  float seamOn = smoothstep(0.0, 0.02, uSeamHeight);
  float seamBelow = 1.0 - smoothstep(uSeamHeight - 0.05, uSeamHeight + 0.015, vAV);
  float seamD = (vAV - uSeamHeight) / 0.02;
  float seamHead = exp(-seamD * seamD); // squared explicitly: pow(negative, 2.0) is NaN on some GL drivers
  totalEmissiveRadiance += uAccent * uSeamLight * seamOn * (1.2 * seamBelow + 2.4 * seamHead);
}
`;

const FRAG_ARC_CLIP = /* glsl */ `
{
  float arcCut = max(uProgress, 0.012);
  if (vAT > arcCut) discard;
  if (abs(vAT - 0.34) < 0.0133 || abs(vAT - 0.67) < 0.0133) discard;
}
`;
const FRAG_ARC_TIP = /* glsl */ `
{
  float arcCut2 = max(uProgress, 0.012);
  totalEmissiveRadiance += uAccent * 2.5 * smoothstep(arcCut2 - 0.03, arcCut2, vAT);
}
`;

const FRAG_REVEAL_CLIP = /* glsl */ `
{
  if (vAT > uReveal) discard;
}
`;
const FRAG_REVEAL_TIP = /* glsl */ `
{
  totalEmissiveRadiance += uAccent * 2.0 * smoothstep(uReveal - 0.04, uReveal, vAT) * (1.0 - step(0.999, uReveal));
}
`;

/**
 * Applies the selected injections to a compiled MeshPhysicalMaterial shader and wires the shared uniforms.
 * Call from material.onBeforeCompile; set material.customProgramCacheKey = () => injectionKey(opts).
 */
export function applyInjections(shader: ShaderParams, opts: InjectionOptions, uniforms: Record<string, IUniform>): void {
  for (const k of Object.keys(uniforms)) shader.uniforms[k] = uniforms[k];

  // ---- vertex ----
  let vdecl = '';
  if (opts.twist) vdecl += 'uniform float uTwist;\n';
  if (opts.ripple) vdecl += `uniform float uLiquidAmp;\nuniform float uBreath;\nuniform float uTime;\n${GLSL_SNOISE}\n`;
  if (opts.ribbonLife && !opts.ripple) vdecl += 'uniform float uTime;\n';
  if (opts.roughNoise) vdecl += 'varying vec3 vFsPos;\n';
  if (opts.seam) vdecl += 'attribute float aV;\nvarying float vAV;\n';
  if (opts.arcClip || opts.reveal || opts.ribbonLife) vdecl += 'attribute float aT;\nvarying float vAT;\n';
  if (vdecl) shader.vertexShader = declare(shader.vertexShader, vdecl, 'vertex pars');

  let vbody = '';
  if (opts.twist) vbody += VERT_TWIST;
  if (opts.ripple) vbody += VERT_RIPPLE;
  if (opts.ribbonLife) vbody += VERT_RIBBON_LIFE;
  if (opts.roughNoise) vbody += 'vFsPos = transformed;\n';
  if (opts.seam) vbody += 'vAV = aV;\n';
  if (opts.arcClip || opts.reveal || opts.ribbonLife) vbody += 'vAT = aT;\n';
  if (vbody) shader.vertexShader = injectChunk(shader.vertexShader, 'begin_vertex', vbody, 'after', 'vertex body');

  // ---- fragment ----
  let fdecl = '';
  if (opts.rim) fdecl += `uniform vec4 ${opts.rim};\n`;
  if (opts.envTint) fdecl += 'uniform vec3 uEnvTint;\n';
  if (opts.roughNoise) fdecl += `varying vec3 vFsPos;\n${GLSL_SNOISE}\n`;
  if (opts.seam) fdecl += 'varying float vAV;\nuniform float uSeamHeight;\nuniform float uSeamLight;\n';
  if (opts.arcClip) fdecl += 'uniform float uProgress;\n';
  if (opts.reveal) fdecl += 'uniform float uReveal;\n';
  if (opts.arcClip || opts.reveal || opts.ribbonLife) fdecl += 'varying float vAT;\n';
  if (opts.seam || opts.arcClip || opts.reveal) fdecl += 'uniform vec3 uAccent;\n';
  if (fdecl) shader.fragmentShader = declare(shader.fragmentShader, fdecl, 'fragment pars');

  let early = '';
  if (opts.arcClip) early += FRAG_ARC_CLIP;
  if (opts.reveal) early += FRAG_REVEAL_CLIP;
  if (early) shader.fragmentShader = injectChunk(shader.fragmentShader, 'clipping_planes_fragment', early, 'after', 'fragment clip');

  if (opts.roughNoise) shader.fragmentShader = injectChunk(shader.fragmentShader, 'roughnessmap_fragment', FRAG_ROUGH_NOISE, 'after', 'rough noise');

  let emis = '';
  if (opts.rim) emis += FRAG_RIM(opts.rim);
  if (opts.seam) emis += FRAG_SEAM;
  if (opts.arcClip) emis += FRAG_ARC_TIP;
  if (opts.reveal) emis += FRAG_REVEAL_TIP;
  if (emis) shader.fragmentShader = injectChunk(shader.fragmentShader, 'emissivemap_fragment', emis, 'after', 'emissive');

  if (opts.envTint) shader.fragmentShader = injectChunk(shader.fragmentShader, 'lights_fragment_maps', FRAG_ENVTINT, 'after', 'env tint');
}
