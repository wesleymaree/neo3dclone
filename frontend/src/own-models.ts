// Own 3D models (fork): furniture imported from .obj or .step files. The backend keeps them apart from the
// signed packs (models.py); here they become the items of one local pack, so the library, the plan and the
// 3D view treat them like any pack furniture.

import type { FurniturePack, PackItem, PackMesh } from "./packs.ts";

/** The local pack the imported models live in. */
export const OWN_PACK_ID = "own.models";

/** A mesh as stored: positions quantised to 16 bits in the item's box, indices, optional colours (base64 each). */
export interface StoredMesh {
  /** Vertex and triangle count. */
  n: number;
  t: number;
  v: string;
  i: string;
  c?: string;
}

export interface OwnModel {
  id: string;
  name: string;
  /** Width, depth, height in metres. */
  size: [number, number, number];
  group?: string;
  mesh: StoredMesh;
  created?: number;
}

function bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
  return out;
}

/** The stored mesh as fractions of the item's box: x and z from -0.5 to 0.5 (front at +z), y from 0 to 1. */
export function decodeMesh(m: StoredMesh): PackMesh {
  const q = new Uint16Array(bytes(m.v).buffer);
  const v = new Float32Array(m.n * 3);
  for (let k = 0; k < m.n; k++) {
    v[k * 3] = q[k * 3] / 65535 - 0.5;
    v[k * 3 + 1] = q[k * 3 + 1] / 65535;
    v[k * 3 + 2] = q[k * 3 + 2] / 65535 - 0.5;
  }
  const raw = bytes(m.i);
  const i = m.n <= 65535 ? new Uint16Array(raw.buffer) : new Uint32Array(raw.buffer);
  return { v, i, c: m.c ? bytes(m.c) : null };
}

/** The pack the models make (null without any); a model that does not decode is left out. */
export function modelsPack(models: readonly OwnModel[]): FurniturePack | null {
  const items: PackItem[] = [];
  for (const m of models) {
    let mesh: PackMesh;
    try {
      mesh = decodeMesh(m.mesh);
    } catch {
      continue;
    }
    items.push({
      id: m.id,
      name: { en: m.name, de: m.name },
      size: m.size,
      group: m.group ?? "deco",
      tags: ["own", "model", "3d"],
      parts: [],
      // the plan shows its outline from above
      symbol: [{ shape: "rect", x: 0, z: 0, w: 1, d: 1 }],
      mesh,
    });
  }
  return items.length ? { id: OWN_PACK_ID, name: "My 3D models", publisher: "You", licensee: null, items } : null;
}
