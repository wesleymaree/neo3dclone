import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { Furniture } from "../model.ts";
import { modelsPack } from "../own-models.ts";
import { packItem, packType, setPacks } from "../packs.ts";
import { pushFurniture } from "../viewer/furniture.ts";
import { GeoBuffer, LineBuffer } from "../viewer/geo.ts";
import { fromOcct } from "./entry.ts";
import { prepare } from "./mesh.ts";

// the real OpenCascade build the integration ships (node runs the same wasm as the browser)
const require = createRequire(import.meta.url);
const CUBE = "node_modules/occt-import-js/test/testfiles/simple-basic-cube/cube.stp";

test("a STEP file becomes furniture the 3D view draws", async () => {
  const occt = await (require("occt-import-js") as () => Promise<{ ReadStepFile(b: Uint8Array, p: object): { success: boolean; meshes: never[] } }>)();
  const res = occt.ReadStepFile(new Uint8Array(readFileSync(CUBE)), { linearUnit: "meter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.002, angularDeflection: 0.5 });
  assert.ok(res.success);
  const raw = fromOcct(res.meshes);
  assert.ok(raw.idx.length >= 36);
  const p = prepare(raw, "m", true);
  assert.ok(p.size.every((m) => m > 0));
  const pack = modelsPack([{ id: "cube", name: "Cube", size: p.size, mesh: p.mesh }]);
  assert.ok(pack);
  setPacks([pack]);
  const type = packType(pack.id, "cube");
  assert.ok(packItem(type)?.mesh);
  const buf = new GeoBuffer();
  const lines = new LineBuffer();
  const f: Furniture = { id: "f", type, x: 1, z: 2, rotation: 30, w: 0.5, d: 0.5, h: 0.5, variant: null, entity: null, power: null };
  pushFurniture(buf, lines, new GeoBuffer(), f);
  // both sides of every triangle, standing on the floor within its box around (1, 2)
  assert.equal(buf.count, p.triangles * 2);
  assert.ok(lines.p.length >= 12 * 6);
  for (let k = 0; k < buf.p.length; k += 3) {
    assert.ok(Number.isFinite(buf.p[k]) && Math.hypot(buf.p[k] - 1, buf.p[k + 2] - 2) <= 0.36);
    assert.ok(buf.p[k + 1] >= -1e-6 && buf.p[k + 1] <= 0.5 + 1e-6);
  }
  setPacks([]);
});
