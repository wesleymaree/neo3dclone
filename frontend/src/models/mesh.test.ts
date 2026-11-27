import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMesh, modelKindOf, modelsPack, OWN_PACK_ID } from "../own-models.ts";
import { meshEdges } from "../viewer/furniture.ts";
import { guessUnit, parseMtl, parseObj, prepare, simplify, type RawMesh } from "./mesh.ts";

// a unit cube in centimetres would be 1 cm: this one is 200 × 100 × 50 (a sofa in cm), y up
const BOX_OBJ = `
mtllib sofa.mtl
v 0 0 0
v 200 0 0
v 200 0 100
v 0 0 100
v 0 50 0
v 200 50 0
v 200 50 100
v 0 50 100
usemtl red
f 1 2 3 4
f 5 8 7 6
usemtl blue
f 1/1/1 5/1/1 6/1/1 2/1/1
f 2 6 7 3
f 3 7 8 4
f -4 -8 -5 -1
`;

test("an .obj with quads, slashes, negative indices and materials", () => {
  const mtl = parseMtl("newmtl red\nKd 1 0 0\nnewmtl blue\r\nKd 0 0 1\n");
  assert.deepEqual(mtl.get("red"), [1, 0, 0]);
  const raw = parseObj(BOX_OBJ, mtl);
  // six quads, two triangles each
  assert.equal(raw.idx.length / 3, 12);
  assert.ok(raw.col);
  // the first face is red, a later one blue
  const first = raw.idx[0] * 3;
  assert.deepEqual(raw.col.slice(first, first + 3), [1, 0, 0]);
  const last = raw.idx[raw.idx.length - 1] * 3;
  assert.deepEqual(raw.col.slice(last, last + 3), [0, 0, 1]);
  assert.throws(() => parseObj("v 0 0 0\n"), /no faces/);
  assert.throws(() => parseObj("v 0 0 0\nf 1 2 9\n"), /bad face index/);
});

test("the unit is guessed from the size; z-up files are turned so they stand", () => {
  const raw = parseObj(BOX_OBJ);
  assert.equal(raw.col, null);
  assert.equal(guessUnit(raw), "cm");
  const mm: RawMesh = { pos: raw.pos.map((x) => x * 10), idx: raw.idx, col: null };
  assert.equal(guessUnit(mm), "mm");
  const y = prepare(raw, "cm", false);
  // width 2 m, depth 1 m, height 0.5 m
  assert.deepEqual(y.size, [2, 1, 0.5]);
  // the same box lying in a CAD file (z up): 100 cm along y is its depth, 50 cm along z its height
  const cad: RawMesh = { pos: [], idx: raw.idx, col: null };
  for (let k = 0; k < raw.pos.length; k += 3) cad.pos.push(raw.pos[k], raw.pos[k + 2], raw.pos[k + 1]);
  assert.deepEqual(prepare(cad, "cm", true).size, [2, 1, 0.5]);
});

test("a stored model decodes into the item's box and becomes a pack item", () => {
  const raw = parseObj(BOX_OBJ, parseMtl("newmtl red\nKd 1 0 0\n"));
  const p = prepare(raw, "cm", false);
  const mesh = decodeMesh(p.mesh);
  assert.equal(mesh.v.length / 3, p.mesh.n);
  assert.equal(mesh.i.length, p.mesh.t * 3);
  for (let k = 0; k < mesh.v.length; k += 3) {
    assert.ok(mesh.v[k] >= -0.5 && mesh.v[k] <= 0.5);
    assert.ok(mesh.v[k + 1] >= 0 && mesh.v[k + 1] <= 1);
  }
  assert.ok(mesh.c);
  const pack = modelsPack([{ id: "abc", name: "Sofa", size: p.size, group: "sofa", mesh: p.mesh }, { id: "bad", name: "Broken", size: [1, 1, 1], mesh: { n: 3, t: 1, v: "!!", i: "!!" } }]);
  assert.equal(pack?.id, OWN_PACK_ID);
  assert.deepEqual(pack?.items.map((it) => it.id), ["abc"]);
  assert.equal(pack?.items[0].group, "sofa");
  assert.equal(modelsPack([]), null);
  // a box shows its 12 edges: the diagonals of its flat sides are no edges
  assert.equal(meshEdges(mesh).length / 2, 12);
});

test("a model with too many triangles is simplified", () => {
  // a 120 × 120 grid of quads: 28 800 triangles
  const pos: number[] = [];
  const idx: number[] = [];
  const n = 121;
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) pos.push(x / 120, Math.sin(x / 9) * 0.1, z / 120);
  for (let z = 0; z < n - 1; z++)
    for (let x = 0; x < n - 1; x++) {
      const a = z * n + x;
      idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
    }
  const raw = { pos, idx, col: null };
  assert.equal(simplify(raw), raw);
  const small = simplify(raw, 5000);
  assert.ok(small.idx.length / 3 <= 5000 && small.idx.length / 3 > 500);
  assert.ok(prepare(raw, "m", false).triangles === 28800);
});

test("the outline keeps sharp creases only: no open borders, nothing when switched off", () => {
  // an open box (no lid): its rim is a border, the four bottom edges and four upright corners are creases
  const raw = parseObj(BOX_OBJ.replace("f 5 8 7 6\n", ""));
  const p = prepare(raw, "cm", false);
  assert.equal(p.mesh.m, 8);
  assert.equal(meshEdges(decodeMesh(p.mesh)).length / 2, 8);
  const off = prepare(raw, "cm", false, false);
  assert.equal(off.mesh.m, 0);
  assert.equal(off.mesh.e, undefined);
  assert.equal(meshEdges(decodeMesh(off.mesh)).length, 0);
  // a flat sheet has no outline at all
  const sheet = parseObj("v 0 0 0\nv 1 0 0\nv 1 0 1\nv 0 0 1\nf 1 2 3 4\n");
  assert.equal(prepare(sheet, "m", false).mesh.m, 0);
});

test("what a model is decides how it behaves", () => {
  const p = prepare(parseObj(BOX_OBJ), "cm", false);
  const make = (kind: string) => modelsPack([{ id: kind, name: kind, size: p.size, kind: kind as never, mesh: p.mesh }])!.items[0];
  assert.equal(make("lamp_floor").light, "floor");
  assert.deepEqual([make("lamp_ceiling").light, make("lamp_ceiling").mount], ["ceiling", "ceiling"]);
  assert.equal(make("lamp_wall").mount, "wall");
  const tv = make("tv");
  assert.ok(tv.electric && tv.parts.some((x) => x.screen));
  assert.ok(make("appliance").electric);
  assert.equal(make("sensor").family, "sensor");
  const plain = make("furniture");
  assert.ok(!plain.light && !plain.electric && !plain.parts.length);
  assert.equal(modelKindOf(make("tv")), "tv");
  // older models have no kind: plain furniture
  const old = modelsPack([{ id: "old", name: "Old", size: p.size, mesh: { ...p.mesh, e: undefined, m: undefined } }])!.items[0];
  assert.equal(modelKindOf(old), "furniture");
  assert.equal(old.mesh?.e, null);
  // its outline is then found when drawn, with the same rules
  assert.equal(meshEdges(old.mesh!).length / 2, 12);
});

test("an imported washer, fridge or plant gets the household options of the built-in ones", async () => {
  const { applianceOf, isFridge, isPlainFridge, isPackPlant } = await import("../household.ts");
  const { packType, setPacks } = await import("../packs.ts");
  const p = prepare(parseObj(BOX_OBJ), "cm", false);
  const kinds = ["washer", "dryer", "dishwasher", "oven", "fridge", "plant", "furniture"];
  const pack = modelsPack(kinds.map((kind) => ({ id: kind, name: kind, size: p.size, kind: kind as never, mesh: p.mesh })))!;
  setPacks([pack]);
  const type = (id: string) => packType(OWN_PACK_ID, id);
  assert.deepEqual(kinds.map((k) => applianceOf(type(k))), ["washer", "dryer", "dishwasher", "oven", null, null, null]);
  assert.ok(pack.items.find((it) => it.id === "washer")?.electric);
  assert.deepEqual(kinds.map((k) => isFridge(type(k))), [false, false, false, false, true, false, false]);
  assert.ok(isPlainFridge(type("fridge")) && isFridge("fridge_smart") && !isPlainFridge("fridge_smart"));
  assert.deepEqual(kinds.map((k) => isPackPlant(type(k))), [false, false, false, false, false, true, false]);
  setPacks([]);
});
