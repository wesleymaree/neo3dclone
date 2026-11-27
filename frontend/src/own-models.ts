// Own 3D models (fork): furniture imported from .obj or .step files. The backend keeps them apart from the
// signed packs (models.py); here they become the items of one local pack, so the library, the plan and the
// 3D view treat them like any pack furniture.

import type { FurniturePack, PackItem, PackMesh, PackPart } from "./packs.ts";

/** The local pack the imported models live in. */
export const OWN_PACK_ID = "own.models";

/** What an imported model is: decides what a linked entity does with it. */
export const MODEL_KINDS = ["furniture", "lamp_ceiling", "lamp_pendant", "lamp_floor", "lamp_table", "lamp_wall", "lamp_strip", "tv", "appliance", "sensor"] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

/** The library category a kind belongs in (offered when the kind is picked). */
export const KIND_GROUP: Record<ModelKind, string> = {
  furniture: "deco",
  lamp_ceiling: "lamp",
  lamp_pendant: "lamp",
  lamp_floor: "lamp",
  lamp_table: "lamp",
  lamp_wall: "lamp",
  lamp_strip: "lamp",
  tv: "media",
  appliance: "appliance",
  sensor: "tech",
};

/** A mesh as stored: positions quantised to 16 bits in the item's box, indices, optional colours and outline (base64). */
export interface StoredMesh {
  /** Vertex and triangle count. */
  n: number;
  t: number;
  v: string;
  i: string;
  c?: string;
  /** Outline: pairs of vertex indices (`m` of them), found when the model was imported; missing on older models. */
  e?: string;
  m?: number;
}

export interface OwnModel {
  id: string;
  name: string;
  /** Width, depth, height in metres. */
  size: [number, number, number];
  group?: string;
  kind?: ModelKind;
  mesh: StoredMesh;
  created?: number;
}

function bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
  return out;
}

const indices = (b64: string, n: number) => {
  const raw = bytes(b64);
  return n <= 65535 ? new Uint16Array(raw.buffer) : new Uint32Array(raw.buffer);
};

/** The stored mesh as fractions of the item's box: x and z from -0.5 to 0.5 (front at +z), y from 0 to 1. */
export function decodeMesh(m: StoredMesh): PackMesh {
  const q = new Uint16Array(bytes(m.v).buffer);
  const v = new Float32Array(m.n * 3);
  for (let k = 0; k < m.n; k++) {
    v[k * 3] = q[k * 3] / 65535 - 0.5;
    v[k * 3 + 1] = q[k * 3 + 1] / 65535;
    v[k * 3 + 2] = q[k * 3 + 2] / 65535 - 0.5;
  }
  return { v, i: indices(m.i, m.n), c: m.c ? bytes(m.c) : null, e: m.e ? indices(m.e, m.n) : m.m === 0 ? new Uint16Array(0) : null };
}

/** The screen of an imported TV: most of its front, above a stand. */
const TV_SCREEN: PackPart = { shape: "box", x: 0, z: 0.49, w: 0.94, d: 0.02, y: 0.1, h: 0.86, color: "dark", screen: true };

/** How a kind behaves, as pack item fields (see packs.ts and the viewer's lamps, screens and sensors). */
function behaviour(kind: ModelKind): Partial<PackItem> {
  switch (kind) {
    case "lamp_ceiling":
      return { light: "ceiling", mount: "ceiling" };
    case "lamp_pendant":
      return { light: "pendant", mount: "ceiling" };
    case "lamp_floor":
      return { light: "floor" };
    case "lamp_table":
      return { light: "table", mount: "surface" };
    case "lamp_wall":
      return { light: "wall", mount: "wall", wall_y: 1.6 };
    case "lamp_strip":
      return { light: "strip" };
    case "tv":
      return { electric: true, parts: [TV_SCREEN] };
    case "appliance":
      return { electric: true };
    case "sensor":
      return { family: "sensor" };
    default:
      return {};
  }
}

/** The kind of an own model's pack item (from its tag). */
export function modelKindOf(item: Pick<PackItem, "tags">): ModelKind {
  const tag = item.tags?.find((t) => t.startsWith("kind:"))?.slice(5);
  return (MODEL_KINDS as readonly string[]).includes(tag ?? "") ? (tag as ModelKind) : "furniture";
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
      // the kind rides along as a tag, for the editor's list of models
      tags: ["own", "model", "3d", `kind:${m.kind ?? "furniture"}`],
      parts: [],
      // the plan shows its outline from above
      symbol: [{ shape: "rect", x: 0, z: 0, w: 1, d: 1 }],
      ...behaviour(m.kind ?? "furniture"),
      mesh,
    });
  }
  return items.length ? { id: OWN_PACK_ID, name: "My 3D models", publisher: "You", licensee: null, items } : null;
}
