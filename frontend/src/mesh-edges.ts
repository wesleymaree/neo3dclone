// Fork: the outline of an imported model – shared by the importer (which stores it) and the 3D view (older models).

/**
 * The creases of a mesh: edges where exactly two faces meet at a sharp angle. Open borders and edges shared by more
 * than two faces are left out – in converted CAD files they are the seams between separately meshed faces, which
 * would draw stray lines across smooth surfaces. Vertices at the same place count as one (files split them along
 * seams). Positions may be in any unit; `cosMax` is the cosine of the smallest angle that counts as sharp.
 */
export function featureEdges(v: ArrayLike<number>, i: ArrayLike<number>, cosMax = Math.cos((40 * Math.PI) / 180), limit = 20000): number[] {
  const n = v.length / 3;
  const same = new Map<string, number>();
  const id = new Uint32Array(n);
  for (let k = 0; k < n; k++) {
    const key = `${Math.round(v[k * 3] * 1e5)},${Math.round(v[k * 3 + 1] * 1e5)},${Math.round(v[k * 3 + 2] * 1e5)}`;
    let j = same.get(key);
    if (j === undefined) same.set(key, (j = k));
    id[k] = j;
  }
  const seen = new Map<number, { a: number; b: number; nx: number; ny: number; nz: number; faces: number; sharp: boolean }>();
  for (let t = 0; t + 2 < i.length; t += 3) {
    const tri = [id[i[t]], id[i[t + 1]], id[i[t + 2]]];
    const [p, q, r] = [tri[0] * 3, tri[1] * 3, tri[2] * 3];
    const ux = v[q] - v[p], uy = v[q + 1] - v[p + 1], uz = v[q + 2] - v[p + 2];
    const wx = v[r] - v[p], wy = v[r + 1] - v[p + 1], wz = v[r + 2] - v[p + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-14) continue;
    nx /= len;
    ny /= len;
    nz /= len;
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      if (a === b) continue;
      const key = Math.min(a, b) * 262144 + Math.max(a, b);
      const old = seen.get(key);
      if (!old) seen.set(key, { a, b, nx, ny, nz, faces: 1, sharp: false });
      else {
        old.faces++;
        // the winding may differ between the two faces: compare the lines the normals lie on
        if (Math.abs(old.nx * nx + old.ny * ny + old.nz * nz) < cosMax) old.sharp = true;
      }
    }
  }
  const out: number[] = [];
  for (const e of seen.values()) {
    if (e.faces === 2 && e.sharp) out.push(e.a, e.b);
    if (out.length >= limit * 2) break;
  }
  return out;
}
