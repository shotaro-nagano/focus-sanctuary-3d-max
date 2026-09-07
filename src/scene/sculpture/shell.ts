// Outer shell: 8 thick panels cut from 5 helical petals, each panel = six independently-gridded faces
// (outer, inner, two seam caps, top/bottom caps) so every crease stays hard. Hinged opening is pure Object3D work.
import { BufferAttribute, BufferGeometry, Group, LatheGeometry, Mesh, Object3D, Vector2, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, clamp01, DEG } from '../../shared/math';
import type { MaterialSet } from '../materials';
import {
  CLEFT_PETAL,
  DOOR_PETAL,
  PETALS,
  SHELL_V0,
  SHELL_V1,
  SLIT_V0,
  SLIT_V1,
  cleftTop,
  petalMidAngle,
  shellPoint,
  shellR,
  shellY,
} from './profile';

interface PanelDef {
  petal: number;
  th0: number;
  th1: number;
  v0: number;
  vTop: (thetaDeg: number) => number;
}

const PANELS: readonly PanelDef[] = [
  { petal: 0, th0: 0, th1: 96, v0: SHELL_V0, vTop: () => SLIT_V0 },
  { petal: 0, th0: 0, th1: 96, v0: SLIT_V1, vTop: () => SHELL_V1 },
  { petal: 1, th0: 100, th1: 178, v0: SHELL_V0, vTop: () => SLIT_V0 },
  { petal: 1, th0: 100, th1: 138.5, v0: SLIT_V1, vTop: () => SHELL_V1 },
  { petal: 1, th0: 139.5, th1: 178, v0: SLIT_V0 + 0.004, vTop: () => SHELL_V1 },
  { petal: 2, th0: 182, th1: 242, v0: SHELL_V0, vTop: cleftTop },
  { petal: 3, th0: 246, th1: 330, v0: SHELL_V0, vTop: () => SHELL_V1 },
  { petal: 4, th0: 334, th1: 376, v0: SHELL_V0, vTop: () => SHELL_V1 },
];

interface FaceSpec {
  na: number;
  nb: number;
  pos(a: number, b: number, out: Vector3): void;
  aV(a: number, b: number): number;
  hint(a: number, b: number, out: Vector3): void;
}

const _p = new Vector3();
const _pa0 = new Vector3();
const _pa1 = new Vector3();
const _pb0 = new Vector3();
const _pb1 = new Vector3();
const _da = new Vector3();
const _db = new Vector3();
const _n = new Vector3();
const _h = new Vector3();

/** Grid face with finite-difference normals oriented by the outward hint; winding chosen to match. */
function buildFace(spec: FaceSpec): BufferGeometry {
  const { na, nb } = spec;
  const count = (na + 1) * (nb + 1);
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const aV = new Float32Array(count);
  const e = 1e-3;
  let k = 0;
  for (let j = 0; j <= nb; j++) {
    const b = j / nb;
    for (let i = 0; i <= na; i++) {
      const a = i / na;
      spec.pos(a, b, _p);
      spec.pos(clamp01(a - e), b, _pa0);
      spec.pos(clamp01(a + e), b, _pa1);
      spec.pos(a, clamp01(b - e), _pb0);
      spec.pos(a, clamp01(b + e), _pb1);
      _da.subVectors(_pa1, _pa0);
      _db.subVectors(_pb1, _pb0);
      _n.crossVectors(_da, _db);
      if (_n.lengthSq() < 1e-14) {
        spec.hint(a, b, _n);
      } else {
        _n.normalize();
        spec.hint(a, b, _h);
        if (_n.dot(_h) < 0) _n.negate();
      }
      position[k * 3] = _p.x;
      position[k * 3 + 1] = _p.y;
      position[k * 3 + 2] = _p.z;
      normal[k * 3] = _n.x;
      normal[k * 3 + 1] = _n.y;
      normal[k * 3 + 2] = _n.z;
      uv[k * 2] = a;
      uv[k * 2 + 1] = b;
      aV[k] = spec.aV(a, b);
      k++;
    }
  }
  // winding: decide once at the face centre whether (da x db) agrees with the hint
  spec.pos(0.5 - e, 0.5, _pa0);
  spec.pos(0.5 + e, 0.5, _pa1);
  spec.pos(0.5, 0.5 - e, _pb0);
  spec.pos(0.5, 0.5 + e, _pb1);
  _da.subVectors(_pa1, _pa0);
  _db.subVectors(_pb1, _pb0);
  _n.crossVectors(_da, _db);
  spec.hint(0.5, 0.5, _h);
  const flip = _n.dot(_h) < 0;
  const index = new Uint32Array(na * nb * 6);
  let q = 0;
  for (let j = 0; j < nb; j++) {
    for (let i = 0; i < na; i++) {
      const q00 = j * (na + 1) + i;
      const q10 = q00 + 1;
      const q01 = q00 + na + 1;
      const q11 = q01 + 1;
      if (!flip) {
        index[q++] = q00; index[q++] = q10; index[q++] = q11;
        index[q++] = q00; index[q++] = q11; index[q++] = q01;
      } else {
        index[q++] = q00; index[q++] = q11; index[q++] = q10;
        index[q++] = q00; index[q++] = q01; index[q++] = q11;
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(position, 3));
  g.setAttribute('normal', new BufferAttribute(normal, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setAttribute('aV', new BufferAttribute(aV, 1));
  g.setIndex(new BufferAttribute(index, 1));
  return g;
}

function buildPanel(def: PanelDef, detail: number): { skin: BufferGeometry; caps: BufferGeometry } {
  const petal = PETALS[def.petal];
  const delta = petal.delta;
  const th0 = def.th0 * DEG;
  const th1 = def.th1 * DEG;
  const spanDeg = def.th1 - def.th0;
  let vMax = def.v0;
  for (let i = 0; i <= 8; i++) vMax = Math.max(vMax, def.vTop(def.th0 + (spanDeg * i) / 8));
  const nTheta = Math.max(6, Math.round((40 * spanDeg * detail) / 96));
  const nV = Math.max(8, Math.round((110 * (vMax - def.v0) * detail) / 0.94));
  const nW = 6;

  const thetaAt = (a: number): number => th0 + (th1 - th0) * a;
  const vAt = (a: number, b: number): number => {
    const top = def.vTop(def.th0 + spanDeg * a);
    return def.v0 + (top - def.v0) * b;
  };
  const radialHint = (theta: number, v: number, sign: number, out: Vector3): void => {
    shellPoint(theta, v, 0, delta, out);
    out.y = 0;
    out.normalize().multiplyScalar(sign);
  };
  const tangentHint = (theta: number, v: number, sign: number, out: Vector3): void => {
    shellPoint(theta, v, 0, delta, out);
    const x = out.x;
    out.set(-out.z, 0, x).normalize().multiplyScalar(sign);
  };

  const outer = buildFace({
    na: nTheta,
    nb: nV,
    pos: (a, b, out) => { shellPoint(thetaAt(a), vAt(a, b), 0, delta, out); },
    aV: (a, b) => vAt(a, b),
    hint: (a, b, out) => radialHint(thetaAt(a), vAt(a, b), 1, out),
  });
  const inner = buildFace({
    na: nTheta,
    nb: nV,
    pos: (a, b, out) => { shellPoint(thetaAt(a), vAt(a, b), 1, delta, out); },
    aV: (a, b) => vAt(a, b),
    hint: (a, b, out) => radialHint(thetaAt(a), vAt(a, b), -1, out),
  });
  const capStart = buildFace({
    na: nW,
    nb: nV,
    pos: (a, b, out) => { shellPoint(th0, vAt(0, b), a, delta, out); },
    aV: (a, b) => vAt(0, b),
    hint: (a, b, out) => tangentHint(th0, vAt(0, b), -1, out),
  });
  const capEnd = buildFace({
    na: nW,
    nb: nV,
    pos: (a, b, out) => { shellPoint(th1, vAt(1, b), a, delta, out); },
    aV: (a, b) => vAt(1, b),
    hint: (a, b, out) => tangentHint(th1, vAt(1, b), 1, out),
  });
  const capBottom = buildFace({
    na: nTheta,
    nb: nW,
    pos: (a, b, out) => { shellPoint(thetaAt(a), def.v0, b, delta, out); },
    aV: () => def.v0,
    hint: (a, b, out) => { out.set(0, -1, 0); },
  });
  const capTop = buildFace({
    na: nTheta,
    nb: nW,
    pos: (a, b, out) => { shellPoint(thetaAt(a), vAt(a, 1), b, delta, out); },
    aV: (a) => vAt(a, 1),
    hint: (a, b, out) => { out.set(0, 1, 0); },
  });

  const skin = mergeGeometries([outer, inner], false);
  const caps = mergeGeometries([capStart, capEnd, capBottom, capTop], false);
  for (const g of [outer, inner, capStart, capEnd, capBottom, capTop]) g.dispose();
  skin.computeBoundingSphere();
  caps.computeBoundingSphere();
  return { skin, caps };
}

function buildHubGeometry(radius: number, height: number): BufferGeometry {
  const pts = [
    new Vector2(0, 0),
    new Vector2(radius, 0),
    new Vector2(radius, height * 0.6),
    new Vector2(radius * 0.78, height),
    new Vector2(radius * 0.4, height * 1.08),
    new Vector2(0.001, height * 1.08),
  ];
  const g = new LatheGeometry(pts, 24);
  g.computeBoundingSphere();
  return g;
}

function buildHexBossGeometry(radius: number, height: number): BufferGeometry {
  const pts = [new Vector2(0.001, 0), new Vector2(radius, 0), new Vector2(radius, height), new Vector2(radius * 0.6, height * 1.3), new Vector2(0.001, height * 1.3)];
  const g = new LatheGeometry(pts, 6).toNonIndexed();
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export interface Shell {
  group: Group;
  pivots: Object3D[];
  meshes: Mesh[];
  hubTop: Group;
  hubBottom: Group;
  cleftAnchor: Object3D;
  update(shellOpen: number, doorSwing: number, hubLift: number): void;
  setDebug(material: import('three').Material | null): void;
  vertexCount: number;
  dispose(): void;
}

const _dir = new Vector3();
const _axis = new Vector3();

export function buildShell(materials: MaterialSet, detail: number): Shell {
  const group = new Group();
  group.name = 'shell';
  const pivots: Object3D[] = [];
  const pivotBase: Vector3[] = [];
  const meshes: Mesh[] = [];
  const geometries: BufferGeometry[] = [];
  let vertexCount = 0;

  for (let i = 0; i < PETALS.length; i++) {
    const thm = petalMidAngle(PETALS[i]);
    const base = new Vector3(0.35 * Math.cos(thm), -1.5, 0.35 * Math.sin(thm));
    const pivot = new Object3D();
    pivot.name = `petal-${i}`;
    pivot.position.copy(base);
    group.add(pivot);
    pivots.push(pivot);
    pivotBase.push(base);
  }

  // door petal: second (vertical) hinge at its leading edge theta = 334deg
  const doorHingeBase = new Vector3(shellR(0.5) * Math.cos(334 * DEG), 0, shellR(0.5) * Math.sin(334 * DEG));
  const doorHinge = new Object3D();
  doorHinge.name = 'door-hinge';
  doorHinge.position.copy(doorHingeBase).sub(pivotBase[DOOR_PETAL]);
  pivots[DOOR_PETAL].add(doorHinge);

  for (const def of PANELS) {
    const { skin, caps } = buildPanel(def, detail);
    geometries.push(skin, caps);
    vertexCount += skin.getAttribute('position').count + caps.getAttribute('position').count;
    const skinMesh = new Mesh(skin, materials.skin);
    const capMesh = new Mesh(caps, materials.caps);
    skinMesh.name = `skin-${def.petal}`;
    capMesh.name = `caps-${def.petal}`;
    skinMesh.frustumCulled = false; // vertex twist / ripple move the bounds
    capMesh.frustumCulled = false;
    const parent = def.petal === DOOR_PETAL ? doorHinge : pivots[def.petal];
    const origin = def.petal === DOOR_PETAL ? doorHingeBase : pivotBase[def.petal];
    skinMesh.position.copy(origin).negate();
    capMesh.position.copy(origin).negate();
    parent.add(skinMesh, capMesh);
    meshes.push(skinMesh, capMesh);
  }

  // cleft anchor: a point on the cleft lip (mid angle, mid thickness) - follows the cleft petal's hinge
  const cleftAnchor = new Object3D();
  cleftAnchor.name = 'cleft-anchor';
  {
    const th = 212 * DEG;
    const v = cleftTop(212);
    shellPoint(th, v, 0.5, PETALS[CLEFT_PETAL].delta, _p);
    cleftAnchor.position.copy(_p).sub(pivotBase[CLEFT_PETAL]);
    pivots[CLEFT_PETAL].add(cleftAnchor);
  }

  // polar hubs: chassis parts that stay fixed to the root while the petals move
  const rTop = shellR(SHELL_V1) + 0.04;
  const rBottom = shellR(SHELL_V0) + 0.04;
  const hubTopGeo = buildHubGeometry(rTop, 0.18);
  const hubBottomGeo = buildHubGeometry(rBottom, 0.16);
  const bossGeo = buildHexBossGeometry(0.09, 0.07);
  geometries.push(hubTopGeo, hubBottomGeo, bossGeo);
  const hubTop = new Group();
  hubTop.name = 'hub-top';
  {
    const m = new Mesh(hubTopGeo, materials.hub);
    const boss = new Mesh(bossGeo, materials.hub);
    boss.position.y = 0.18 * 1.08;
    hubTop.add(m, boss);
    meshes.push(m, boss);
  }
  const hubBottom = new Group();
  hubBottom.name = 'hub-bottom';
  {
    const m = new Mesh(hubBottomGeo, materials.hub);
    const boss = new Mesh(bossGeo, materials.hub);
    boss.position.y = 0.16 * 1.08;
    hubBottom.add(m, boss);
    hubBottom.rotation.x = Math.PI;
    meshes.push(m, boss);
  }
  const hubTopY = shellY(SHELL_V1) - 0.06;
  const hubBottomY = shellY(SHELL_V0) + 0.06;
  hubTop.position.y = hubTopY;
  hubBottom.position.y = hubBottomY;
  group.add(hubTop, hubBottom);
  vertexCount += hubTopGeo.getAttribute('position').count + hubBottomGeo.getAttribute('position').count + bossGeo.getAttribute('position').count * 2;

  const originalMaterials = meshes.map((m) => m.material);

  return {
    group,
    pivots,
    meshes,
    hubTop,
    hubBottom,
    cleftAnchor,
    vertexCount,
    update(shellOpen, doorSwing, hubLift) {
      const open = Math.max(0, shellOpen);
      for (let i = 0; i < PETALS.length; i++) {
        const w = PETALS[i].openWeight;
        const thm = petalMidAngle(PETALS[i]);
        _dir.set(Math.cos(thm), 0, Math.sin(thm));
        const slide = 0.55 * open * w;
        const pivot = pivots[i];
        pivot.position.copy(pivotBase[i]).addScaledVector(_dir, slide);
        _axis.set(-Math.sin(thm), 0, Math.cos(thm));
        pivot.quaternion.setFromAxisAngle(_axis, -28 * DEG * open * w);
      }
      const swingFromOpen = 60 * DEG * clamp((open - 0.5) * 2, 0, 1);
      doorHinge.rotation.y = Math.max(swingFromOpen, 90 * DEG * clamp01(doorSwing));
      hubTop.position.y = hubTopY + 0.4 * hubLift;
      hubBottom.position.y = hubBottomY - 0.25 * hubLift;
    },
    setDebug(material) {
      for (let i = 0; i < meshes.length; i++) meshes[i].material = material ?? originalMaterials[i];
    },
    dispose() {
      for (const g of geometries) g.dispose();
    },
  };
}
