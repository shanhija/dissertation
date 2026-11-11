import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  Euler,
  ExtrudeGeometry,
  Float32BufferAttribute,
  LatheGeometry,
  Matrix4,
  Quaternion,
  Shape as Outline,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

import type { Recipe, Shape } from './kit'

/**
 * A model's recipe as three.js geometry: every shape becomes its geometry (low-poly: spheres
 * 12 x 8, cylinders, lathes and capsules 12 round), moved, turned and stretched as the shape
 * says and painted its colour per vertex; then each part's shapes are merged into one geometry,
 * its glowing shapes into a second, so a whole bicycle draws in a few calls. The page draws
 * the geometry in its own materials (scene/models.ts); the sim reads its triangles for a
 * collider that is exactly the model's shape (sim/shapes.ts).
 */

/**
 * What the geometry is for. Drawn, an open shell (a dome, a bowl, a bell, a hat's brim: a lathe
 * whose profile neither ends on its axis at both ends nor comes back to where it began) has an
 * inside too, faces turned inward over the outward ones, so it shows from within (a dome Opus
 * builds over a room was sky from inside). A collider has no sides to show, and its triangles
 * count against the arena's budget: it gets the shell once.
 *
 * Worn by a doctor, it is drawn as drawn but finer and soft (2026-11-11: "many things are pointy
 * and sharp"): round shapes with half again the sides (a quarter past WORN_FINE shapes), a box's
 * edges, a cylinder's rims, the corners of a lathe's profile and of an outline rounded off by up
 * to SOFT, a point on the axis (a cone's) capped by a ball, an outline made thick bevelled. A
 * doctor wears a handful of parts, so it costs little; the arena's thousands of pieces stay sharp.
 */
export type ModelUse = 'drawn' | 'worn' | 'collider'
/** How far a worn shape's edges and corners are rounded off at most, metres. */
export const SOFT = 0.015
/** Worn parts of more shapes than this are drawn with a quarter more sides, not half again. */
const WORN_FINE = 120

/** One part's shapes (null: the model's own frame): the lit ones merged, and the glowing ones. */
export interface PartGeometry {
  solid: BufferGeometry | null
  glow: BufferGeometry | null
}

export interface Model {
  readonly parts: Map<string | null, PartGeometry>
}

const matrix = new Matrix4()
const quat = new Quaternion()
const euler = new Euler()
const at = new Vector3()
const stretch = new Vector3()

/**
 * A lathe's [r, y] points in the order that faces it outward. three.js turns a profile's faces
 * outward when it runs up the outside (counter-clockwise in r and y, closed along the axis), so
 * one written top to bottom would be drawn inside out: a dark shell things show through. A flat
 * profile (a disc, a brim) has no inside: it is turned to face up.
 */
function outwardProfile(points: number[][]): number[][] {
  const closed = [...points, [0, points.at(-1)![1]!], [0, points[0]![1]!]]
  let area = 0
  for (let i = 0; i < closed.length; i++) {
    const [r0, y0] = closed[i]!
    const [r1, y1] = closed[(i + 1) % closed.length]!
    area += r0! * y1! - r1! * y0!
  }
  const flat = Math.abs(area) < 1e-9
  return (flat ? points.at(-1)![0]! > points[0]![0]! : area < 0) ? [...points].reverse() : points
}

/**
 * A line's corners rounded off, its ends kept (a closed outline's every corner): where it turns by
 * more than about 20 degrees, the corner becomes a curve from `round` before it to `round` after
 * it, `round` at most SOFT and a quarter of either side.
 */
export function softCorners(points: number[][], closed: boolean): number[][] {
  const n = points.length
  if (n < 3) return points
  const out: number[][] = []
  for (let i = 0; i < n; i++) {
    const c = points[i]!
    if (!closed && (i === 0 || i === n - 1)) {
      out.push(c)
      continue
    }
    const p = points[(i + n - 1) % n]!
    const q = points[(i + 1) % n]!
    const a = [p[0]! - c[0]!, p[1]! - c[1]!]
    const b = [q[0]! - c[0]!, q[1]! - c[1]!]
    const la = Math.hypot(a[0]!, a[1]!)
    const lb = Math.hypot(b[0]!, b[1]!)
    if (la < 1e-9 || lb < 1e-9 || (a[0]! * b[0]! + a[1]! * b[1]!) / (la * lb) < -0.94) {
      out.push(c)
      continue
    }
    const r = Math.min(SOFT, la / 4, lb / 4)
    const from = [c[0]! + (a[0]! / la) * r, c[1]! + (a[1]! / la) * r]
    const to = [c[0]! + (b[0]! / lb) * r, c[1]! + (b[1]! / lb) * r]
    for (let k = 0; k <= 2; k++) {
      const t = k / 2
      out.push([0, 1].map((j) => (1 - t) * (1 - t) * from[j]! + 2 * (1 - t) * t * c[j]! + t * t * to[j]!))
    }
  }
  return out
}

/**
 * A lathe profile's ends that meet the axis at a slant (a cone's point) capped by a ball tangent
 * to the slant, of radius at most SOFT and a fifth of the radius it slants out to: the point a
 * little shorter and round.
 */
export function roundTips(profile: number[][]): number[][] {
  const tip = (apex: number[], next: number[]): number[][] => {
    const rn = next[0]!
    const dy = next[1]! - apex[1]!
    const length = Math.hypot(rn, dy)
    // On the axis, at a slant: not a flat end (a disc's middle) nor along the axis.
    if (apex[0]! > 1e-6 || rn < 1e-6 || Math.abs(dy) < 0.3 * length) return [apex]
    const [sin, cos] = [rn / length, Math.abs(dy) / length]
    const rho = Math.min(SOFT, 0.2 * rn, 0.3 * length)
    const centre = apex[1]! + (Math.sign(dy) * rho) / sin
    // Where the ball meets the slant, down it from the point.
    const along = (rho * cos) / sin
    const meet = [(rn / length) * along, apex[1]! + (dy / length) * along]
    // From the pole on the axis round to there.
    const from = (-Math.sign(dy) * Math.PI) / 2
    const to = Math.atan2(meet[1]! - centre, meet[0]!)
    return Array.from({ length: 4 }, (_, k) => {
      const a = from + ((to - from) * k) / 3
      return [k === 0 ? 0 : rho * Math.cos(a), centre + rho * Math.sin(a)]
    })
  }
  const n = profile.length
  if (n < 2) return profile
  const start = tip(profile[0]!, profile[1]!)
  const end = tip(profile[n - 1]!, profile[n - 2]!).reverse()
  return [...start, ...profile.slice(1, n - 1), ...end]
}

/** A lathe through [r, y] points that already run the way that faces it outward; drawn, an open one with its inside. */
function latheOf(points: number[][], use: ModelUse, sides: number): BufferGeometry {
  const outside = flatten(
    new LatheGeometry(
      points.map((p) => new Vector2(p[0], p[1])),
      sides,
    ),
  )
  // Closed: both ends on the axis, or the profile back where it began (a ring turned round the axis).
  const [r0, y0] = points[0]!
  const [r1, y1] = points.at(-1)!
  const open = (r0! > 1e-6 || r1! > 1e-6) && Math.hypot(r1! - r0!, y1! - y0!) > 1e-6
  return use !== 'collider' && open ? mergeAll([outside, insideOf(outside)]) : outside
}

/** The same triangles facing the other way (corners swapped, normals turned round): an open shell's inside. */
function insideOf(g: BufferGeometry): BufferGeometry {
  const inside = g.clone()
  flipWinding(inside)
  const n = inside.getAttribute('normal')
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i))
  return inside
}

/** The shape's own geometry, centred as the kit says, before it is moved into place; `fine` times the sides round (worn: 1.25 or 1.5). */
function shapeGeometry(s: Shape, use: ModelUse, fine: number): BufferGeometry {
  const d = s.dims
  const soft = use === 'worn'
  const sides = (n: number) => Math.round(n * fine)
  switch (s.kind) {
    case 'box':
      return soft ? new RoundedBoxGeometry(d[0], d[1], d[2], 2, Math.min(SOFT, 0.3 * Math.min(d[0]!, d[1]!, d[2]!))) : new BoxGeometry(d[0], d[1], d[2])
    case 'sphere':
      return new SphereGeometry(d[0], sides(12), sides(8))
    case 'cylinder': {
      if (!soft) return new CylinderGeometry(d[0], d[1], d[2], 12)
      // Its profile up the side, its rims and any point rounded off.
      const [top, bottom, h] = [d[0]!, d[1]!, d[2]!]
      const profile = [[0, -h / 2], ...(bottom > 1e-6 ? [[bottom, -h / 2]] : []), ...(top > 1e-6 ? [[top, h / 2]] : []), [0, h / 2]]
      return latheOf(roundTips(softCorners(profile, false)), use, sides(12))
    }
    case 'torus':
      return new TorusGeometry(d[0], d[1], sides(8), sides(16))
    case 'capsule':
      return new CapsuleGeometry(d[0], d[1], soft ? 5 : 3, sides(12))
    case 'lathe':
      return latheOf(outwardProfile(soft ? roundTips(softCorners(s.points!, false)) : s.points!), use, sides(12))
    case 'extrude': {
      if (!soft) return new ExtrudeGeometry(new Outline(s.points!.map((p) => new Vector2(p[0], p[1]))), { depth: d[0], bevelEnabled: false }).translate(0, 0, -d[0] / 2)
      // Bevelled within its own outline and thickness.
      const bevel = Math.min(SOFT / 2, d[0]! * 0.3)
      const depth = d[0]! - 2 * bevel
      const outline = new Outline(softCorners(s.points!, true).map((p) => new Vector2(p[0], p[1])))
      return new ExtrudeGeometry(outline, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 2, curveSegments: 4 }).translate(0, 0, -depth / 2)
    }
    case 'tube': {
      // A tube is open at its ends: a ball on each end rounds it off, so a curl of hair or a handlebar looks solid.
      // A tube through one point over and over has no length to run along: it is just the ball.
      const points = s.points!.map((p) => new Vector3(p[0], p[1], p[2]))
      const curve = new CatmullRomCurve3(points)
      const ends = [points[0], points[points.length - 1]].map((p) => flatten(new SphereGeometry(d[0], sides(6), sides(4)).translate(p!.x, p!.y, p!.z)))
      return curve.getLength() < 1e-6 ? mergeAll(ends) : mergeAll([flatten(new TubeGeometry(curve, Math.min(64, (points.length - 1) * 6) * fine, d[0], sides(6), false)), ...ends])
    }
  }
}

/** Without its texture coordinates and its index, so geometries of every kind merge. */
function flatten(g: BufferGeometry): BufferGeometry {
  g.deleteAttribute('uv')
  if (g.index === null) return g
  const flat = g.toNonIndexed()
  g.dispose()
  return flat
}

function mergeAll(list: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(list)
  if (merged === null) throw new Error('the shapes of a model would not merge')
  for (const g of list) g.dispose()
  return merged
}

/** A mirrored shape (a negative scale) turns its faces inside out: swapping two corners of every triangle turns them back. */
function flipWinding(g: BufferGeometry) {
  for (const a of Object.values(g.attributes)) {
    for (let i = 0; i < a.count; i += 3) {
      for (let k = 0; k < a.itemSize; k++) {
        const v = a.getComponent(i + 1, k)
        a.setComponent(i + 1, k, a.getComponent(i + 2, k))
        a.setComponent(i + 2, k, v)
      }
    }
  }
}

/** One shape in its part's frame, every vertex its colour. */
function placed(s: Shape, use: ModelUse, fine: number): BufferGeometry {
  const g = flatten(shapeGeometry(s, use, fine))
  const color = new Color(s.color)
  matrix.compose(at.set(s.at[0], s.at[1], s.at[2]), quat.setFromEuler(euler.set(s.rot[0], s.rot[1], s.rot[2], 'XYZ')), stretch.set(s.scale[0], s.scale[1], s.scale[2]))
  g.applyMatrix4(matrix)
  const n = g.getAttribute('position').count
  const colors = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) color.toArray(colors, i * 3)
  g.setAttribute('color', new Float32BufferAttribute(colors, 3))
  if (s.scale[0] * s.scale[1] * s.scale[2] < 0) flipWinding(g)
  return g
}

export function buildModel(recipe: Recipe, use: ModelUse): Model {
  const fine = use !== 'worn' ? 1 : recipe.shapes.length > WORN_FINE ? 1.25 : 1.5
  const lists = new Map<string | null, { solid: BufferGeometry[]; glow: BufferGeometry[] }>()
  for (const s of recipe.shapes) {
    let list = lists.get(s.part)
    if (list === undefined) {
      list = { solid: [], glow: [] }
      lists.set(s.part, list)
    }
    ;(s.glow ? list.glow : list.solid).push(placed(s, use, fine))
  }
  const parts = new Map<string | null, PartGeometry>()
  for (const [part, list] of lists) parts.set(part, { solid: list.solid.length ? mergeAll(list.solid) : null, glow: list.glow.length ? mergeAll(list.glow) : null })
  return { parts }
}

export function disposeModel(model: Model) {
  for (const p of model.parts.values()) {
    p.solid?.dispose()
    p.glow?.dispose()
  }
}
