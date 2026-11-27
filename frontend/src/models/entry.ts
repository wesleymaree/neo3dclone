// Fork: the models bundle – reads .obj (with an optional .mtl) and .step/.iges files into furniture. Loaded only when
// an admin imports a model; STEP goes through OpenCascade (occt-import-js, LGPL-2.1), fetched from occt/ next to it.

import { readGltf, splitGlb, type Picture } from "./gltf.ts";
import { guessUnit, parseMtl, parseObj, prepare, UNITS, type Prepared, type RawMesh, type Unit } from "./mesh.ts";

export { prepare, UNITS, type Prepared, type RawMesh, type Unit };

export interface ReadModel {
  raw: RawMesh;
  /** The unit the file most likely uses (STEP files are converted to metres). */
  unit: Unit;
  /** CAD files stand on the xy plane, z up; .obj files usually have y up. */
  zUp: boolean;
  /** The file's name without its extension, as a first name for the model. */
  name: string;
}

interface OcctMesh {
  color?: [number, number, number];
  brep_faces?: { first: number; last: number; color: [number, number, number] | null }[];
  attributes: { position: { array: number[] } };
  index: { array: number[] };
}

interface Occt {
  ReadStepFile(content: Uint8Array, params: Record<string, unknown> | null): { success: boolean; meshes: OcctMesh[] };
  ReadIgesFile(content: Uint8Array, params: Record<string, unknown> | null): { success: boolean; meshes: OcctMesh[] };
}

let occt: Promise<Occt> | undefined;

/** OpenCascade, loaded once: its script defines the global `occtimportjs`, which fetches the wasm beside it. */
function loadOcct(): Promise<Occt> {
  const base = new URL("./occt/", new URL(import.meta.url)).href;
  occt ??= new Promise<Occt>((resolve, reject) => {
    const start = () => (globalThis as unknown as { occtimportjs: (o: object) => Promise<Occt> }).occtimportjs({ locateFile: (f: string) => base + f }).then(resolve, reject);
    if ((globalThis as { occtimportjs?: unknown }).occtimportjs) return start();
    const script = document.createElement("script");
    script.src = `${base}occt-import-js.js`;
    script.onload = start;
    script.onerror = () => reject(new Error("OpenCascade could not be loaded"));
    document.head.appendChild(script);
  }).catch((err) => {
    occt = undefined;
    throw err;
  });
  return occt;
}

/** The meshes OpenCascade made, as one: a face's own colour first, then its mesh's colour. */
export function fromOcct(meshes: OcctMesh[]): RawMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  const col: number[] = [];
  let coloured = false;
  for (const m of meshes) {
    const p = m.attributes.position.array;
    const ix = m.index.array;
    const faceColour = new Array<[number, number, number] | null>(ix.length / 3).fill(m.color ?? null);
    for (const f of m.brep_faces ?? []) if (f.color) for (let t = f.first; t <= f.last; t++) faceColour[t] = f.color;
    if (faceColour.some((c) => c)) coloured = true;
    // one vertex per mesh vertex and colour (faces of different colours keep their own edges)
    const made = new Map<string, number>();
    for (let t = 0; t < ix.length / 3; t++) {
      const c = faceColour[t] ?? [0.7, 0.7, 0.7];
      for (let k = 0; k < 3; k++) {
        const v = ix[t * 3 + k];
        const key = `${v}|${c[0]},${c[1]},${c[2]}`;
        let out = made.get(key);
        if (out === undefined) {
          out = pos.length / 3;
          made.set(key, out);
          pos.push(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
          col.push(c[0], c[1], c[2]);
        }
        idx.push(out);
      }
    }
  }
  if (!idx.length) throw new Error("no faces");
  return { pos, idx, col: coloured ? col : null };
}

const stem = (name: string) => name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 80) || "Model";

/**
 * Reads the chosen files: one model file (.obj, .glb, .gltf, .step, .stp, .iges, .igs); for .obj optionally its .mtl,
 * for .gltf its .bin and pictures.
 */
/** A picture of a glTF, decoded in the browser (at most 1024 px a side – enough to colour the vertices). */
async function decodePicture(bytes: Uint8Array, mime: string): Promise<Picture | null> {
  if (typeof createImageBitmap !== "function") return null;
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  const k = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
}

/** glTF is in metres – but many exports are not: a model larger than 10 m gets the unit that makes it furniture-sized. */
function gltfUnit(raw: RawMesh): Unit {
  let big = 0;
  for (let a = 0; a < 3; a++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = a; k < raw.pos.length; k += 3) {
      lo = Math.min(lo, raw.pos[k]);
      hi = Math.max(hi, raw.pos[k]);
    }
    big = Math.max(big, hi - lo);
  }
  return big > 10 ? guessUnit(raw) : "m";
}

export async function readModel(files: File[]): Promise<ReadModel> {
  const model = files.find((f) => /\.(obj|glb|gltf|step|stp|iges|igs)$/i.test(f.name));
  if (!model) throw new Error("unsupported");
  const name = stem(model.name);
  // glTF: metres, y up
  if (/\.glb$/i.test(model.name)) {
    const { json, bin } = splitGlb(new Uint8Array(await model.arrayBuffer()));
    const raw = await readGltf(json, { glbBin: bin, decode: decodePicture });
    return { raw, unit: gltfUnit(raw), zUp: false, name };
  }
  if (/\.gltf$/i.test(model.name)) {
    // its .bin and pictures are the files chosen with it, found by name
    const file = async (wanted: string) => {
      const f = files.find((x) => x.name.toLowerCase() === wanted.toLowerCase());
      return f ? new Uint8Array(await f.arrayBuffer()) : null;
    };
    const raw = await readGltf(JSON.parse(await model.text()), { file, decode: decodePicture });
    return { raw, unit: gltfUnit(raw), zUp: false, name };
  }
  if (/\.obj$/i.test(model.name)) {
    const mtl = files.find((f) => /\.mtl$/i.test(f.name));
    const raw = parseObj(await model.text(), mtl ? parseMtl(await mtl.text()) : new Map());
    return { raw, unit: guessUnit(raw), zUp: false, name };
  }
  const lib = await loadOcct();
  const bytes = new Uint8Array(await model.arrayBuffer());
  const params = { linearUnit: "meter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.001, angularDeflection: 0.35 };
  const res = /\.(iges|igs)$/i.test(model.name) ? lib.ReadIgesFile(bytes, params) : lib.ReadStepFile(bytes, params);
  if (!res.success) throw new Error("unreadable");
  return { raw: fromOcct(res.meshes), unit: "m", zUp: true, name };
}
