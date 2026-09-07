// Orbit fragments: a broken halo of three blade arcs on three different axes and periods.
// Arc C is the progress arc (fragment clip at params.progress with a bloom-hot tip). Plus the M10 shockwave ring.
import { BoxGeometry, Group, Mesh, Object3D, Quaternion, TorusGeometry, Vector3, type BufferGeometry, type Material } from 'three';
import { DEG, clamp01 } from '../../shared/math';
import type { MaterialSet } from '../materials';
import { arcSpec, buildSweep } from './sweep';

interface ArcDef {
  radius: number;
  spanDeg: number;
  period: number;
  phase: number;
  scattered: Quaternion;
  aligned: Quaternion;
  park: Quaternion;
  parkOffset: Vector3;
}

const ARC_C_SPAN = 300;

function q(axis: [number, number, number], deg: number): Quaternion {
  return new Quaternion().setFromAxisAngle(new Vector3(axis[0], axis[1], axis[2]).normalize(), deg * DEG);
}

const ARCS: ArcDef[] = [
  {
    radius: 1.9,
    spanDeg: 210,
    period: 41,
    phase: 0,
    scattered: q([1, 0, 0], 24),
    aligned: q([1, 0, 0], 8),
    park: q([1, 0, 0], 90),
    parkOffset: new Vector3(-6, 4, -2),
  },
  {
    radius: 2.35,
    spanDeg: 130,
    period: 67,
    phase: 1.9,
    scattered: q([1, 0, 0.6], 65),
    aligned: q([0, 0, 1], -6),
    park: q([0, 0, 1], 90),
    parkOffset: new Vector3(6, -3, -3),
  },
  {
    radius: 1.55,
    spanDeg: ARC_C_SPAN,
    period: 29,
    phase: 4.4,
    scattered: q([0.3, 0, 1], 50),
    aligned: q([1, 0, 0], 12),
    park: q([1, 0, 0], -90),
    parkOffset: new Vector3(0, -6, 3),
  },
];

export interface Orbits {
  group: Group;
  meshes: Mesh[];
  arcCTip: Object3D;
  shockwave: Mesh;
  vertexCount: number;
  update(sceneTime: number, orbitTilt: number, orbitReveal: number, progress: number, shockwave: number): void;
  setDebug(material: Material | null): void;
  dispose(): void;
}

const _qRest = new Quaternion();
const _qSpin = new Quaternion();
const _qFinal = new Quaternion();
const _yAxis = new Vector3(0, 1, 0);

export function buildOrbits(materials: MaterialSet, detail: number): Orbits {
  const group = new Group();
  group.name = 'orbits';
  const meshes: Mesh[] = [];
  const geometries: BufferGeometry[] = [];
  const holders: Object3D[] = [];
  let vertexCount = 0;
  const segs = Math.max(96, Math.round(240 * detail));

  for (let i = 0; i < ARCS.length; i++) {
    const def = ARCS[i];
    const half = (def.spanDeg * DEG) / 2;
    const { geometry } = buildSweep(arcSpec(def.radius, -half, half, segs, 0.16, 0.05, true));
    geometries.push(geometry);
    vertexCount += geometry.getAttribute('position').count;
    const mesh = new Mesh(geometry, i === 2 ? materials.arcC : materials.arc);
    mesh.name = `arc-${'ABC'[i]}`;
    mesh.frustumCulled = false;
    const holder = new Object3D();
    holder.add(mesh);
    group.add(holder);
    holders.push(holder);
    meshes.push(mesh);
    if (i === 1) {
      // counterweight block at the trailing end of arc B, tangent to the arc
      const box = new BoxGeometry(0.5, 0.12, 0.2);
      geometries.push(box);
      vertexCount += box.getAttribute('position').count;
      const block = new Mesh(box, materials.arc);
      block.name = 'arc-B-counterweight';
      const a1 = half;
      block.position.set(Math.cos(a1) * def.radius, 0, Math.sin(a1) * def.radius);
      block.rotation.y = -(a1 + Math.PI / 2);
      block.translateX(0.22);
      mesh.add(block);
      meshes.push(block);
    }
  }

  // progress arc tip anchor (local to arc C)
  const arcCTip = new Object3D();
  arcCTip.name = 'arcC-tip';
  meshes[2].add(arcCTip);

  // shockwave ring
  const shockGeo = new TorusGeometry(1, 0.012, 8, 96);
  geometries.push(shockGeo);
  const shockwave = new Mesh(shockGeo, materials.shockwave);
  shockwave.name = 'shockwave';
  shockwave.rotation.x = Math.PI / 2 - 0.35;
  shockwave.rotation.z = 0.2;
  shockwave.visible = false;
  shockwave.frustumCulled = false;
  group.add(shockwave);

  const originalMaterials = meshes.map((m) => m.material);

  return {
    group,
    meshes,
    arcCTip,
    shockwave,
    vertexCount,
    update(sceneTime, orbitTilt, orbitReveal, progress, shock) {
      const tilt = clamp01(orbitTilt);
      const reveal = clamp01(orbitReveal);
      const ease = 1 - Math.pow(1 - reveal, 3);
      for (let i = 0; i < ARCS.length; i++) {
        const def = ARCS[i];
        const speed = (Math.PI * 2) / def.period * (1 + 1.3 * tilt);
        _qRest.copy(def.scattered).slerp(def.aligned, tilt);
        _qSpin.setFromAxisAngle(_yAxis, sceneTime * speed + def.phase);
        _qFinal.copy(_qRest).multiply(_qSpin);
        const holder = holders[i];
        if (reveal < 0.999) {
          holder.quaternion.copy(def.park).slerp(_qFinal, ease);
          holder.position.copy(def.parkOffset).multiplyScalar(1 - ease);
        } else {
          holder.quaternion.copy(_qFinal);
          holder.position.set(0, 0, 0);
        }
      }
      // arc C tip follows the clipped progress
      const cut = Math.max(clamp01(progress), 0.012);
      const half = (ARC_C_SPAN * DEG) / 2;
      const a = -half + ARC_C_SPAN * DEG * cut;
      arcCTip.position.set(Math.cos(a) * ARCS[2].radius, 0, Math.sin(a) * ARCS[2].radius);
      // shockwave
      const s = clamp01(shock);
      shockwave.visible = s > 0.002 && s < 0.999;
      shockwave.scale.setScalar(0.2 + 3.3 * s);
    },
    setDebug(material) {
      for (let i = 0; i < meshes.length; i++) meshes[i].material = material ?? originalMaterials[i];
    },
    dispose() {
      for (const g of geometries) g.dispose();
    },
  };
}
