// Floor: a dark receiving plane at y = -2.4 that only contributes a soft contact shadow (alpha) and, on the high
// preset, a planar Reflector mixed ~18% into near-black and fading radially. Everything else stays transparent so
// the DOM typography behind the canvas shows through.
import {
  CustomBlending,
  Group,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
  type IUniform,
} from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';

export const FLOOR_Y = -2.4;

export interface Floor {
  group: Group;
  update(centerX: number, centerZ: number, floatHeight: number, presence: number): void;
  setReflector(enabled: boolean): void;
  dispose(): void;
}

const REFLECTOR_SHADER = {
  name: 'FsFloorReflector',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    uCenter: { value: new Vector2(0, 0) },
    uPresence: { value: 1 },
    uMix: { value: 0.18 },
    uTexel: { value: 1 / 512 },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vW;
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vW = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uCenter;
    uniform float uPresence;
    uniform float uMix;
    uniform float uTexel;
    varying vec4 vUv;
    varying vec3 vW;
    void main() {
      vec2 uv = vUv.xy / vUv.w;
      float t = uTexel * 1.5;
      vec3 c = texture2D(tDiffuse, uv).rgb * 0.36;
      c += texture2D(tDiffuse, uv + vec2(t, 0.0)).rgb * 0.16;
      c += texture2D(tDiffuse, uv - vec2(t, 0.0)).rgb * 0.16;
      c += texture2D(tDiffuse, uv + vec2(0.0, t)).rgb * 0.16;
      c += texture2D(tDiffuse, uv - vec2(0.0, t)).rgb * 0.16;
      float dist = distance(vW.xz, uCenter);
      float mask = 1.0 - smoothstep(1.8, 6.5, dist);
      gl_FragColor = vec4(c * uMix * mask * uPresence, 0.0);
    }
  `,
};

export function createFloor(reflectorEnabled: boolean): Floor {
  const group = new Group();
  group.name = 'floor';

  const shadowUniforms: { uCenter: IUniform<Vector2>; uRadius: IUniform<number>; uStrength: IUniform<number> } = {
    uCenter: { value: new Vector2(0, 0) },
    uRadius: { value: 1.6 },
    uStrength: { value: 0.75 },
  };
  const shadowGeo = new PlaneGeometry(30, 30);
  const shadowMat = new ShaderMaterial({
    uniforms: shadowUniforms,
    vertexShader: /* glsl */ `
      varying vec3 vW;
      void main() {
        vW = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec2 uCenter;
      uniform float uRadius;
      uniform float uStrength;
      varying vec3 vW;
      void main() {
        vec2 d2 = (vW.xz - uCenter) / uRadius;
        d2.y *= 1.15;
        float d = length(d2);
        float a = (1.0 - smoothstep(0.12, 1.0, d)) * uStrength;
        a *= a;
        gl_FragColor = vec4(0.0, 0.0, 0.0, a);
      }
    `,
    transparent: true,
    depthWrite: false,
  });
  const shadow = new Mesh(shadowGeo, shadowMat);
  shadow.name = 'contact-shadow';
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = FLOOR_Y;
  shadow.renderOrder = -10;
  group.add(shadow);

  let reflector: Reflector | null = null;
  let reflectorGeo: PlaneGeometry | null = null;

  const buildReflector = (): void => {
    if (reflector) return;
    reflectorGeo = new PlaneGeometry(30, 30);
    reflector = new Reflector(reflectorGeo, {
      textureWidth: 512,
      textureHeight: 512,
      clipBias: 0.003,
      color: 0x101114,
      shader: REFLECTOR_SHADER,
    });
    reflector.name = 'reflector';
    reflector.rotation.x = -Math.PI / 2;
    reflector.position.y = FLOOR_Y + 0.002;
    reflector.renderOrder = -9;
    const mat = reflector.material as ShaderMaterial;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = CustomBlending;
    mat.blendSrc = OneFactor;
    mat.blendDst = OneMinusSrcAlphaFactor;
    mat.blendSrcAlpha = OneFactor;
    mat.blendDstAlpha = OneFactor;
    group.add(reflector);
  };
  const destroyReflector = (): void => {
    if (!reflector) return;
    group.remove(reflector);
    reflector.dispose();
    reflectorGeo?.dispose();
    reflector = null;
    reflectorGeo = null;
  };
  if (reflectorEnabled) buildReflector();

  return {
    group,
    update(centerX, centerZ, floatHeight, presence) {
      shadowUniforms.uCenter.value.set(centerX, centerZ);
      // the sculpture bottom sits ~0.8 above the floor; higher float = wider, fainter shadow
      const lift = Math.max(0, floatHeight);
      shadowUniforms.uRadius.value = 1.45 + lift * 0.9;
      shadowUniforms.uStrength.value = presence * (0.78 - lift * 0.35);
      if (reflector) {
        const u = (reflector.material as ShaderMaterial).uniforms;
        u.uCenter.value.set(centerX, centerZ);
        u.uPresence.value = presence;
      }
    },
    setReflector(enabled) {
      if (enabled) buildReflector();
      else destroyReflector();
    },
    dispose() {
      destroyReflector();
      shadowGeo.dispose();
      shadowMat.dispose();
    },
  };
}
