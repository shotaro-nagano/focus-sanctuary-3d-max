// Three prism-glass sashes coiling around the crystal core. Helix parameters (ribbonTwist / ribbonSpread) are
// tweened by the Director; the ~6k vertices are regenerated on the CPU only when those values change.
import { Group, Mesh, Vector3, type BufferGeometry, type Material } from 'three';
import { smoothstep } from '../../shared/math';
import type { MaterialSet } from '../materials';
import { buildSweep, refreshSweep, type SweepArrays, type SweepSpec } from './sweep';

const PHI0 = [0, 2.2, 4.1];

interface RibbonState {
  spec: SweepSpec;
  geometry: BufferGeometry;
  arrays: SweepArrays;
  twist: number;
  spread: number;
}

export interface Ribbons {
  group: Group;
  meshes: Mesh[];
  vertexCount: number;
  /** regenerates the sashes when twist / spread moved by more than epsilon */
  update(ribbonTwist: number, ribbonSpread: number): void;
  setGlass(transmission: boolean): void;
  setDebug(material: Material | null): void;
  dispose(): void;
}

export function buildRibbons(materials: MaterialSet, detail: number, transmission: boolean): Ribbons {
  const group = new Group();
  group.name = 'ribbons';
  const meshes: Mesh[] = [];
  const states: RibbonState[] = [];
  const segs = Math.max(96, Math.round(240 * detail));
  let vertexCount = 0;

  for (let k = 0; k < 3; k++) {
    const st: RibbonState = { twist: 1, spread: 0.9, spec: null as unknown as SweepSpec, geometry: null as unknown as BufferGeometry, arrays: null as unknown as SweepArrays };
    const phi0 = PHI0[k];
    st.spec = {
      segments: segs,
      point: (s: number, out: Vector3) => {
        const y = -1.1 + 2.2 * s;
        const phi = phi0 + Math.PI * 2 * (0.85 + st.twist) * s;
        const a = st.spread * (0.55 + 0.18 * Math.sin(Math.PI * s));
        return out.set(a * Math.cos(phi), y, a * Math.sin(phi));
      },
      normalHint: (s: number, out: Vector3) => {
        const phi = phi0 + Math.PI * 2 * (0.85 + st.twist) * s;
        return out.set(Math.cos(phi), 0, Math.sin(phi));
      },
      width: (s: number) => Math.max(0.004, 0.22 * smoothstep(0, 0.12, s) * smoothstep(1, 0.88, s)),
      height: () => 0.035,
    };
    const built = buildSweep(st.spec);
    st.geometry = built.geometry;
    st.arrays = built.arrays;
    states.push(st);
    vertexCount += st.geometry.getAttribute('position').count;
    const mesh = new Mesh(st.geometry, transmission ? materials.glassRibbon : materials.glassRibbonFallback);
    mesh.name = `sash-${k}`;
    mesh.frustumCulled = false;
    group.add(mesh);
    meshes.push(mesh);
  }

  let debug: Material | null = null;
  let useTransmission = transmission;
  const applyMaterials = (): void => {
    for (const m of meshes) m.material = debug ?? (useTransmission ? materials.glassRibbon : materials.glassRibbonFallback);
  };

  return {
    group,
    meshes,
    vertexCount,
    update(ribbonTwist, ribbonSpread) {
      for (const st of states) {
        if (Math.abs(st.twist - ribbonTwist) > 1e-4 || Math.abs(st.spread - ribbonSpread) > 1e-4) {
          st.twist = ribbonTwist;
          st.spread = ribbonSpread;
          refreshSweep(st.spec, st.geometry, st.arrays);
        }
      }
    },
    setGlass(t) {
      useTransmission = t;
      applyMaterials();
    },
    setDebug(material) {
      debug = material;
      applyMaterials();
    },
    dispose() {
      for (const st of states) st.geometry.dispose();
    },
  };
}
