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

/** A lathe through [r, y] points that already run the way that faces it outward. */
function latheOf(points: number[][]): BufferGeometry {
  return new LatheGeometry(
    points.map((p) => new Vector2(p[0], p[1])),
    12,
  )
}

/** The shape's own geometry, centred as the kit says, before it is moved into place. */
function shapeGeometry(s: Shape): BufferGeometry {
  const d = s.dims
  switch (s.kind) {
    case 'box':
      return new BoxGeometry(d[0], d[1], d[2])
    case 'sphere':
      return new SphereGeometry(d[0], 12, 8)
    case 'cylinder':
      return new CylinderGeometry(d[0], d[1], d[2], 12)
    case 'torus':
      return new TorusGeometry(d[0], d[1], 8, 16)
    case 'capsule':
      return new CapsuleGeometry(d[0], d[1], 3, 12)
    case 'lathe':
      return latheOf(outwardProfile(s.points!))
    case 'extrude':
      return new ExtrudeGeometry(new Outline(s.points!.map((p) => new Vector2(p[0], p[1]))), { depth: d[0], bevelEnabled: false }).translate(0, 0, -d[0] / 2)
    case 'tube': {
      // A tube is open at its ends: a ball on each end rounds it off, so a curl of hair or a handlebar looks solid.
      // A tube through one point over and over has no length to run along: it is just the ball.
      const points = s.points!.map((p) => new Vector3(p[0], p[1], p[2]))
      const curve = new CatmullRomCurve3(points)
      const ends = [points[0], points[points.length - 1]].map((p) => flatten(new SphereGeometry(d[0], 6, 4).translate(p!.x, p!.y, p!.z)))
      return curve.getLength() < 1e-6 ? mergeAll(ends) : mergeAll([flatten(new TubeGeometry(curve, Math.min(64, (points.length - 1) * 6), d[0], 6, false)), ...ends])
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
  for (const name of ['position', 'normal', 'color']) {
    const a = g.getAttribute(name)
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
function placed(s: Shape): BufferGeometry {
  const g = flatten(shapeGeometry(s))
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

export function buildModel(recipe: Recipe): Model {
  const lists = new Map<string | null, { solid: BufferGeometry[]; glow: BufferGeometry[] }>()
  for (const s of recipe.shapes) {
    let list = lists.get(s.part)
    if (list === undefined) {
      list = { solid: [], glow: [] }
      lists.set(s.part, list)
    }
    ;(s.glow ? list.glow : list.solid).push(placed(s))
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
