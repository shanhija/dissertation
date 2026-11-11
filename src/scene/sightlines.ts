/**
 * What hides one doctor from another, as the arena is drawn: whether anything that stays (the
 * arena's solids, its shaped pieces and its decorations; not glass, which is seen through, and
 * nothing that moves) lies across the line between two points. A name tag shows while its doctor
 * can be seen (2026-11-11: tags hidden by walls; tested against what is drawn where the tag
 * stands, over the head and up to 3 m tall at 40 m, a tag was cut by every balcony and lintel over
 * a doctor in plain sight). The triangles are kept in a grid of cubes, so a line is tested against
 * what it passes, not the whole arena. A piece that breaks is gone from it: its corners are drawn
 * together into a point, in the very arrays read here.
 */

import { Box3, Vector3, type BufferGeometry } from 'three'

/** Metres along a side of the grid's cubes, at the least. */
const CELL = 2
/** Cubes along the grid's longest side, at the most: a huge arena gets larger cubes, not millions of them. */
const MOST = 100

export class Sightlines {
  /** The geometries' corners, as drawn. */
  private readonly corners: ArrayLike<number>[] = []
  /** Each triangle's geometry, and where its corners start in it. */
  private readonly geometryOf: Uint16Array
  private readonly startOf: Uint32Array
  /** The triangles in each cube (x, then y, then z), none where the list is missing. */
  private readonly cells: (number[] | undefined)[]
  private readonly min: Vector3
  /** Metres along a side of a cube. */
  private readonly cell: number
  private readonly dims: [number, number, number]
  /** The query each triangle was last tested in, so a triangle in several cubes is tested once. */
  private readonly testedIn: Uint32Array
  private query = 0

  /** Unindexed triangles in the arena's frame. */
  constructor(geometries: readonly BufferGeometry[]) {
    let count = 0
    const box = new Box3()
    for (const g of geometries) {
      count += g.getAttribute('position').count / 3
      g.computeBoundingBox()
      box.union(g.boundingBox!)
    }
    this.geometryOf = new Uint16Array(count)
    this.startOf = new Uint32Array(count)
    this.testedIn = new Uint32Array(count)
    this.min = box.isEmpty() ? new Vector3() : box.min.clone()
    const size = box.isEmpty() ? new Vector3() : box.getSize(new Vector3())
    this.cell = Math.max(CELL, Math.max(size.x, size.y, size.z) / MOST)
    this.dims = [Math.max(1, Math.ceil(size.x / this.cell)), Math.max(1, Math.ceil(size.y / this.cell)), Math.max(1, Math.ceil(size.z / this.cell))]
    const [nx, ny, nz] = this.dims
    this.cells = new Array<number[] | undefined>(nx * ny * nz)
    const cellOf = (v: number, axis: 0 | 1 | 2) => Math.min(this.dims[axis] - 1, Math.max(0, Math.floor((v - this.min.getComponent(axis)) / this.cell)))
    let id = 0
    geometries.forEach((g, gi) => {
      const p = g.getAttribute('position').array
      this.corners.push(p)
      for (let s = 0; s + 8 < p.length; s += 9, id++) {
        this.geometryOf[id] = gi
        this.startOf[id] = s
        const x0 = cellOf(Math.min(p[s]!, p[s + 3]!, p[s + 6]!), 0)
        const x1 = cellOf(Math.max(p[s]!, p[s + 3]!, p[s + 6]!), 0)
        const y0 = cellOf(Math.min(p[s + 1]!, p[s + 4]!, p[s + 7]!), 1)
        const y1 = cellOf(Math.max(p[s + 1]!, p[s + 4]!, p[s + 7]!), 1)
        const z0 = cellOf(Math.min(p[s + 2]!, p[s + 5]!, p[s + 8]!), 2)
        const z1 = cellOf(Math.max(p[s + 2]!, p[s + 5]!, p[s + 8]!), 2)
        for (let x = x0; x <= x1; x++)
          for (let y = y0; y <= y1; y++)
            for (let z = z0; z <= z1; z++) {
              const k = (x * ny + y) * nz + z
              ;(this.cells[k] ??= []).push(id)
            }
      }
    })
  }

  /** Whether nothing drawn lies across the line from a to b (the cubes it passes walked in order). */
  clear(a: Vector3, b: Vector3): boolean {
    const o = [a.x, a.y, a.z]
    const d = [b.x - a.x, b.y - a.y, b.z - a.z]
    const lo = [this.min.x, this.min.y, this.min.z]
    // The part of the line inside the grid.
    let t0 = 0
    let t1 = 1
    for (let k = 0; k < 3; k++) {
      const hi = lo[k]! + this.dims[k]! * this.cell
      if (Math.abs(d[k]!) < 1e-12) {
        if (o[k]! < lo[k]! || o[k]! > hi) return true
        continue
      }
      const ta = (lo[k]! - o[k]!) / d[k]!
      const tb = (hi - o[k]!) / d[k]!
      t0 = Math.max(t0, Math.min(ta, tb))
      t1 = Math.min(t1, Math.max(ta, tb))
    }
    if (t0 > t1) return true
    const query = ++this.query
    const cell = [0, 0, 0]
    const step = [0, 0, 0]
    const next = [Infinity, Infinity, Infinity]
    const delta = [Infinity, Infinity, Infinity]
    for (let k = 0; k < 3; k++) {
      cell[k] = Math.min(this.dims[k]! - 1, Math.max(0, Math.floor((o[k]! + d[k]! * t0 - lo[k]!) / this.cell)))
      step[k] = Math.sign(d[k]!)
      if (step[k] === 0) continue
      delta[k] = this.cell / Math.abs(d[k]!)
      next[k] = (lo[k]! + (cell[k]! + (step[k]! > 0 ? 1 : 0)) * this.cell - o[k]!) / d[k]!
    }
    const [, ny, nz] = this.dims
    for (;;) {
      const list = this.cells[(cell[0]! * ny + cell[1]!) * nz + cell[2]!]
      if (list) {
        for (const t of list) {
          if (this.testedIn[t] === query) continue
          this.testedIn[t] = query
          if (this.crosses(t, o, d)) return false
        }
      }
      const k = next[0]! < next[1]! ? (next[0]! < next[2]! ? 0 : 2) : next[1]! < next[2]! ? 1 : 2
      if (next[k]! > t1) return true
      cell[k]! += step[k]!
      if (cell[k]! < 0 || cell[k]! >= this.dims[k]!) return true
      next[k]! += delta[k]!
    }
  }

  /** Whether triangle t lies across the line from o along d (between its ends: Möller and Trumbore's test). */
  private crosses(t: number, o: number[], d: number[]): boolean {
    const p = this.corners[this.geometryOf[t]!]!
    const s = this.startOf[t]!
    const ax = p[s]!
    const ay = p[s + 1]!
    const az = p[s + 2]!
    const e1x = p[s + 3]! - ax
    const e1y = p[s + 4]! - ay
    const e1z = p[s + 5]! - az
    const e2x = p[s + 6]! - ax
    const e2y = p[s + 7]! - ay
    const e2z = p[s + 8]! - az
    const px = d[1]! * e2z - d[2]! * e2y
    const py = d[2]! * e2x - d[0]! * e2z
    const pz = d[0]! * e2y - d[1]! * e2x
    const det = e1x * px + e1y * py + e1z * pz
    // Edge on to the line, or a piece broken (its corners drawn together).
    if (Math.abs(det) < 1e-12) return false
    const inv = 1 / det
    const sx = o[0]! - ax
    const sy = o[1]! - ay
    const sz = o[2]! - az
    const u = (sx * px + sy * py + sz * pz) * inv
    if (u < 0 || u > 1) return false
    const qx = sy * e1z - sz * e1y
    const qy = sz * e1x - sx * e1z
    const qz = sx * e1y - sy * e1x
    const v = (d[0]! * qx + d[1]! * qy + d[2]! * qz) * inv
    if (v < 0 || u + v > 1) return false
    const along = (e2x * qx + e2y * qy + e2z * qz) * inv
    return along > 0 && along < 1
  }
}
