// Stage: the three.js scene (renderer, camera rig, environment, lights, sculpture, particles, floor, post).
// Reads SceneParams every frame; never tweens anything itself. All cyclic motion uses sceneTime, which is
// accumulated here as sceneTime += dt * params.timeScale so pause freezes phase and resume continues seamlessly.
import {
  ACESFilmicToneMapping,
  Color,
  Group,
  MeshBasicMaterial,
  PerspectiveCamera,
  Quaternion,
  SRGBColorSpace,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
} from 'three';
import type { QualityPreset } from '../config';
import type { RuntimeInput, SceneParams } from '../shared/params';
import { DEG, clamp, clamp01, damp } from '../shared/math';
import { buildEnvironment, createLightRig, type EnvironmentHandle, type LightRig } from './environment';
import { createFloor, FLOOR_Y, type Floor } from './floor';
import { accentColor, createMaterials, createSceneUniforms, type MaterialSet, type SceneUniforms } from './materials';
import { createParticles, type Particles } from './particles';
import { PostChain } from './post';
import { ROOT_BASE_YAW, Sculpture } from './sculpture/Sculpture';

export type WorldAnchor = 'core' | 'cleft' | 'topHub' | 'bottomHub' | 'arcC';

export interface StageOptions {
  quality: QualityPreset;
  layout: 'desktop' | 'mobile';
  onContextLost?: () => void;
  onContextRestored?: () => void;
}

export type DebugMaterialMode = 'none' | 'grey' | 'wire';

const WHITE = new Color(1, 1, 1);
const Y_AXIS = new Vector3(0, 1, 0);

export class Stage {
  static isSupported(): boolean {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') ?? c.getContext('webgl');
      return gl !== null;
    } catch {
      return false;
    }
  }

  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly uniforms: SceneUniforms;
  private readonly materials: MaterialSet;
  private env: EnvironmentHandle;
  private readonly lights: LightRig;
  private readonly sculpture: Sculpture;
  private particles: Particles;
  private readonly floor: Floor;
  private post: PostChain;
  private preset: QualityPreset;
  private layout: 'desktop' | 'mobile';
  private _sceneTime = 0;
  private paused = false;
  private lost = false;
  /** false until resize() has been called with a real viewport (avoids zero-size render targets on frame 0) */
  private sized = false;
  private width = 1;
  private height = 1;
  private requestedPixelRatio = 1;
  private pixelRatio = 1;
  private fps = 60;
  private drawCalls = 0;
  private triangles = 0;
  private debugMode: DebugMaterialMode = 'none';
  private readonly wireMaterial: MeshBasicMaterial;
  private readonly accent = new Color();
  private readonly target = new Vector3();
  private readonly camRight = new Vector3();
  private readonly qTilt = new Quaternion();
  private readonly qYaw = new Quaternion();
  private readonly worldPos = new Vector3();
  private readonly projected = { x: 0, y: 0, visible: false, depth: 0 };
  private readonly root: Group;
  private lastFov = 0;
  private readonly onLostBound: (e: Event) => void;
  private readonly onRestoredBound: () => void;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly opts: StageOptions) {
    this.preset = opts.quality;
    this.layout = opts.layout;
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.transmissionResolutionScale = this.preset.transmissionScale;
    this.renderer.info.autoReset = false;

    this.camera = new PerspectiveCamera(32, 1, 0.1, 80);
    this.scene.add(this.camera);

    this.uniforms = createSceneUniforms();
    this.materials = createMaterials(this.uniforms);
    this.wireMaterial = new MeshBasicMaterial({ color: 0xd9ff62, wireframe: true, transparent: true, opacity: 0.35 });

    this.env = buildEnvironment(this.renderer);
    this.scene.environment = this.env.texture;
    this.scene.environmentIntensity = 1;
    this.lights = createLightRig(this.scene);

    this.root = new Group();
    this.root.name = 'root';
    this.sculpture = new Sculpture(this.materials, this.preset);
    this.root.add(this.sculpture.root);
    this.scene.add(this.root);

    this.particles = createParticles(this.preset.particles, this.uniforms);
    this.scene.add(this.particles.group);

    this.floor = createFloor(this.preset.reflector);
    this.scene.add(this.floor.group);

    const size = this.renderer.getSize(new Vector2());
    this.width = Math.max(1, size.x);
    this.height = Math.max(1, size.y);
    this.pixelRatio = this.renderer.getPixelRatio();
    this.requestedPixelRatio = this.pixelRatio;
    this.post = new PostChain(this.renderer, this.scene, this.camera, this.preset, this.width, this.height, this.pixelRatio);

    this.onLostBound = (e: Event) => {
      e.preventDefault();
      this.lost = true;
      this.opts.onContextLost?.();
    };
    this.onRestoredBound = () => {
      this.lost = false;
      this.rebuildAfterRestore();
      this.opts.onContextRestored?.();
    };
    canvas.addEventListener('webglcontextlost', this.onLostBound, false);
    canvas.addEventListener('webglcontextrestored', this.onRestoredBound, false);
  }

  get sceneTime(): number {
    return this._sceneTime;
  }

  /** total sculpture vertex count (built once) */
  get vertexCount(): number {
    return this.sculpture.vertexCount;
  }

  private rebuildAfterRestore(): void {
    this.env.dispose();
    this.env = buildEnvironment(this.renderer);
    this.scene.environment = this.env.texture;
    this.post.dispose();
    this.post = new PostChain(this.renderer, this.scene, this.camera, this.preset, this.width, this.height, this.pixelRatio);
  }

  setQuality(q: QualityPreset): void {
    this.preset = q;
    this.scene.remove(this.particles.group);
    this.particles.dispose();
    this.particles = createParticles(q.particles, this.uniforms);
    this.scene.add(this.particles.group);
    this.post.setPreset(q);
    this.renderer.transmissionResolutionScale = q.transmissionScale;
    this.sculpture.setGlass(q.transmission);
    this.floor.setReflector(q.reflector);
    this.resize(this.width, this.height, this.requestedPixelRatio);
  }

  setLayout(layout: 'desktop' | 'mobile'): void {
    this.layout = layout;
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.sized = width >= 2 && height >= 2;
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.requestedPixelRatio = pixelRatio;
    this.pixelRatio = clamp(pixelRatio, 0.5, this.preset.maxPixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.post.setSize(this.width, this.height, this.pixelRatio);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Dev only: flat grey (env coverage check) or wireframe over the whole sculpture. */
  setDebugMaterial(mode: DebugMaterialMode): void {
    this.debugMode = mode;
    const m: Material | null = mode === 'grey' ? this.materials.debugGrey : mode === 'wire' ? this.wireMaterial : null;
    this.sculpture.setDebug(m);
  }

  get debugMaterial(): DebugMaterialMode {
    return this.debugMode;
  }

  render(params: SceneParams, input: RuntimeInput, dt: number): void {
    if (this.paused || this.lost || !this.sized) return;
    const step = Math.max(0, dt);
    this._sceneTime += step * params.timeScale;
    const t = this._sceneTime;
    if (step > 0) this.fps = damp(this.fps, 1 / Math.max(step, 1e-3), 4, step);

    // ---- shared uniforms ----
    const u = this.uniforms;
    u.uTime.value = t;
    u.uTwist.value = params.shellTwist;
    u.uLiquidAmp.value = params.liquidAmp;
    u.uBreath.value = params.shellBreath;
    u.uRim.value.w = params.rimIntensity;
    u.uRimGlass.value.w = 0.5 * (0.6 + params.rimIntensity);
    accentColor(params.accentHue, this.accent);
    u.uAccent.value.copy(this.accent);
    u.uEnvTint.value.copy(WHITE).lerp(this.accent, 0.35);
    u.uSeamHeight.value = clamp01(params.progress);
    u.uSeamLight.value = params.seamLight;
    u.uProgress.value = clamp01(params.progress);
    u.uReveal.value = params.ribbonReveal;
    u.uCoreGlow.value = params.coreGlow + input.pressPulse * 0.8;
    u.uFlowSpeed.value = params.flowSpeed;
    u.uShock.value = params.shockwave;

    // ---- camera rig: pose -> pointer parallax ----
    const pw = clamp01(params.pointerWeight);
    const yaw = (params.camYaw + input.pointerX * 3 * pw) * DEG;
    const pitch = (params.camPitch + input.pointerY * 1.5 * pw) * DEG;
    this.target.set(params.camTargetX + input.pointerX * 0.08 * pw, params.camTargetY + input.pointerY * 0.08 * pw, params.camTargetZ);
    const d = Math.max(0.3, params.camDolly);
    const cp = Math.cos(pitch);
    this.camera.position.set(this.target.x + d * Math.sin(yaw) * cp, this.target.y + d * Math.sin(pitch), this.target.z + d * Math.cos(yaw) * cp);
    this.camera.lookAt(this.target);
    if (params.camFov !== this.lastFov) {
      this.lastFov = params.camFov;
      this.camera.fov = params.camFov;
      this.camera.updateProjectionMatrix();
    }
    this.camRight.set(Math.cos(yaw), 0, -Math.sin(yaw));

    // ---- sculpture root: placement, float bob, idle sway, drag ----
    const bobAmp = 1 + 0.5 * clamp01(params.shellOpen - 0.5);
    const bob = bobAmp * (0.06 * Math.sin((Math.PI * 2 * t) / 7) + 0.04 * Math.sin((Math.PI * 2 * t) / 11 + 1.3));
    this.root.position.set(params.rootX, params.rootY + bob, 0);
    this.root.scale.setScalar(params.rootScale);
    this.qTilt.setFromAxisAngle(this.camRight, (params.rootTilt + input.dragPitch) * DEG);
    this.qYaw.setFromAxisAngle(Y_AXIS, ROOT_BASE_YAW + Sculpture.sway(t) + input.dragYaw * DEG);
    this.root.quaternion.copy(this.qTilt).multiply(this.qYaw);
    this.sculpture.update(params, t, step);
    u.uPulsePhase.value = this.sculpture.pulsePhase;

    // ---- environment + lights ----
    this.scene.environmentRotation.y = params.envRotation + input.pointerX * 6 * DEG * pw + t * 0.5 * DEG;
    this.lights.rect.position.x = 2.2 + params.lightSlide * 0.6 + input.pressPulse * 0.2;
    this.lights.rect.lookAt(this.root.position.x - 0.3, 0.2, 0);
    this.sculpture.anchors.core.getWorldPosition(this.worldPos);
    this.lights.core.position.copy(this.worldPos);
    this.lights.core.color.copy(this.accent);
    this.lights.core.intensity = 1.1 * params.coreGlow + input.pressPulse * 1.5;

    // ---- particles + floor ----
    this.particles.group.position.copy(this.root.position);
    this.particles.update(t, params.attract, params.flowSpeed, params.particleAlpha, this.height, this.pixelRatio);
    this.floor.update(this.root.position.x, this.root.position.z, params.rootY + bob - (params.rootScale - 1) * 1.6, params.floorPresence);

    // ---- post + draw ----
    this.renderer.info.reset();
    this.post.update(params, t);
    this.post.render();
    this.drawCalls = this.renderer.info.render.calls;
    this.triangles = this.renderer.info.render.triangles;
  }

  /** CSS px relative to the canvas; the returned object is reused between calls (read it immediately). */
  project(anchor: WorldAnchor): { x: number; y: number; visible: boolean; depth: number } {
    const obj: Object3D = this.sculpture.anchors[anchor];
    obj.getWorldPosition(this.worldPos);
    const depth = this.worldPos.distanceTo(this.camera.position);
    this.worldPos.project(this.camera);
    const v = this.worldPos;
    const out = this.projected;
    out.x = (v.x * 0.5 + 0.5) * this.width;
    out.y = (-v.y * 0.5 + 0.5) * this.height;
    out.depth = depth;
    out.visible = v.z > -1 && v.z < 1 && Math.abs(v.x) <= 1.05 && Math.abs(v.y) <= 1.05;
    return out;
  }

  getStats(): { drawCalls: number; triangles: number; fps: number } {
    return { drawCalls: this.drawCalls, triangles: this.triangles, fps: this.fps };
  }

  /** world y of the floor plane (for callers that want to place things on it) */
  get floorY(): number {
    return FLOOR_Y;
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLostBound, false);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestoredBound, false);
    this.sculpture.dispose();
    this.particles.dispose();
    this.floor.dispose();
    this.post.dispose();
    this.lights.dispose();
    this.env.dispose();
    this.materials.dispose();
    this.wireMaterial.dispose();
    this.scene.environment = null;
    this.renderer.dispose();
  }
}
