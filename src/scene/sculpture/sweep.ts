// Generic box sweep along a curve (keel ribs, latitude ring, glass sashes, blade arcs).
// Each of the four sides is an independent strip (hard edges), plus two end caps.
// Vertex layout per ring: 8 vertices = 4 sides x 2 corners. Attributes: position, normal, uv, aT (0..1 along the curve).
// `fillSweep` writes into existing arrays so the glass sashes can be re-shaped on the CPU without reallocating.
import { BufferAttribute, BufferGeometry, Vector3 } from 'three';

export interface SweepSpec {
  segments: number;
  /** point on the curve at s in [0,1] */
  point(s: number, out: Vector3): Vector3;
  /** preferred normal direction at s (orthogonalised against the tangent) */
  normalHint(s: number, out: Vector3): Vector3;
  /** width along the binormal at s */
  width(s: number): number;
  /** thickness along the normal at s */
  height(s: number): number;
}

export interface SweepArrays {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  aT: Float32Array;
}

const _p = new Vector3();
const _pa = new Vector3();
const _pb = new Vector3();
const _t = new Vector3();
const _n = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _hint = new Vector3();

export function sweepVertexCount(segments: number): number {
  return (segments + 1) * 8 + 8;
}

export function allocateSweep(segments: number): SweepArrays {
  const n = sweepVertexCount(segments);
  return {
    position: new Float32Array(n * 3),
    normal: new Float32Array(n * 3),
    uv: new Float32Array(n * 2),
    aT: new Float32Array(n),
  };
}

function frameAt(spec: SweepSpec, s: number): void {
  const e = 1 / Math.max(spec.segments * 4, 64);
  const s0 = Math.max(0, s - e);
  const s1 = Math.min(1, s + e);
  spec.point(s0, _pa);
  spec.point(s1, _pb);
  _t.subVectors(_pb, _pa);
  if (_t.lengthSq() < 1e-12) _t.set(0, 1, 0);
  _t.normalize();
  spec.normalHint(s, _hint);
  _n.copy(_hint).addScaledVector(_t, -_hint.dot(_t));
  if (_n.lengthSq() < 1e-8) {
    // hint parallel to the tangent: pick any perpendicular
    _n.set(_t.y, -_t.x, 0);
    if (_n.lengthSq() < 1e-8) _n.set(0, -_t.z, _t.y);
  }
  _n.normalize();
  _b.crossVectors(_t, _n); // right-handed (t, n, b)
}

/** Writes positions/normals/uv/aT for the spec into the arrays (which must come from allocateSweep(spec.segments)). */
export function fillSweep(spec: SweepSpec, arrays: SweepArrays): void {
  const { position, normal, uv, aT } = arrays;
  const segs = spec.segments;
  let vi = 0;
  const put = (px: number, py: number, pz: number, nx: number, ny: number, nz: number, u: number, v: number, t: number): void => {
    position[vi * 3] = px;
    position[vi * 3 + 1] = py;
    position[vi * 3 + 2] = pz;
    normal[vi * 3] = nx;
    normal[vi * 3 + 1] = ny;
    normal[vi * 3 + 2] = nz;
    uv[vi * 2] = u;
    uv[vi * 2 + 1] = v;
    aT[vi] = t;
    vi++;
  };
  for (let i = 0; i <= segs; i++) {
    const s = i / segs;
    spec.point(s, _p);
    frameAt(spec, s);
    const hw = spec.width(s) * 0.5;
    const hh = spec.height(s) * 0.5;
    // corners c0 = +b +n, c1 = -b +n, c2 = -b -n, c3 = +b -n
    const c0x = _p.x + _b.x * hw + _n.x * hh, c0y = _p.y + _b.y * hw + _n.y * hh, c0z = _p.z + _b.z * hw + _n.z * hh;
    const c1x = _p.x - _b.x * hw + _n.x * hh, c1y = _p.y - _b.y * hw + _n.y * hh, c1z = _p.z - _b.z * hw + _n.z * hh;
    const c2x = _p.x - _b.x * hw - _n.x * hh, c2y = _p.y - _b.y * hw - _n.y * hh, c2z = _p.z - _b.z * hw - _n.z * hh;
    const c3x = _p.x + _b.x * hw - _n.x * hh, c3y = _p.y + _b.y * hw - _n.y * hh, c3z = _p.z + _b.z * hw - _n.z * hh;
    // side 0: top (+n): c0, c1
    put(c0x, c0y, c0z, _n.x, _n.y, _n.z, s, 0, s);
    put(c1x, c1y, c1z, _n.x, _n.y, _n.z, s, 1, s);
    // side 1: (-b): c1, c2
    put(c1x, c1y, c1z, -_b.x, -_b.y, -_b.z, s, 0, s);
    put(c2x, c2y, c2z, -_b.x, -_b.y, -_b.z, s, 1, s);
    // side 2: bottom (-n): c2, c3
    put(c2x, c2y, c2z, -_n.x, -_n.y, -_n.z, s, 0, s);
    put(c3x, c3y, c3z, -_n.x, -_n.y, -_n.z, s, 1, s);
    // side 3: (+b): c3, c0
    put(c3x, c3y, c3z, _b.x, _b.y, _b.z, s, 0, s);
    put(c0x, c0y, c0z, _b.x, _b.y, _b.z, s, 1, s);
  }
  // end caps (4 verts each), start cap faces -t, end cap faces +t
  for (let end = 0; end < 2; end++) {
    const s = end === 0 ? 0 : 1;
    spec.point(s, _p);
    frameAt(spec, s);
    const hw = spec.width(s) * 0.5;
    const hh = spec.height(s) * 0.5;
    const sign = end === 0 ? -1 : 1;
    const nx = _t.x * sign, ny = _t.y * sign, nz = _t.z * sign;
    _c.copy(_p).addScaledVector(_b, hw).addScaledVector(_n, hh);
    put(_c.x, _c.y, _c.z, nx, ny, nz, 0, 0, s);
    _c.copy(_p).addScaledVector(_b, -hw).addScaledVector(_n, hh);
    put(_c.x, _c.y, _c.z, nx, ny, nz, 1, 0, s);
    _c.copy(_p).addScaledVector(_b, -hw).addScaledVector(_n, -hh);
    put(_c.x, _c.y, _c.z, nx, ny, nz, 1, 1, s);
    _c.copy(_p).addScaledVector(_b, hw).addScaledVector(_n, -hh);
    put(_c.x, _c.y, _c.z, nx, ny, nz, 0, 1, s);
  }
}

export function sweepIndices(segments: number): Uint32Array {
  const idx = new Uint32Array(segments * 4 * 6 + 12);
  let k = 0;
  for (let i = 0; i < segments; i++) {
    for (let side = 0; side < 4; side++) {
      const a = i * 8 + side * 2;
      const b = a + 1;
      const c = a + 8;
      const d = c + 1;
      // outward winding for right-handed (t, n, b): (a, c, b), (b, c, d)
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }
  const capStart = (segments + 1) * 8;
  // start cap (normal -t): c0, c1, c2, c3 -> (c0,c1,c2), (c0,c2,c3)
  idx[k++] = capStart; idx[k++] = capStart + 1; idx[k++] = capStart + 2;
  idx[k++] = capStart; idx[k++] = capStart + 2; idx[k++] = capStart + 3;
  // end cap (normal +t): reversed
  const e = capStart + 4;
  idx[k++] = e; idx[k++] = e + 2; idx[k++] = e + 1;
  idx[k++] = e; idx[k++] = e + 3; idx[k++] = e + 2;
  return idx;
}

/** Builds a BufferGeometry for the spec (positions can later be refreshed with fillSweep + needsUpdate). */
export function buildSweep(spec: SweepSpec): { geometry: BufferGeometry; arrays: SweepArrays } {
  const arrays = allocateSweep(spec.segments);
  fillSweep(spec, arrays);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(arrays.position, 3));
  geometry.setAttribute('normal', new BufferAttribute(arrays.normal, 3));
  geometry.setAttribute('uv', new BufferAttribute(arrays.uv, 2));
  geometry.setAttribute('aT', new BufferAttribute(arrays.aT, 1));
  geometry.setIndex(new BufferAttribute(sweepIndices(spec.segments), 1));
  geometry.computeBoundingSphere();
  return { geometry, arrays };
}

/** Re-shapes an existing sweep geometry in place (glass sashes while ribbonTwist / ribbonSpread tween). */
export function refreshSweep(spec: SweepSpec, geometry: BufferGeometry, arrays: SweepArrays): void {
  fillSweep(spec, arrays);
  (geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
  (geometry.getAttribute('normal') as BufferAttribute).needsUpdate = true;
  geometry.computeBoundingSphere();
}

/** Circle-arc sweep spec helper (arcs, latitude ring). Lies in the XZ plane, axis +Y, starting at angle a0. */
export function arcSpec(radius: number, a0: number, a1: number, segments: number, width: number, height: number, radialWidth = true): SweepSpec {
  return {
    segments,
    point: (s, out) => {
      const a = a0 + (a1 - a0) * s;
      return out.set(Math.cos(a) * radius, 0, Math.sin(a) * radius);
    },
    // normal hint: radial if the wide side is radial (blade), else +Y
    normalHint: radialWidth ? (s, out) => out.set(0, 1, 0) : (s, out) => {
      const a = a0 + (a1 - a0) * s;
      return out.set(Math.cos(a), 0, Math.sin(a));
    },
    width: () => width,
    height: () => height,
  };
}
