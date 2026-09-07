// Core: a six-sided glass spindle (hexagonal prism crystal, flat facets) around an emissive filament
// and three thin counter-rotating rings. The point light that touches the keel lives in the light rig.
import { Group, LatheGeometry, Mesh, TorusGeometry, Vector2, type BufferGeometry, type Material } from 'three';
import type { MaterialSet } from '../materials';
import { CORE_HEIGHT, coreR } from './profile';

export interface Core {
  group: Group;
  crystal: Mesh;
  filament: Mesh;
  rings: Mesh[];
  vertexCount: number;
  update(sceneTime: number, coreScale: number): void;
  setGlass(transmission: boolean): void;
  setDebug(material: Material | null): void;
  dispose(): void;
}

function buildCrystalGeometry(): BufferGeometry {
  const pts: Vector2[] = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const v = i / n;
    const r = i === 0 || i === n ? 0.001 : coreR(v);
    pts.push(new Vector2(r, (v - 0.5) * CORE_HEIGHT));
  }
  const g = new LatheGeometry(pts, 6).toNonIndexed();
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export function buildCore(materials: MaterialSet, transmission: boolean): Core {
  const group = new Group();
  group.name = 'core';
  const crystalGeo = buildCrystalGeometry();
  const ringGeo = new TorusGeometry(0.09, 0.006, 8, 48);

  const crystal: Mesh<BufferGeometry, Material> = new Mesh(crystalGeo, transmission ? materials.glassCrystal : materials.glassCrystalFallback);
  crystal.name = 'crystal';
  const filament: Mesh<BufferGeometry, Material> = new Mesh(crystalGeo, materials.coreEmissive);
  filament.name = 'filament';
  filament.scale.setScalar(0.55);
  group.add(crystal, filament);

  const rings: Mesh<BufferGeometry, Material>[] = [];
  const ringV = [0.3, 0.5, 0.7];
  for (let i = 0; i < 3; i++) {
    const ring: Mesh<BufferGeometry, Material> = new Mesh(ringGeo, materials.coreEmissive);
    ring.name = `ring-${i}`;
    ring.position.y = (ringV[i] - 0.5) * CORE_HEIGHT * 0.55;
    ring.scale.setScalar(1 + i * 0.35);
    group.add(ring);
    rings.push(ring);
  }

  let debug: Material | null = null;
  let useTransmission = transmission;
  const applyMaterials = (): void => {
    crystal.material = debug ?? (useTransmission ? materials.glassCrystal : materials.glassCrystalFallback);
    filament.material = debug ?? materials.coreEmissive;
    for (const r of rings) r.material = debug ?? materials.coreEmissive;
  };

  const vertexCount = crystalGeo.getAttribute('position').count * 2 + ringGeo.getAttribute('position').count * 3;

  return {
    group,
    crystal,
    filament,
    rings,
    vertexCount,
    update(sceneTime, coreScale) {
      group.scale.setScalar(coreScale);
      group.position.y = 0.05 * Math.sin((sceneTime * Math.PI * 2) / 5.3);
      // counter-rotating rings on three different axes
      rings[0].rotation.set(Math.PI / 2 + 0.25 * Math.sin(sceneTime * 0.3), sceneTime * 0.9, 0);
      rings[1].rotation.set(Math.PI / 2 - 0.4, -sceneTime * 0.7, 0.3 * Math.sin(sceneTime * 0.21));
      rings[2].rotation.set(Math.PI / 2 + 0.55, sceneTime * 0.5, -0.4);
      filament.rotation.y = sceneTime * 0.15;
      crystal.rotation.y = -sceneTime * 0.05;
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
      crystalGeo.dispose();
      ringGeo.dispose();
    },
  };
}
