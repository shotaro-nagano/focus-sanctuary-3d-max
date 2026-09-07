// Post chain: RenderPass -> UnrealBloomPass (threshold 1.0: only emissives bloom) -> final grade pass
// (vignette, edge-only chromatic aberration, film grain, pause desaturation) -> OutputPass (ACES + sRGB).
// The composer target is HalfFloat and keeps alpha so the canvas stays transparent around the sculpture.
import { HalfFloatType, Vector2, WebGLRenderTarget, type Camera, type Scene, type WebGLRenderer, type IUniform } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { QualityPreset } from '../config';
import type { SceneParams } from '../shared/params';
import { GLSL_HASH } from './shaders/noise';

const FINAL_SHADER = {
  name: 'FsFinalGrade',
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new Vector2(1, 1) },
    uVignette: { value: 0.35 },
    uAberration: { value: 0.0025 },
    uGrain: { value: 0.03 },
    uDesaturate: { value: 0 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uVignette;
    uniform float uAberration;
    uniform float uGrain;
    uniform float uDesaturate;
    uniform float uTime;
    varying vec2 vUv;
    ${GLSL_HASH}
    void main() {
      vec2 c = vUv - 0.5;
      c.x *= uResolution.x / uResolution.y;
      float r2 = dot(c, c);
      vec4 col = texture2D(tDiffuse, vUv);
      if (any(isnan(col)) || any(isinf(col))) col = vec4(0.0, 0.0, 0.0, col.a);
      // radial chromatic aberration, edges only
      float edge = smoothstep(0.08, 0.55, r2);
      // uAberration is a UV offset (0.0025 ~ 3-4 px at the corners)
      vec2 dir = normalize(vUv - 0.5 + vec2(1e-5)) * uAberration * edge;
      float rr = texture2D(tDiffuse, vUv + dir).r;
      float bb = texture2D(tDiffuse, vUv - dir).b;
      col.r = mix(col.r, rr, edge);
      col.b = mix(col.b, bb, edge);
      // pause desaturation
      float l = dot(col.rgb, vec3(0.2126, 0.7152, 0.0722));
      col.rgb = mix(col.rgb, vec3(l), uDesaturate);
      // vignette (multiplies rgb only; alpha stays so the DOM behind is untouched)
      float vig = 1.0 - uVignette * smoothstep(0.12, 0.75, r2) * 1.35;
      col.rgb *= max(vig, 0.0);
      // film grain, only where the canvas has coverage (premultiplied safety)
      float g = (fs_hash12(gl_FragCoord.xy + fract(uTime * 0.37) * vec2(171.0, 313.0)) - 0.5) * uGrain;
      col.rgb += g * col.a * (0.4 + 0.6 * l);
      col.rgb = max(col.rgb, vec3(0.0));
      gl_FragColor = col;
    }
  `,
};

/**
 * Bloom is a spatial blur: one NaN / Inf pixel from any shader edge case would smear into a full-screen
 * wash. The high-pass input is sanitised and clamped so a bad pixel can at most make a small halo.
 */
function hardenBloom(bloom: UnrealBloomPass): void {
  const mat = bloom.materialHighPassFilter;
  const token = 'vec4 texel = texture2D( tDiffuse, vUv );';
  if (!mat.fragmentShader.includes(token)) {
    console.warn('[post] UnrealBloomPass high-pass shader changed; NaN guard not applied');
    return;
  }
  mat.fragmentShader = mat.fragmentShader.replace(
    token,
    `${token}
    if (any(isnan(texel)) || any(isinf(texel))) texel = vec4(0.0, 0.0, 0.0, 1.0);
    texel.rgb = clamp(texel.rgb, vec3(0.0), vec3(24.0));`,
  );
  mat.needsUpdate = true;
}

export class PostChain {
  readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private bloom: UnrealBloomPass | null = null;
  private readonly finalPass: ShaderPass;
  private readonly outputPass: OutputPass;
  private readonly target: WebGLRenderTarget;
  private preset: QualityPreset;
  private width: number;
  private height: number;
  private pixelRatio: number;

  constructor(
    private readonly renderer: WebGLRenderer,
    scene: Scene,
    camera: Camera,
    preset: QualityPreset,
    width: number,
    height: number,
    pixelRatio: number,
  ) {
    this.preset = preset;
    this.width = width;
    this.height = height;
    this.pixelRatio = pixelRatio;
    this.target = new WebGLRenderTarget(Math.max(1, Math.round(width * pixelRatio)), Math.max(1, Math.round(height * pixelRatio)), { type: HalfFloatType });
    this.target.texture.name = 'FsComposer.rt';
    this.composer = new EffectComposer(renderer, this.target);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.renderPass = new RenderPass(scene, camera);
    this.finalPass = new ShaderPass(FINAL_SHADER);
    this.outputPass = new OutputPass();
    this.composer.addPass(this.renderPass);
    this.buildBloom();
    this.composer.addPass(this.finalPass);
    this.composer.addPass(this.outputPass);
    this.applySizes();
  }

  private bloomSize(): Vector2 {
    const s = this.pixelRatio * this.preset.bloomScale * 2; // UnrealBloom halves internally
    return new Vector2(Math.max(2, Math.round(this.width * s)), Math.max(2, Math.round(this.height * s)));
  }

  private buildBloom(): void {
    if (!this.preset.bloom) return;
    this.bloom = new UnrealBloomPass(this.bloomSize(), 0.55, 0.6, 1.0);
    hardenBloom(this.bloom);
    this.composer.addPass(this.bloom);
  }

  private applySizes(): void {
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(this.width, this.height);
    if (this.bloom) {
      const bs = this.bloomSize();
      this.bloom.resolution.copy(bs);
      this.bloom.setSize(bs.x, bs.y);
    }
    const u = this.finalPass.uniforms as Record<string, IUniform>;
    (u.uResolution.value as Vector2).set(this.width * this.pixelRatio, this.height * this.pixelRatio);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.pixelRatio = pixelRatio;
    this.applySizes();
  }

  /** Rebuilds only the bloom pass for a new preset (bloom on/off, resolution scale). */
  setPreset(preset: QualityPreset): void {
    this.preset = preset;
    if (this.bloom) {
      this.composer.removePass(this.bloom);
      this.bloom.dispose();
      this.bloom = null;
    }
    if (preset.bloom) {
      this.bloom = new UnrealBloomPass(this.bloomSize(), 0.55, 0.6, 1.0);
      hardenBloom(this.bloom);
      this.composer.insertPass(this.bloom, 1);
    }
    this.applySizes();
  }

  update(params: SceneParams, sceneTime: number): void {
    if (this.bloom) {
      this.bloom.strength = params.bloomStrength;
      this.bloom.radius = params.bloomRadius;
      this.bloom.threshold = params.bloomThreshold;
    }
    const u = this.finalPass.uniforms as Record<string, IUniform>;
    u.uVignette.value = params.vignette;
    u.uAberration.value = params.aberration;
    u.uGrain.value = params.grain;
    u.uDesaturate.value = params.desaturate;
    u.uTime.value = sceneTime;
    this.renderer.toneMappingExposure = params.exposure;
  }

  render(): void {
    this.composer.render();
  }

  dispose(): void {
    if (this.bloom) this.bloom.dispose();
    this.finalPass.dispose();
    this.outputPass.dispose();
    this.renderPass.dispose();
    this.composer.dispose();
    this.target.dispose();
  }
}
