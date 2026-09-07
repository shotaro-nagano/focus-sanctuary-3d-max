// Space particles: three THREE.Points layers (near / mid / far) sharing one ShaderMaterial.
// Motion is evaluated in the vertex shader from uSceneTime (accumulated on the CPU with timeScale).
import { AdditiveBlending, BufferAttribute, BufferGeometry, Group, Points, ShaderMaterial, type IUniform } from 'three';
import type { SceneUniforms } from './materials';

export interface ParticleCounts {
  near: number;
  mid: number;
  far: number;
}

export interface Particles {
  group: Group;
  update(sceneTime: number, attract: number, flowSpeed: number, alpha: number, viewportHeight: number, pixelRatio: number): void;
  dispose(): void;
}

// deterministic pseudo-random so screenshots are reproducible
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function buildLayer(count: number, layer: number, rMin: number, rMax: number, yHalf: number, sizeMin: number, sizeMax: number, seed: number): BufferGeometry {
  const rand = rng(seed);
  const position = new Float32Array(count * 3);
  const aSeed = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    // radial shell around the sculpture, hollow in the middle so points never sit inside the vault
    const r = rMin + (rMax - rMin) * Math.pow(rand(), 0.7);
    const a = rand() * Math.PI * 2;
    const y = (rand() * 2 - 1) * yHalf;
    position[i * 3] = Math.cos(a) * r;
    position[i * 3 + 1] = y;
    position[i * 3 + 2] = Math.sin(a) * r;
    aSeed[i * 4] = rand() * Math.PI * 2;
    aSeed[i * 4 + 1] = 0.5 + rand();
    aSeed[i * 4 + 2] = sizeMin + (sizeMax - sizeMin) * rand();
    aSeed[i * 4 + 3] = layer;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(position, 3));
  g.setAttribute('aSeed', new BufferAttribute(aSeed, 4));
  return g;
}

export function createParticles(counts: ParticleCounts, uniforms: SceneUniforms): Particles {
  const group = new Group();
  group.name = 'particles';

  const own: { uAttract: IUniform<number>; uAlpha: IUniform<number>; uScale: IUniform<number> } = {
    uAttract: { value: 0 },
    uAlpha: { value: 1 },
    uScale: { value: 5 },
  };

  const material = new ShaderMaterial({
    uniforms: {
      uSceneTime: uniforms.uTime,
      uFlowSpeed: uniforms.uFlowSpeed,
      uAccent: uniforms.uAccent,
      uAttract: own.uAttract,
      uAlpha: own.uAlpha,
      uScale: own.uScale,
    },
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float uSceneTime;
      uniform float uAttract;
      uniform float uFlowSpeed;
      uniform float uScale;
      varying float vLayer;
      varying float vTw;
      void main() {
        vec3 p = position;
        float ph = aSeed.x;
        float sp = aSeed.y;
        // slow vortex about Y, period ~20 s, each point at its own rate
        float ang = uSceneTime * (6.2831853 / 20.0) * (0.55 + 0.45 * sp) * (0.4 + 0.6 * uFlowSpeed);
        float c = cos(ang);
        float s = sin(ang);
        p.xz = vec2(c * p.x + s * p.z, -s * p.x + c * p.z);
        // sin/cos drift
        p += 0.22 * vec3(sin(uSceneTime * 0.21 * sp + ph), sin(uSceneTime * 0.17 * sp + ph * 2.0 + 1.0), cos(uSceneTime * 0.19 * sp + ph * 3.0));
        p.y += 0.35 * sin(uSceneTime * 0.08 * uFlowSpeed * sp + ph * 5.0);
        // attractor toward the core (+) or blown outward (-)
        // gather into a shell around the core (never a single point: thousands of additive discs would white out)
        float k = uAttract > 0.0 ? mix(1.0, 0.3, uAttract) : (1.0 - uAttract * 0.9);
        p *= k;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = aSeed.z * uScale / max(-mv.z, 0.5);
        vLayer = aSeed.w;
        vTw = (0.7 + 0.3 * sin(uSceneTime * (1.5 + sp) + ph * 7.0)) * (1.0 - 0.6 * max(uAttract, 0.0));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uAccent;
      uniform float uAlpha;
      varying float vLayer;
      varying float vTw;
      void main() {
        vec2 d2 = gl_PointCoord - 0.5;
        float d = length(d2);
        float near = 1.0 - step(0.5, vLayer);
        float far = step(1.5, vLayer);
        float mid = 1.0 - near - far;
        float soft = near * 0.45 + mid * 0.28 + far * 0.2;
        float disc = 1.0 - smoothstep(0.5 - soft, 0.5, d);
        float base = near * 0.045 + mid * 0.13 + far * 0.2;
        vec3 tint = mix(vec3(0.72, 0.77, 0.88), uAccent, near * 0.5 + mid * 0.3 + far * 0.2);
        float a = disc * base * uAlpha * vTw;
        gl_FragColor = vec4(tint * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    premultipliedAlpha: true,
  });

  const geometries = [
    buildLayer(counts.near, 0, 1.9, 4.2, 2.4, 9, 20, 11),
    buildLayer(counts.mid, 1, 1.4, 5.5, 3.2, 3.5, 6, 23),
    buildLayer(counts.far, 2, 3.0, 9.5, 4.5, 1.3, 2.2, 37),
  ];
  for (const g of geometries) {
    const pts = new Points(g, material);
    pts.frustumCulled = false;
    group.add(pts);
  }

  return {
    group,
    update(_sceneTime, attract, flowSpeed, alpha, viewportHeight, pixelRatio) {
      own.uAttract.value = attract;
      own.uAlpha.value = alpha;
      own.uScale.value = 5 * pixelRatio * (viewportHeight / 900);
      void flowSpeed; // read through the shared uFlowSpeed uniform
    },
    dispose() {
      for (const g of geometries) g.dispose();
      material.dispose();
    },
  };
}
