/**
 * A recipe as three.js geometry: merged per part, coloured per vertex, standing where the kit
 * measured it, and facing outward whatever the designer wrote.
 */
import { Box3, Color, Triangle, Vector3, type BufferGeometry } from 'three'
import { describe, expect, it } from 'vitest'

import { apply, buildRecipe, partTransform, type Kit } from './kit'
import { buildModel } from './mesh'

/** A thing made of every kind of shape, with a part inside a part and a glowing lamp. */
const everything = (m: Kit) => {
  m.box(1, 0.2, 0.6, { at: [0, 0.1, 0], color: '#e8503f' })
  m.sphere(0.2, { at: [0.6, 0.4, 0], scale: [1, 1.5, 1], color: 'blue' })
  m.cylinder(0.1, 0.2, 0.5, { at: [-0.6, 0.25, 0], color: '#5ec25a' })
  m.capsule(0.08, 0.3, { at: [0, 0.6, 0.4], rot: [0, 0, Math.PI / 2], color: '#f5d33b' })
  m.lathe([[0, 0], [0.2, 0.1], [0.15, 0.3], [0, 0.35]], { at: [0, 0.2, -0.4], color: '#9b5fd3' })
  m.extrude([[0, 0], [0.3, 0], [0.15, 0.3]], 0.05, { at: [0.3, 0.2, 0.3], color: '#fbf8f2' })
  m.tube([[0, 0, 0], [0.2, 0.3, 0], [0.4, 0.2, 0.1]], 0.03, { at: [-0.3, 0.3, 0.3], color: '#2b2b30' })
  m.part('arm', { at: [0, 0.3, 0], rot: [0, 0.4, 0] }, () => {
    m.box(0.8, 0.05, 0.05, { at: [0.4, 0, 0], color: '#8a5a34' })
    m.part('wheel', { at: [0.8, 0, 0] }, () => {
      m.torus(0.15, 0.04, { rot: [0, Math.PI / 2, 0], color: '#2b2b30' })
      m.sphere(0.06, { color: '#fff3a0', glow: true })
    })
  })
}

const triangles = (g: BufferGeometry) => g.getAttribute('position').count / 3

/** Of the triangles with an area, how many face the way `away` says by their corners' order, and how many agree with their own normals. */
function facing(g: BufferGeometry, away: (centre: Vector3) => Vector3) {
  const pos = g.getAttribute('position')
  const nrm = g.getAttribute('normal')
  const t = new Triangle()
  const n = new Vector3()
  const centre = new Vector3()
  let faces = 0
  let out = 0
  let agree = 0
  for (let i = 0; i < pos.count; i += 3) {
    t.setFromAttributeAndIndices(pos, i, i + 1, i + 2)
    if (t.getArea() < 1e-9) continue
    faces++
    t.getNormal(n)
    t.getMidpoint(centre)
    if (n.dot(away(centre)) > 0) out++
    if (n.dot(new Vector3(nrm.getX(i), nrm.getY(i), nrm.getZ(i))) > 0) agree++
  }
  return { faces, out, agree }
}

describe('a recipe as three.js', () => {
  it('merges each part into one solid geometry and one glowing one, every vertex coloured', () => {
    const { recipe } = buildRecipe(everything)
    const model = buildModel(recipe)
    expect([...model.parts.keys()].sort()).toEqual([null, 'arm', 'wheel'].sort())
    const own = model.parts.get(null)!
    expect(own.glow).toBeNull()
    expect(model.parts.get('wheel')!.glow).not.toBeNull()
    for (const p of model.parts.values()) {
      for (const g of [p.solid, p.glow]) {
        if (g === null) continue
        expect(g.index).toBeNull()
        expect(g.getAttribute('color').count).toBe(g.getAttribute('position').count)
        expect(Number.isInteger(triangles(g))).toBe(true)
      }
    }
    // The red box's corners are red.
    const red = new Color('#e8503f')
    const colors = own.solid!.getAttribute('color')
    expect([colors.getX(0), colors.getY(0), colors.getZ(0)]).toEqual([red.r, red.g, red.b].map((v) => Math.fround(v)))
  })

  it('stands where the kit measured it: the model at rest fills the recipe bounds', () => {
    const { recipe } = buildRecipe(everything)
    const box = new Box3()
    for (const [part, g] of buildModel(recipe).parts) {
      const { p, r } = partTransform(recipe.parts, part)
      for (const geo of [g.solid, g.glow]) {
        if (geo === null) continue
        const pos = geo.getAttribute('position')
        for (let i = 0; i < pos.count; i++) {
          const v = apply(r, [pos.getX(i), pos.getY(i), pos.getZ(i)])
          box.expandByPoint(new Vector3(v[0] + p[0], v[1] + p[1], v[2] + p[2]))
        }
      }
    }
    const { min, max } = recipe.bounds
    for (let k = 0; k < 3; k++) {
      // The kit measures each shape's own box turned, so it is never smaller than the shapes.
      expect(box.min.getComponent(k)).toBeGreaterThanOrEqual(min[k]! - 1e-6)
      expect(box.max.getComponent(k)).toBeLessThanOrEqual(max[k]! + 1e-6)
      expect(box.max.getComponent(k) - box.min.getComponent(k)).toBeGreaterThan((max[k]! - min[k]!) * 0.85)
    }
  })

  it('draws a tube that goes nowhere as a ball, not as nothing', () => {
    const { recipe } = buildRecipe((m) => m.tube([[0, 0.2, 0], [0, 0.2, 0]], 0.05))
    const g = buildModel(recipe).parts.get(null)!.solid!
    g.computeBoundingSphere()
    expect(g.boundingSphere!.radius).toBeCloseTo(0.05, 5)
  })

  it('keeps a mirrored shape facing out', () => {
    const { recipe } = buildRecipe((m) => m.extrude([[0, 0], [1, 0], [0, 1]], 0.2, { scale: [-1, 1, 1] }))
    const g = buildModel(recipe).parts.get(null)!.solid!
    const { faces, agree } = facing(g, () => new Vector3())
    expect(agree).toBe(faces)
    expect(faces).toBe(triangles(g))
  })

  it('faces a lathe outward whichever way its points run, and a flat one up', () => {
    // A tree crown, its points bottom to top and top to bottom: both a dome seen from outside.
    const up = [
      [0, 0.6],
      [1.2, 0.8],
      [1, 1.8],
      [0.5, 2.8],
      [0, 3.4],
    ]
    for (const points of [up, [...up].reverse()]) {
      const { recipe } = buildRecipe((m) => m.lathe(points, { color: '#3cb043' }))
      const g = buildModel(recipe).parts.get(null)!.solid!
      const { out, agree, faces } = facing(g, (c) => c.clone().sub(new Vector3(0, 1.8, 0)))
      expect(out).toBe(faces)
      expect(agree).toBe(faces)
    }
    // A flat disc, written from the middle out or from the rim in: seen from above.
    for (const points of [
      [
        [0, 0.5],
        [1, 0.5],
      ],
      [
        [1, 0.5],
        [0, 0.5],
      ],
    ]) {
      const g = buildModel(buildRecipe((m) => m.lathe(points)).recipe).parts.get(null)!.solid!
      const { out, faces } = facing(g, () => new Vector3(0, 1, 0))
      expect(out).toBe(faces)
    }
  })
})
