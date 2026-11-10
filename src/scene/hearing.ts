/**
 * How an arena sounds: its echo and what stands between a sound and the ear.
 *
 * - The echo from the arena's size, what its surfaces are made of (stone, glass and metal throw
 *   sound back, books, carpet and grass soak it up) and how much of it is open to the sky above
 *   (an open roof lets the sound out): Sabine's reverberation time, 0.161 V / (S a), with the open
 *   sky counted as a surface that takes everything.
 * - A wall test: whether any of the arena's fixed solids lies across the line from a sound to the
 *   ear (the shaped pieces, the decorations and what can break are left out: what muffles is
 *   walls, floors, roofs).
 */

import { Euler, Quaternion, Vector3, type Box3 } from 'three'

import type { Room } from '../audio'
import type { ArenaView, MaterialName, Vec3 } from '../protocol'

/** How much of the sound striking it a surface keeps (0 throws it all back). */
const ABSORBS: Record<MaterialName, number> = {
  plain: 0.08, plaster: 0.05, planks: 0.1, wood: 0.1, stone: 0.03, brick: 0.04, marble: 0.02, tiles: 0.03,
  carpet: 0.45, fabric: 0.5, paper: 0.3, books: 0.4, chalkboard: 0.05, metal: 0.04, brass: 0.04, glass: 0.04,
  concrete: 0.03, rock: 0.05, earth: 0.3, grass: 0.4, water: 0.02, lava: 0.03,
}

interface Block {
  centre: Vector3
  /** The turn back into the block's own frame. */
  back: Quaternion
  half: Vector3
}

export interface Hearing {
  room: Room
  occluded: (from: Vec3, to: Vec3) => boolean
}

export function hearingOf(view: ArenaView, bounds: Box3): Hearing {
  const blocks: Block[] = []
  let area = 0
  let absorbed = 0
  for (const s of view.solids) {
    const [a, b, c] = s.size
    const half = s.kind === 'cylinder' ? new Vector3(a, b / 2, a) : s.kind === 'sphere' ? new Vector3(a, a, a) : new Vector3(a / 2, b / 2, c / 2)
    const surface = 8 * (half.x * half.y + half.y * half.z + half.z * half.x)
    area += surface
    absorbed += surface * ABSORBS[s.material]
    // A mover's solids move, and a breakable piece's may be gone: neither is counted as a wall.
    if (s.mover || s.piece) continue
    blocks.push({ centre: new Vector3(...s.at), back: new Quaternion().setFromEuler(new Euler(s.rot[0], s.rot[1], s.rot[2], 'XYZ')).invert(), half })
  }
  const mean = area > 0 ? absorbed / area : 0.1

  const hit = (from: Vector3, to: Vector3): boolean => {
    for (const k of blocks) {
      const p = from.clone().sub(k.centre).applyQuaternion(k.back)
      const q = to.clone().sub(k.centre).applyQuaternion(k.back)
      // A block holding either end is what the sound sits on or in, not between.
      const inside = (v: Vector3) => Math.abs(v.x) <= k.half.x && Math.abs(v.y) <= k.half.y && Math.abs(v.z) <= k.half.z
      if (inside(p) || inside(q)) continue
      // The segment against the block's slabs.
      let t0 = 0
      let t1 = 1
      const d = q.clone().sub(p)
      let crosses = true
      for (const ax of ['x', 'y', 'z'] as const) {
        const h = k.half[ax] - 0.05
        if (h <= 0) {
          crosses = false
          break
        }
        if (Math.abs(d[ax]) < 1e-9) {
          if (Math.abs(p[ax]) > h) {
            crosses = false
            break
          }
          continue
        }
        let ta = (-h - p[ax]) / d[ax]
        let tb = (h - p[ax]) / d[ax]
        if (ta > tb) [ta, tb] = [tb, ta]
        t0 = Math.max(t0, ta)
        t1 = Math.min(t1, tb)
        if (t0 > t1) {
          crosses = false
          break
        }
      }
      if (crosses) return true
    }
    return false
  }

  // How much of the sky is open: straight up from a grid over the arena at head height.
  const size = bounds.getSize(new Vector3())
  let open = 0
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const x = bounds.min.x + size.x * (0.2 + 0.3 * i)
      const z = bounds.min.z + size.z * (0.2 + 0.3 * j)
      const y = bounds.min.y + Math.min(2.5, size.y / 2)
      if (!hit(new Vector3(x, y, z), new Vector3(x, bounds.max.y + 2, z))) open++
    }
  }
  const sky = open / 9
  const x = Math.max(4, size.x)
  const y = Math.min(30, Math.max(3, size.y))
  const z = Math.max(4, size.z)
  const volume = x * y * z
  const surface = 2 * (x * y + y * z + z * x)
  const top = (x * z) / surface
  const a = mean * (1 - sky * top) + sky * top
  const decay = Math.min(3.2, Math.max(0.25, (0.161 * volume) / (surface * a)))
  return {
    room: { decay, wet: 0.08 + 0.32 * (1 - sky) * Math.min(1, decay / 1.8), size: Math.min(30, Math.cbrt(volume) * 0.6), dark: Math.min(1, mean * 2.2) },
    occluded: (from, to) => hit(new Vector3(...from), new Vector3(...to)),
  }
}
