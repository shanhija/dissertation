/**
 * Open shells drawn from both sides: a dome over a room, a bowl, a hat's brim show from within
 * too; a collider gets the shell once (its triangles count against the arena's budget).
 */
import { Triangle, Vector3, type BufferGeometry } from 'three'
import { describe, expect, it } from 'vitest'

import { recipeTriangles } from '../sim/shapes'
import { buildRecipe } from './kit'
import { buildModel } from './mesh'

/** Of the triangles with an area, how many face toward a point (their front seen from there). */
function facingToward(g: BufferGeometry, eye: Vector3): { faces: number; toward: number } {
  const pos = g.getAttribute('position')
  const t = new Triangle()
  const n = new Vector3()
  const mid = new Vector3()
  let faces = 0
  let toward = 0
  for (let i = 0; i < pos.count; i += 3) {
    t.setFromAttributeAndIndices(pos, i, i + 1, i + 2)
    if (t.getArea() < 1e-9) continue
    faces++
    t.getNormal(n)
    t.getMidpoint(mid)
    if (n.dot(eye.clone().sub(mid)) > 0) toward++
  }
  return { faces, toward }
}

const DOME = [
  [4, 0],
  [3.6, 2],
  [2.4, 3.4],
  [0, 4],
]
const BALL = [
  [0, 0],
  [1, 0.5],
  [1, 1.5],
  [0, 2],
]

describe('open shells', () => {
  it('draws an open dome from inside as well as from outside, and gives a collider the shell once', () => {
    const { recipe } = buildRecipe((m) => m.lathe(DOME))
    const drawn = buildModel(recipe, 'drawn').parts.get(null)!.solid!
    const collider = buildModel(recipe, 'collider').parts.get(null)!.solid!
    const inside = new Vector3(0, 1.5, 0)
    const outside = new Vector3(0, 9, 0)
    expect(facingToward(collider, inside).toward).toBe(0)
    const fromWithin = facingToward(drawn, inside)
    expect(fromWithin.faces).toBe(2 * facingToward(collider, inside).faces)
    expect(fromWithin.toward).toBe(fromWithin.faces / 2)
    // From above, the top shows its outside as before.
    expect(facingToward(drawn, outside).toward).toBeGreaterThan(0)
    // The insides' normals point inward, so they are lit (and dusted) as the inside of a bowl is.
    const nrm = drawn.getAttribute('normal')
    const half = nrm.count / 2
    // Each inside triangle is its outside one with two corners swapped: corners 0, 2, 1.
    for (const t of [0, 5]) [0, 2, 1].forEach((from, c) => expect(nrm.getY(half + t * 3 + c)).toBeCloseTo(-nrm.getY(t * 3 + from), 5))
    // The sim's collider for a shaped piece is the shell once.
    expect(recipeTriangles(recipe, 1).length / 9).toBe(collider.getAttribute('position').count / 3)
  })

  it('shows a flat brim from below as well as from above', () => {
    const { recipe } = buildRecipe((m) =>
      m.lathe([
        [0.1, 0],
        [0.3, 0],
      ]),
    )
    const drawn = buildModel(recipe, 'drawn').parts.get(null)!.solid!
    expect(facingToward(drawn, new Vector3(0.2, 1, 0)).toward).toBeGreaterThan(0)
    expect(facingToward(drawn, new Vector3(0.2, -1, 0)).toward).toBeGreaterThan(0)
  })

  it('leaves a shape closed at its axis as it was', () => {
    const { recipe } = buildRecipe((m) => m.lathe(BALL))
    const drawn = buildModel(recipe, 'drawn').parts.get(null)!.solid!
    const collider = buildModel(recipe, 'collider').parts.get(null)!.solid!
    expect(drawn.getAttribute('position').count).toBe(collider.getAttribute('position').count)
    expect(facingToward(drawn, new Vector3(0, 1, 0)).toward).toBe(0)
  })

  it('leaves a ring turned round the axis (its profile back where it began) as it was', () => {
    const RING = [
      [1, 0],
      [1.4, 0],
      [1.4, 0.3],
      [1, 0.3],
      [1, 0],
    ]
    const { recipe } = buildRecipe((m) => m.lathe(RING))
    const drawn = buildModel(recipe, 'drawn').parts.get(null)!.solid!
    const collider = buildModel(recipe, 'collider').parts.get(null)!.solid!
    expect(drawn.getAttribute('position').count).toBe(collider.getAttribute('position').count)
  })
})
