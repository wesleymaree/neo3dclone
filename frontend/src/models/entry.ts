// Fork: the models bundle – reads .obj (with an optional .mtl) and .step/.iges files into furniture. Loaded only when
// an admin imports a model; STEP goes through OpenCascade (occt-import-js, LGPL-2.1), fetched from occt/ next to it.

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

/** Reads the chosen files: one model file (.obj, .step, .stp, .iges, .igs), for .obj optionally its .mtl. */
export async function readModel(files: File[]): Promise<ReadModel> {
  const model = files.find((f) => /\.(obj|step|stp|iges|igs)$/i.test(f.name));
  if (!model) throw new Error("unsupported");
  const name = stem(model.name);
  if (/\.obj$/i.test(model.name)) {
    const mtl = files.find((f) => /\.mtl$/i.test(f.name));
    const raw = parseObj(await model.text(), mtl ? parseMtl(await mtl.text()) : new Map());
    return { raw, unit: guessUnit(raw), zUp: false, name };
  }
  const lib = await loadOcct();
  const bytes = new Uint8Array(await model.arrayBuffer());
  const params = { linearUnit: "meter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.002, angularDeflection: 0.5 };
  const res = /\.(iges|igs)$/i.test(model.name) ? lib.ReadIgesFile(bytes, params) : lib.ReadStepFile(bytes, params);
  if (!res.success) throw new Error("unreadable");
  return { raw: fromOcct(res.meshes), unit: "m", zUp: true, name };
}
