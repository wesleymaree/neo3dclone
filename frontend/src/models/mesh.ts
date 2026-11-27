// Fork: turning a model file's triangles into furniture – units, the up axis, the item's box, simplifying, and the
// compact form the backend keeps (models.py). Pure functions, tested in mesh.test.ts.

import { featureEdges } from "../mesh-edges.ts";
import type { StoredMesh } from "../own-models.ts";

/** Triangles as read from a file: xyz per vertex, three indices per triangle, optional rgb (0..1) per vertex. */
export interface RawMesh {
  pos: number[];
  idx: number[];
  col: number[] | null;
}

export type Unit = "mm" | "cm" | "m" | "in" | "ft";
export const UNITS: readonly Unit[] = ["mm", "cm", "m", "in", "ft"];
const METRES: Record<Unit, number> = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254, ft: 0.3048 };

/** Most triangles kept per model (the backend takes up to 60 000); a finer file is simplified. */
export const MAX_TRIANGLES = 50000;
const MAX_VERTICES = 65535 * 2;

/** Colours of the materials in an .mtl file (their diffuse colour, Kd). */
export function parseMtl(text: string): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>();
  let name: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("newmtl ")) name = line.slice(7).trim();
    else if (name && line.startsWith("Kd ")) {
      const [r, g, b] = line.slice(3).trim().split(/\s+/).map(Number);
      if ([r, g, b].every((x) => Number.isFinite(x))) out.set(name, [r, g, b]);
    }
  }
  return out;
}

/**
 * The triangles of an .obj file: polygons are fanned, negative indices count from the end, colours come from the
 * materials (usemtl with the .mtl's Kd) or from vertex colours ("v x y z r g b").
 */
export function parseObj(text: string, materials: Map<string, [number, number, number]> = new Map()): RawMesh {
  const vs: number[] = [];
  const vc: number[] = [];
  let vertexColours = false;
  const pos: number[] = [];
  const idx: number[] = [];
  const col: number[] = [];
  let coloured = false;
  let current: [number, number, number] | null = null;
  // one output vertex per file vertex and colour
  const made = new Map<string, number>();
  const vertex = (ref: string): number => {
    const n = parseInt(ref.split("/")[0], 10);
    const k = n < 0 ? vs.length / 3 + n : n - 1;
    if (!Number.isFinite(k) || k < 0 || k >= vs.length / 3) throw new Error("bad face index");
    const rgb = current ?? (vertexColours ? [vc[k * 3], vc[k * 3 + 1], vc[k * 3 + 2]] : null);
    const key = rgb ? `${k}|${rgb.join(",")}` : `${k}`;
    let out = made.get(key);
    if (out === undefined) {
      out = pos.length / 3;
      made.set(key, out);
      pos.push(vs[k * 3], vs[k * 3 + 1], vs[k * 3 + 2]);
      if (rgb) coloured = true;
      col.push(...(rgb ?? [-1, -1, -1]));
    }
    return out;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("v ")) {
      const p = line.slice(2).trim().split(/\s+/).map(Number);
      vs.push(p[0] || 0, p[1] || 0, p[2] || 0);
      if (p.length >= 6 && p.slice(3, 6).every((x) => Number.isFinite(x))) {
        vertexColours = true;
        // some exporters write 0..255
        const scale = Math.max(p[3], p[4], p[5]) > 1 ? 255 : 1;
        vc.push(p[3] / scale, p[4] / scale, p[5] / scale);
      } else vc.push(-1, -1, -1);
    } else if (line.startsWith("usemtl ")) current = materials.get(line.slice(7).trim()) ?? null;
    else if (line.startsWith("f ")) {
      const refs = line.slice(2).trim().split(/\s+/);
      if (refs.length < 3) continue;
      const ids = refs.map(vertex);
      for (let k = 1; k + 1 < ids.length; k++) idx.push(ids[0], ids[k], ids[k + 1]);
    }
  }
  if (!idx.length) throw new Error("no faces");
  // vertices without a colour among coloured ones take a neutral grey
  return { pos, idx, col: coloured ? col.map((x) => (x < 0 ? 0.7 : x)) : null };
}

/** The unit that makes the model a piece of furniture's size (its largest side between 10 cm and 6 m). */
export function guessUnit(raw: RawMesh): Unit {
  const span = extent(raw.pos);
  const big = Math.max(span[0], span[1], span[2]);
  for (const u of ["m", "cm", "mm"] as const) if (big * METRES[u] >= 0.1 && big * METRES[u] <= 6) return u;
  return big > 6 ? "mm" : "m";
}

function extent(pos: number[]): [number, number, number] {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < pos.length; k += 3)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], pos[k + a]);
      hi[a] = Math.max(hi[a], pos[k + a]);
    }
  return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
}

/** Fewer triangles by merging the vertices in each cell of a grid (finer grids first) until the model fits. */
export function simplify(raw: RawMesh, maxTriangles = MAX_TRIANGLES): RawMesh {
  if (raw.idx.length / 3 <= maxTriangles && raw.pos.length / 3 <= MAX_VERTICES) return raw;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < raw.pos.length; k += 3)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], raw.pos[k + a]);
      hi[a] = Math.max(hi[a], raw.pos[k + a]);
    }
  const big = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  for (let cells = 400; cells >= 8; cells = Math.floor(cells * 0.8)) {
    const step = big / cells;
    const cellOf = new Map<string, number>();
    const sum: number[] = [];
    const csum: number[] = [];
    const count: number[] = [];
    const map = new Int32Array(raw.pos.length / 3);
    for (let k = 0; k < map.length; k++) {
      const key = `${Math.floor((raw.pos[k * 3] - lo[0]) / step)},${Math.floor((raw.pos[k * 3 + 1] - lo[1]) / step)},${Math.floor((raw.pos[k * 3 + 2] - lo[2]) / step)}`;
      let c = cellOf.get(key);
      if (c === undefined) {
        c = count.length;
        cellOf.set(key, c);
        sum.push(0, 0, 0);
        csum.push(0, 0, 0);
        count.push(0);
      }
      map[k] = c;
      count[c]++;
      for (let a = 0; a < 3; a++) {
        sum[c * 3 + a] += raw.pos[k * 3 + a];
        if (raw.col) csum[c * 3 + a] += raw.col[k * 3 + a];
      }
    }
    const idx: number[] = [];
    const seen = new Set<string>();
    for (let t = 0; t < raw.idx.length; t += 3) {
      const a = map[raw.idx[t]];
      const b = map[raw.idx[t + 1]];
      const c = map[raw.idx[t + 2]];
      if (a === b || b === c || a === c) continue;
      const key = [a, b, c].sort((x, y) => x - y).join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      idx.push(a, b, c);
    }
    if (idx.length / 3 > maxTriangles || count.length > MAX_VERTICES) continue;
    const pos = sum.map((x, k) => x / count[Math.floor(k / 3)]);
    const col = raw.col ? csum.map((x, k) => x / count[Math.floor(k / 3)]) : null;
    return { pos, idx, col };
  }
  throw new Error("too detailed");
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
  return btoa(bin);
}

export interface Prepared {
  /** Width (x), depth (z), height (y) in metres. */
  size: [number, number, number];
  mesh: StoredMesh;
  triangles: number;
  /** The file had more triangles than kept. */
  simplified: boolean;
}

/**
 * The model as furniture (with its outline unless `outline` is false): turned so y is up (a file with z up is turned forward), scaled to metres, fitted into its box
 * (x and z from -0.5 to 0.5 around the middle, y from 0 at its bottom) and quantised to 16 bits.
 */
export function prepare(raw: RawMesh, unit: Unit, zUp: boolean, outline = true): Prepared {
  const small = simplify(raw);
  const n = small.pos.length / 3;
  const s = METRES[unit];
  const p = new Float64Array(n * 3);
  for (let k = 0; k < n; k++) {
    const x = small.pos[k * 3] * s;
    const y = small.pos[k * 3 + 1] * s;
    const z = small.pos[k * 3 + 2] * s;
    // z up (CAD): its y axis points away from the viewer, so it becomes -z (the front stays the front)
    p[k * 3] = x;
    p[k * 3 + 1] = zUp ? z : y;
    p[k * 3 + 2] = zUp ? -y : z;
  }
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < n; k++)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], p[k * 3 + a]);
      hi[a] = Math.max(hi[a], p[k * 3 + a]);
    }
  const span = [0, 1, 2].map((a) => Math.max(hi[a] - lo[a], 1e-6));
  const q = new Uint16Array(n * 3);
  for (let k = 0; k < n; k++) for (let a = 0; a < 3; a++) q[k * 3 + a] = Math.round(((p[k * 3 + a] - lo[a]) / span[a]) * 65535);
  const index = n <= 65535 ? new Uint16Array(small.idx) : new Uint32Array(small.idx);
  const mesh: StoredMesh = { n, t: small.idx.length / 3, v: base64(new Uint8Array(q.buffer)), i: base64(new Uint8Array(index.buffer)) };
  if (small.col) mesh.c = base64(Uint8Array.from(small.col, (x) => Math.round(Math.min(1, Math.max(0, x)) * 255)));
  // the outline along its sharp edges, found here in metres (true angles); none when switched off
  const edges = outline ? featureEdges(p, small.idx) : [];
  mesh.m = edges.length / 2;
  if (edges.length) mesh.e = base64(new Uint8Array((n <= 65535 ? new Uint16Array(edges) : new Uint32Array(edges)).buffer));
  // at least a centimetre each way, so a flat model (a picture, a rug) stays placeable
  const size = [span[0], span[2], span[1]].map((m) => Math.max(0.01, Math.round(m * 1000) / 1000)) as [number, number, number];
  return { size, mesh, triangles: mesh.t, simplified: small !== raw };
}
