// Procedural studio environment (the thing that makes chrome look like chrome) + the real light rig.
// The env is neutral and mode independent: mode colour comes from lights / uEnvTint, never from a PMREM rebuild.
import {
  Color,
  DirectionalLight,
  Mesh,
  MeshBasicMaterial,
  PMREMGenerator,
  PlaneGeometry,
  PointLight,
  RectAreaLight,
  Scene,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type Texture,
  type WebGLRenderer,
  DoubleSide,
} from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { createDomeMaterial } from './materials';
import { PALETTE } from '../config';

export interface EnvironmentHandle {
  texture: Texture;
  dispose(): void;
}

const _origin = new Vector3(0, 0, 0);

function lightPlane(w: number, h: number, color: [number, number, number], pos: [number, number, number], lookAt: Vector3 | null): Mesh {
  const mat = new MeshBasicMaterial({ color: new Color(color[0], color[1], color[2]), side: DoubleSide, toneMapped: false, fog: false });
  const mesh = new Mesh(new PlaneGeometry(w, h), mat);
  mesh.position.set(pos[0], pos[1], pos[2]);
  if (lookAt) mesh.lookAt(lookAt);
  return mesh;
}

/**
 * Renders the studio scene once through PMREMGenerator (HalfFloat, HDR light shapes above 1.0) and returns the
 * environment texture. Roughly a quarter of the dome is bright so any curved chrome sees at least one long white bar.
 */
export function buildEnvironment(renderer: WebGLRenderer): EnvironmentHandle {
  const env = new Scene();
  const disposables: { dispose(): void }[] = [];

  // dome: inverted 50-unit sphere with the vertical gradient (zenith ~0.2 -> horizon ~0.06 -> nadir ~0.025)
  const domeGeo = new SphereGeometry(50, 48, 32);
  const domeMat = createDomeMaterial();
  env.add(new Mesh(domeGeo, domeMat));
  disposables.push(domeGeo, domeMat);

  // HDR values are kept moderate (bars ~3, the thin signature band ~5.5): after envMapIntensity 1.3 and ACES they
  // read as white bars while the bulk of the shell stays below the bloom threshold (1.0) - only the hottest slivers bloom.
  // L1 softbox: broad, above, facing down
  env.add(lightPlane(12, 0.9, [1.15, 1.15, 1.2], [0, 9, -4], _origin));
  // L1b soft box above-left (broad soft highlight)
  env.add(lightPlane(4, 0.8, [0.95, 0.95, 1.0], [-6, 8, 4], _origin));
  // L2 vertical strip camera-left
  env.add(lightPlane(0.7, 14, [1.25, 1.27, 1.34], [-10, 0, 2], _origin));
  // L2b signature thin warm-white band behind-right of the camera (slides across curvature)
  env.add(lightPlane(6, 0.12, [2.4, 2.32, 2.2], [6, 1.5, 9], _origin));
  // L3 curved strip: partial torus arc (100 deg) high right-back
  {
    const geo = new TorusGeometry(12, 0.35, 8, 48, (100 * Math.PI) / 180);
    const mat = new MeshBasicMaterial({ color: new Color(1.05, 1.05, 1.16), side: DoubleSide, toneMapped: false });
    const m = new Mesh(geo, mat);
    m.position.set(9, 3, -6);
    m.lookAt(_origin);
    env.add(m);
    disposables.push(geo, mat);
  }
  // L3b curved vertical strip camera-left (cool white)
  {
    const geo = new TorusGeometry(10, 0.12, 6, 40, Math.PI / 2);
    const mat = new MeshBasicMaterial({ color: new Color(1.5 * 0.9, 1.5 * 0.94, 1.5), side: DoubleSide, toneMapped: false });
    const m = new Mesh(geo, mat);
    m.position.set(-8, 2, 6);
    m.rotation.set(Math.PI / 2, 0, 0.6);
    env.add(m);
    disposables.push(geo, mat);
  }
  // L4 low citron strip (undersides pick up a faint accent)
  env.add(lightPlane(6, 0.3, [0.75, 1.15, 0.2], [2, -6, 5], _origin));
  // L4b citron strip behind the sculpture
  env.add(lightPlane(3, 0.08, [1.1, 1.3, 0.48], [0, -1, -9], _origin));
  // L5 small pink-violet patch (secondary spectral colour on grazing glass)
  env.add(lightPlane(1, 1, [0.55, 0.36, 0.5], [7, -2, 8], _origin));

  for (const child of env.children) {
    const m = child as Mesh;
    if (m.geometry && !disposables.includes(m.geometry)) disposables.push(m.geometry);
    if (m.material && !disposables.includes(m.material as never)) disposables.push(m.material as { dispose(): void });
  }

  const pmrem = new PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const target = pmrem.fromScene(env, 0.03, 0.1, 200);
  pmrem.dispose();
  for (const d of disposables) d.dispose();

  return {
    texture: target.texture,
    dispose() {
      target.dispose();
    },
  };
}

export interface LightRig {
  rect: RectAreaLight;
  key: DirectionalLight;
  rim: DirectionalLight;
  core: PointLight;
  dispose(): void;
}

let rectAreaInit = false;

/** RectAreaLight strip (slides with lightSlide), key + citron rim directionals, core point light. */
export function createLightRig(scene: Scene): LightRig {
  if (!rectAreaInit) {
    RectAreaLightUniformsLib.init();
    rectAreaInit = true;
  }
  const rect = new RectAreaLight(0xffffff, 0.9, 8, 0.16);
  rect.position.set(2.6, 4.2, 3.6);
  rect.lookAt(0.6, 0.2, 0);
  scene.add(rect);

  const key = new DirectionalLight(0xffffff, 0.55);
  key.position.set(-3, 4, 3);
  scene.add(key);
  scene.add(key.target);
  key.target.position.set(0.6, 0, 0);

  const rim = new DirectionalLight(new Color(PALETTE.citron), 0.6);
  rim.position.set(3, 1, -4);
  scene.add(rim);
  scene.add(rim.target);
  rim.target.position.set(0.6, 0, 0);

  const core = new PointLight(new Color(PALETTE.citron), 0, 3, 2);
  scene.add(core);

  return {
    rect,
    key,
    rim,
    core,
    dispose() {
      scene.remove(rect, key, key.target, rim, rim.target, core);
      rect.dispose();
      key.dispose();
      rim.dispose();
      core.dispose();
    },
  };
}
