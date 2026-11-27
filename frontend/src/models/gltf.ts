// Fork: reading glTF models (.glb, or .gltf with its .bin and pictures) into triangles with vertex colours.
// Every mesh of the scene with its node's place, turn and size; colours from the material's base colour, the vertex
// colours and the base colour picture (sampled at each vertex). glTF is in metres with y up. Compressed meshes (Draco,
// meshopt) are refused.

import type { RawMesh } from "./mesh.ts";

/** A decoded picture: rgba bytes, row by row. */
export interface Picture {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** Where the parts of a glTF come from: the GLB's own binary chunk, files chosen with it, data URIs. */
export interface GltfSources {
  /** The GLB's binary chunk (buffer 0 without a uri). */
  glbBin?: Uint8Array | null;
  /** A file chosen with the .gltf, by its name (a .bin, a picture). */
  file?: (name: string) => Promise<Uint8Array | null>;
  /** Decodes a picture; without it pictures are left out and the material's colour is used. */
  decode?: (bytes: Uint8Array, mime: string) => Promise<Picture | null>;
}

interface Accessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  sparse?: unknown;
}

interface Gltf {
  asset?: { version?: string };
  extensionsRequired?: string[];
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: { children?: number[]; mesh?: number; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number; material?: number; mode?: number }[] }[];
  materials?: { pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: { index: number; texCoord?: number } } }[];
  textures?: { source?: number }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string }[];
  accessors?: Accessor[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  buffers?: { uri?: string; byteLength: number }[];
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const SIZES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
// a normalised integer's largest value
const NORM: Record<number, number> = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535, 5125: 4294967295 };

/** Splits a .glb into its JSON and its binary chunk. */
export function splitGlb(bytes: Uint8Array): { json: Gltf; bin: Uint8Array | null } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error("unreadable");
  if (dv.getUint32(4, true) !== 2) throw new Error("unreadable");
  let json: Gltf | null = null;
  let bin: Uint8Array | null = null;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const len = dv.getUint32(at, true);
    const kind = dv.getUint32(at + 4, true);
    const body = bytes.subarray(at + 8, at + 8 + len);
    if (kind === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body)) as Gltf;
    else if (kind === 0x004e4942) bin = body;
    at += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error("unreadable");
  return { json, bin };
}

function dataUri(uri: string): Uint8Array | null {
  const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(uri);
  if (!m) return null;
  if (!m[1]) return new TextEncoder().encode(decodeURIComponent(m[2]));
  const bin = atob(m[2]);
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
  return out;
}

const baseName = (uri: string) => decodeURIComponent(uri.split(/[\\/]/).pop() ?? uri);

/** Column-major 4×4 matrices: a × b. */
function mul(a: number[], b: number[]): number[] {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

function nodeMatrix(n: NonNullable<Gltf["nodes"]>[number]): number[] {
  if (n.matrix?.length === 16) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/** glTF colours are linear: the screen's values (sRGB), as the other formats give them. */
const toScreen = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055);

/** Reads a glTF (its JSON and where its data comes from) into triangles. */
export async function readGltf(json: Gltf, src: GltfSources): Promise<RawMesh> {
  const compressed = (json.extensionsRequired ?? []).find((e) => /draco|meshopt|quantization/i.test(e));
  if (compressed) throw new Error("compressed");
  // the buffers: the GLB's chunk, a data URI, or a file chosen with the .gltf
  const buffers: Uint8Array[] = [];
  for (const [k, b] of (json.buffers ?? []).entries()) {
    let data: Uint8Array | null = null;
    if (!b.uri) data = k === 0 ? (src.glbBin ?? null) : null;
    else data = dataUri(b.uri) ?? (await src.file?.(baseName(b.uri))) ?? null;
    if (!data) throw new Error("missing_bin");
    buffers.push(data);
  }
  const view = (i: number): { bytes: Uint8Array; stride?: number } => {
    const v = json.bufferViews?.[i];
    if (!v) throw new Error("unreadable");
    const buf = buffers[v.buffer];
    return { bytes: buf.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength), stride: v.byteStride };
  };
  /** An accessor's values as floats (normalised integers scaled to 0..1 or -1..1). */
  const read = (i: number): { values: Float64Array; size: number; count: number } => {
    const a = json.accessors?.[i];
    if (!a) throw new Error("unreadable");
    const size = COMPONENTS[a.type] ?? 1;
    const values = new Float64Array(a.count * size);
    if (a.bufferView === undefined) return { values, size, count: a.count };
    const { bytes, stride } = view(a.bufferView);
    const comp = SIZES[a.componentType];
    if (!comp) throw new Error("unreadable");
    const step = stride || comp * size;
    const dv = new DataView(bytes.buffer, bytes.byteOffset + (a.byteOffset ?? 0), bytes.byteLength - (a.byteOffset ?? 0));
    for (let k = 0; k < a.count; k++)
      for (let c = 0; c < size; c++) {
        const at = k * step + c * comp;
        let x: number;
        switch (a.componentType) {
          case 5126: x = dv.getFloat32(at, true); break;
          case 5125: x = dv.getUint32(at, true); break;
          case 5123: x = dv.getUint16(at, true); break;
          case 5122: x = dv.getInt16(at, true); break;
          case 5121: x = dv.getUint8(at); break;
          default: x = dv.getInt8(at);
        }
        values[k * size + c] = a.normalized ? Math.max(-1, x / NORM[a.componentType]) : x;
      }
    return { values, size, count: a.count };
  };
  // the pictures, decoded once each (null: left out)
  const pictures = new Map<number, Promise<Picture | null>>();
  const picture = (image: number): Promise<Picture | null> => {
    let hit = pictures.get(image);
    if (!hit) {
      hit = (async () => {
        const img = json.images?.[image];
        if (!img || !src.decode) return null;
        let bytes: Uint8Array | null = null;
        if (img.bufferView !== undefined) bytes = view(img.bufferView).bytes;
        else if (img.uri) bytes = dataUri(img.uri) ?? (await src.file?.(baseName(img.uri))) ?? null;
        if (!bytes) return null;
        const mime = img.mimeType ?? (/\.jpe?g$/i.test(img.uri ?? "") ? "image/jpeg" : "image/png");
        return src.decode(bytes, mime).catch(() => null);
      })();
      pictures.set(image, hit);
    }
    return hit;
  };

  const pos: number[] = [];
  const idx: number[] = [];
  const col: number[] = [];
  let coloured = false;
  const drawn = async (meshIndex: number, m: number[]) => {
    const mesh = json.meshes?.[meshIndex];
    for (const prim of mesh?.primitives ?? []) {
      const mode = prim.mode ?? 4;
      if (mode < 4 || prim.attributes.POSITION === undefined) continue;
      const p = read(prim.attributes.POSITION);
      const first = pos.length / 3;
      for (let k = 0; k < p.count; k++) {
        const x = p.values[k * 3], y = p.values[k * 3 + 1], z = p.values[k * 3 + 2];
        pos.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
      }
      // colour: the material's base colour × vertex colour × its picture at the vertex
      const mat = prim.material !== undefined ? json.materials?.[prim.material]?.pbrMetallicRoughness : undefined;
      const factor = mat?.baseColorFactor ?? [1, 1, 1, 1];
      const vc = prim.attributes.COLOR_0 !== undefined ? read(prim.attributes.COLOR_0) : null;
      const tex = mat?.baseColorTexture;
      const source = tex ? json.textures?.[tex.index]?.source : undefined;
      const pic = source !== undefined ? await picture(source) : null;
      const uvAttr = prim.attributes[`TEXCOORD_${tex?.texCoord ?? 0}`];
      const uv = pic && uvAttr !== undefined ? read(uvAttr) : null;
      if (mat || vc || pic) coloured = true;
      for (let k = 0; k < p.count; k++) {
        let r = factor[0], g = factor[1], b = factor[2];
        if (vc) {
          r *= vc.values[k * vc.size];
          g *= vc.values[k * vc.size + 1];
          b *= vc.values[k * vc.size + 2];
        }
        r = toScreen(r);
        g = toScreen(g);
        b = toScreen(b);
        if (pic && uv) {
          // repeat wrapping; the picture is already in screen values
          const u = uv.values[k * 2] - Math.floor(uv.values[k * 2]);
          const v = uv.values[k * 2 + 1] - Math.floor(uv.values[k * 2 + 1]);
          const px = Math.min(pic.width - 1, Math.floor(u * pic.width));
          const py = Math.min(pic.height - 1, Math.floor(v * pic.height));
          const o = (py * pic.width + px) * 4;
          r *= pic.data[o] / 255;
          g *= pic.data[o + 1] / 255;
          b *= pic.data[o + 2] / 255;
        }
        col.push(r, g, b);
      }
      const ids = prim.indices !== undefined ? Array.from(read(prim.indices).values) : Array.from({ length: p.count }, (_, k) => k);
      if (mode === 4) for (let k = 0; k + 2 < ids.length; k += 3) idx.push(first + ids[k], first + ids[k + 1], first + ids[k + 2]);
      else if (mode === 5) for (let k = 0; k + 2 < ids.length; k++) idx.push(first + ids[k], first + ids[k + (k % 2 ? 2 : 1)], first + ids[k + (k % 2 ? 1 : 2)]);
      else if (mode === 6) for (let k = 1; k + 1 < ids.length; k++) idx.push(first + ids[0], first + ids[k], first + ids[k + 1]);
    }
  };
  const visit = async (node: number, parent: number[], depth: number) => {
    const n = json.nodes?.[node];
    if (!n || depth > 64) return;
    const m = mul(parent, nodeMatrix(n));
    if (n.mesh !== undefined) await drawn(n.mesh, m);
    for (const c of n.children ?? []) await visit(c, m, depth + 1);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = json.scenes?.[json.scene ?? 0];
  if (scene?.nodes) for (const n of scene.nodes) await visit(n, identity, 0);
  else if (json.nodes?.length) {
    // no scene: every node that is nobody's child
    const children = new Set(json.nodes.flatMap((n) => n.children ?? []));
    for (let n = 0; n < json.nodes.length; n++) if (!children.has(n)) await visit(n, identity, 0);
  } else for (let k = 0; k < (json.meshes?.length ?? 0); k++) await drawn(k, identity);
  if (!idx.length) throw new Error("no faces");
  return { pos, idx, col: coloured ? col : null };
}
