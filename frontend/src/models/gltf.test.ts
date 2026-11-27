import assert from "node:assert/strict";
import { test } from "node:test";
import { readGltf, splitGlb } from "./gltf.ts";
import { prepare } from "./mesh.ts";

/** A GLB from its JSON and binary chunk (both padded to four bytes, as the format wants). */
function glb(json: object, bin: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const pad = (n: number) => (4 - (n % 4)) % 4;
  const j = new Uint8Array(text.length + pad(text.length)).fill(0x20);
  j.set(text);
  const b = new Uint8Array(bin.length + pad(bin.length));
  b.set(bin);
  const out = new Uint8Array(12 + 8 + j.length + 8 + b.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, j.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(j, 20);
  dv.setUint32(20 + j.length, b.length, true);
  dv.setUint32(24 + j.length, 0x004e4942, true);
  out.set(b, 28 + j.length);
  return out;
}

/** Bytes of several typed arrays one after another; returns their offsets too. */
function pack(...parts: ArrayBufferView[]): { bin: Uint8Array; at: number[] } {
  const at: number[] = [];
  let n = 0;
  for (const p of parts) {
    at.push(n);
    n += p.byteLength + ((4 - (p.byteLength % 4)) % 4);
  }
  const bin = new Uint8Array(n);
  parts.forEach((p, k) => bin.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), at[k]));
  return { bin, at };
}

// a unit quad (two triangles) in the xz plane at y = 0, with uvs
const QUAD = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]);
const UV = new Float32Array([0.1, 0.5, 0.9, 0.5, 0.9, 0.5, 0.1, 0.5]);
const IDX = new Uint16Array([0, 1, 2, 0, 2, 3]);
// vertex colours as normalised bytes (rgba)
const VC = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]);

function quadModel(extra: object = {}) {
  const { bin, at } = pack(QUAD, IDX, UV, VC);
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    // the parent lifts and doubles; the child turns -90° about x (the quad stands up, +z becomes +y)
    nodes: [
      { children: [1], translation: [0, 1, 0], scale: [2, 2, 2] },
      { mesh: 0, rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 2, COLOR_0: 3 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ uri: "pic.png" }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: "VEC3" },
      { bufferView: 1, componentType: 5123, count: 6, type: "SCALAR" },
      { bufferView: 2, componentType: 5126, count: 4, type: "VEC2" },
      { bufferView: 3, componentType: 5121, normalized: true, count: 4, type: "VEC4" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: at[0], byteLength: QUAD.byteLength },
      { buffer: 0, byteOffset: at[1], byteLength: IDX.byteLength },
      { buffer: 0, byteOffset: at[2], byteLength: UV.byteLength },
      { buffer: 0, byteOffset: at[3], byteLength: VC.byteLength },
    ],
    buffers: [{ byteLength: bin.length }],
    ...extra,
  };
  return { json, bin };
}

test("a GLB: its nodes place, turn and size the mesh; colours come from the material and its picture", async () => {
  const { json, bin } = quadModel();
  const parts = splitGlb(glb(json, bin));
  assert.equal(parts.bin?.length, bin.length);
  // a 2 × 1 picture: left half white, right half blue
  const decode = async () => ({ width: 2, height: 1, data: new Uint8Array([255, 255, 255, 255, 0, 0, 255, 255]) });
  const file = async (name: string) => (name === "pic.png" ? new Uint8Array([1]) : null);
  const raw = await readGltf(parts.json, { glbBin: parts.bin, decode, file });
  assert.equal(raw.idx.length / 3, 2);
  // turned upright and doubled: x 0..2, y 1..3 (z was 0..1, turned into y), z = 0
  const xs = raw.pos.filter((_, k) => k % 3 === 0);
  const ys = raw.pos.filter((_, k) => k % 3 === 1);
  const zs = raw.pos.filter((_, k) => k % 3 === 2);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [0, 2]);
  assert.deepEqual([Math.min(...ys), Math.max(...ys)].map((y) => Math.round(y * 1e6) / 1e6), [1, 3]);
  assert.ok(zs.every((z) => Math.abs(z) < 1e-6));
  // red material × picture: white on the left (u 0.1) stays red, blue on the right (u 0.9) leaves black
  assert.ok(raw.col);
  const round = (c: number[]) => c.map((x) => Math.round(x * 1000) / 1000);
  assert.deepEqual(round(raw.col.slice(0, 3)), [1, 0, 0]);
  assert.deepEqual(round(raw.col.slice(3, 6)), [0, 0, 0]);
  // without a picture decoder the material's colour stays
  const plain = await readGltf(parts.json, { glbBin: parts.bin });
  assert.deepEqual(round(plain.col?.slice(3, 6) ?? []), [1, 0, 0]);
  // and it becomes furniture: 2 m wide, 2 m high, flat
  const p = prepare(raw, "m", false);
  assert.deepEqual(p.size, [2, 0.01, 2]);
});

test("a .gltf takes its .bin from the chosen files or a data URI; compressed files are refused", async () => {
  const { json, bin } = quadModel({ buffers: [{ uri: "model.bin", byteLength: 0 }] });
  const files = new Map([["model.bin", bin]]);
  const raw = await readGltf(json as never, { file: async (name) => files.get(name) ?? null });
  assert.equal(raw.idx.length, 6);
  await assert.rejects(readGltf(json as never, { file: async () => null }), /missing_bin/);
  const b64 = btoa(String.fromCharCode(...bin));
  const inline = await readGltf({ ...json, buffers: [{ uri: `data:application/octet-stream;base64,${b64}`, byteLength: bin.length }] } as never, {});
  assert.equal(inline.idx.length, 6);
  await assert.rejects(readGltf({ ...json, extensionsRequired: ["KHR_draco_mesh_compression"] } as never, {}), /compressed/);
  assert.throws(() => splitGlb(new Uint8Array(40)), /unreadable/);
});

test("triangle strips and fans, and meshes without indices", async () => {
  const strip = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 2, 0]);
  const { bin, at } = pack(strip);
  const base = {
    asset: { version: "2.0" },
    nodes: [{ mesh: 0 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 5, type: "VEC3" }],
    bufferViews: [{ buffer: 0, byteOffset: at[0], byteLength: strip.byteLength }],
    buffers: [{ byteLength: bin.length }],
  };
  const asStrip = await readGltf({ ...base, meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 5 }] }] } as never, { glbBin: bin });
  assert.equal(asStrip.idx.length / 3, 3);
  assert.equal(asStrip.col, null);
  const asFan = await readGltf({ ...base, meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 6 }] }] } as never, { glbBin: bin });
  assert.equal(asFan.idx.length / 3, 3);
  const lines = readGltf({ ...base, meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 1 }] }] } as never, { glbBin: bin });
  await assert.rejects(lines, /no faces/);
});
