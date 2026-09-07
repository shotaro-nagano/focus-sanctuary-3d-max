// Keel: the second wall. Three brushed meridian ribs at deliberately unequal angles + one latitude ring
// with a 60-degree gap facing the cleft.
import { Group, Mesh, Object3D, Vector3, type BufferGeometry, type Material } from 'three';
import { DEG } from '../../shared/math';
import type { MaterialSet } from '../materials';
import { arcSpec, buildSweep } from './sweep';
import { shellR, shellY } from './profile';

const RIB_ANGLES_DEG = [20, 150, 262];
const RIB_V0 = 0.06;
const RIB_V1 = 0.94;
const KEEL_SCALE = 0.78;

export interface Keel {
  group: Group;
  meshes: Mesh[];
  vertexCount: number;
  update(keelSplay: number): void;
  setDebug(material: Material | null): void;
  dispose(): void;
}

const _axis = new Vector3();

export function buildKeel(materials: MaterialSet, detail: number): Keel {
  const group = new Group();
  group.name = 'keel';
  const meshes: Mesh[] = [];
  const geometries: BufferGeometry[] = [];
  const pivots: Object3D[] = [];
  let vertexCount = 0;
  const segs = Math.max(48, Math.round(120 * detail));
  const pivotBase = new Vector3(0, -1.5, 0);

  for (const angDeg of RIB_ANGLES_DEG) {
    const phi = angDeg * DEG;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const { geometry } = buildSweep({
      segments: segs,
      point: (t, out) => {
        const v = RIB_V0 + (RIB_V1 - RIB_V0) * t;
        const r = KEEL_SCALE * shellR(v);
        return out.set(r * c, shellY(v), r * s);
      },
      normalHint: (t, out) => out.set(c, 0, s),
      width: () => 0.07,
      height: () => 0.12,
    });
    geometries.push(geometry);
    vertexCount += geometry.getAttribute('position').count;
    const mesh = new Mesh(geometry, materials.keel);
    mesh.name = `rib-${angDeg}`;
    const pivot = new Object3D();
    pivot.position.copy(pivotBase);
    mesh.position.copy(pivotBase).negate();
    pivot.add(mesh);
    group.add(pivot);
    pivots.push(pivot);
    meshes.push(mesh);
  }

  // latitude ring at v 0.44, 300-degree arc, gap centred on the cleft (212deg)
  {
    const v = 0.44;
    const r = KEEL_SCALE * shellR(v);
    const a0 = 242 * DEG;
    const a1 = (182 + 360) * DEG;
    const { geometry } = buildSweep(arcSpec(r, a0, a1, Math.max(96, Math.round(220 * detail)), 0.07, 0.12, true));
    geometries.push(geometry);
    vertexCount += geometry.getAttribute('position').count;
    const mesh = new Mesh(geometry, materials.keel);
    mesh.name = 'keel-ring';
    mesh.position.y = shellY(v);
    group.add(mesh);
    meshes.push(mesh);
  }

  const originalMaterials = meshes.map((m) => m.material);

  return {
    group,
    meshes,
    vertexCount,
    update(keelSplay) {
      for (let i = 0; i < pivots.length; i++) {
        const phi = RIB_ANGLES_DEG[i] * DEG;
        _axis.set(-Math.sin(phi), 0, Math.cos(phi));
        pivots[i].quaternion.setFromAxisAngle(_axis, -12 * DEG * keelSplay);
      }
    },
    setDebug(material) {
      for (let i = 0; i < meshes.length; i++) meshes[i].material = material ?? originalMaterials[i];
    },
    dispose() {
      for (const g of geometries) g.dispose();
    },
  };
}
