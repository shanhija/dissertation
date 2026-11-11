/**
 * How an arena is lit by its place: how much of it is open to the sky. A courtyard takes the sky's
 * light from all round and the sun; a hall under a roof takes what comes in at its windows and
 * its own lamps (2026-11-11: lit as if under an open sky, interiors looked flat, their lamps made
 * no pools, and the engraving judged against the sun covered whole walls). A roof is whatever is
 * drawn over the floor and stays: the arena's solids, its shaped pieces and its decorations (a
 * dome is often a decoration), not glass, which lets the light through, and nothing that moves.
 */

import { Vector3, type Box3, type BufferGeometry } from 'three'

/** Places across the arena looked up from, this many by this many. */
const GRID = 5
/** Metres over a floor that something must be to roof it, not furnish it (a table, a bench). */
const CLEAR = 2

/**
 * 0 roofed over, 1 open to the sky: at each of a grid of places over the middle of the arena,
 * whether the underside of anything is drawn more than a doctor's height over the floor there
 * (the lowest surface facing up; a bowl or a terrace is its own floor). Roofs: unindexed
 * triangles, in the arena's frame.
 */
export function openSky(roofs: readonly BufferGeometry[], bounds: Box3): number {
  const size = bounds.getSize(new Vector3())
  const xs = Array.from({ length: GRID }, (_, i) => bounds.min.x + size.x * (0.2 + (0.6 * i) / (GRID - 1)))
  const zs = Array.from({ length: GRID }, (_, i) => bounds.min.z + size.z * (0.2 + (0.6 * i) / (GRID - 1)))
  // In each place, the lowest floor and the highest underside.
  const floor = new Array<number>(GRID * GRID).fill(Infinity)
  const under = new Array<number>(GRID * GRID).fill(-Infinity)
  for (const g of roofs) {
    const p = g.getAttribute('position').array
    for (let t = 0; t + 8 < p.length; t += 9) {
      const ax = p[t]!
      const ay = p[t + 1]!
      const az = p[t + 2]!
      const bx = p[t + 3]!
      const by = p[t + 4]!
      const bz = p[t + 5]!
      const cx = p[t + 6]!
      const cy = p[t + 7]!
      const cz = p[t + 8]!
      // Seen from above (a wall is an edge), and which way it faces.
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
      if (Math.abs(d) < 1e-9) continue
      const up = (bz - az) * (cx - ax) - (bx - ax) * (cz - az) > 0
      for (let i = 0; i < GRID; i++) {
        const x = xs[i]!
        if (x < Math.min(ax, bx, cx) || x > Math.max(ax, bx, cx)) continue
        for (let j = 0; j < GRID; j++) {
          const z = zs[j]!
          if (z < Math.min(az, bz, cz) || z > Math.max(az, bz, cz)) continue
          const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d
          const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d
          if (u < 0 || v < 0 || u + v > 1) continue
          const y = u * ay + v * by + (1 - u - v) * cy
          const k = i * GRID + j
          if (up) floor[k] = Math.min(floor[k]!, y)
          else under[k] = Math.max(under[k]!, y)
        }
      }
    }
  }
  return floor.filter((f, k) => !(under[k]! > f + CLEAR)).length / (GRID * GRID)
}
