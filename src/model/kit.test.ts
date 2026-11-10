/**
 * The kit as the designer is told it works: parts made again under the same name, a part
 * without opts, parts past the cap, and every colour a designer may name.
 */
import { Color } from 'three'
import { describe, expect, it } from 'vitest'

import { apply, boundsOf, buildRecipe, hangOf, parseColor, partTransform, type Kit, type Recipe } from './kit'

describe('the kit', () => {
  it('gives every copy of a part made under one name its own place, and the one name to pose them by', () => {
    // A Christmas tree: baubles in two named sets, so each set can twinkle.
    const { recipe, notes } = buildRecipe((m) => {
      m.cone(1, 2, { at: [0, 1, 0], color: 'green' })
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2
        m.part('light' + (i % 2), { at: [Math.sin(a), 1, Math.cos(a)] }, () => m.sphere(0.1, { color: i % 2 ? 'red' : 'gold' }))
      }
    })
    expect(notes).toEqual([])
    expect(recipe.parts.map((p) => [p.name, p.pose ?? null])).toEqual([
      ['light0', null],
      ['light1', null],
      ['light0~2', 'light0'],
      ['light1~2', 'light1'],
      ['light0~3', 'light0'],
      ['light1~3', 'light1'],
    ])
    // Six baubles in six places, not two.
    const places = new Set(recipe.shapes.filter((s) => s.kind === 'sphere').map((s) => recipe.parts.find((p) => p.name === s.part)!.at.map((v) => v.toFixed(2)).join()))
    expect(places.size).toBe(6)
  })

  it('keeps the shapes of a part made without opts', () => {
    const { recipe, notes } = buildRecipe((m) => {
      m.box(0.6, 0.4, 0.4, { at: [0, 0.2, 0], color: 'brown' })
      ;(m.part as (name: string, fn: () => void) => void)('lid', () => m.box(0.62, 0.05, 0.42, { at: [0, 0.42, 0], color: 'tan' }))
    })
    expect(notes).toEqual([])
    expect(recipe.parts).toEqual([{ name: 'lid', at: [0, 0, 0], rot: [0, 0, 0], parent: null }])
    expect(recipe.shapes.map((s) => s.part)).toEqual([null, 'lid'])
  })

  it('stops making parts past a hundred and twenty, keeping their shapes', () => {
    const { recipe, notes } = buildRecipe((m) => {
      for (let i = 0; i < 200; i++) m.part('bit', { at: [i * 0.01, 0, 0] }, () => m.box(0.01, 0.01, 0.01))
    })
    expect(recipe.parts.length).toBe(120)
    expect(recipe.shapes.length).toBe(200)
    expect(notes).toEqual(['too many parts'])
  })

  it('keeps what is made in a part past the hundred and twentieth where it was put, turned as it was, only still', () => {
    // A turned branch with a turned bell on it, and an anchor on the bell: made with no other parts, and again after 120.
    const branch = (m: Kit) => {
      m.part('branch', { at: [0.5, 1, 0.2], rot: [0, 0.4, -0.6] }, () => {
        m.box(0.8, 0.05, 0.1, { at: [0.4, 0, 0], rot: [0.3, 0, 0], color: 'brown' })
        m.part('bell', { at: [0.8, 0, 0], rot: [0, 1, 0.2] }, () => {
          m.cylinder(0.02, 0.1, 0.15, { at: [0, -0.1, 0.05], rot: [0.2, 0, 0.4], scale: [1, 1, 0.5], color: 'gold' })
          m.anchor('ring', [0, 0.05, 0.02])
        })
      })
    }
    const alone = buildRecipe((m) => branch(m))
    const late = buildRecipe((m) => {
      for (let i = 0; i < 120; i++) m.part('bit' + i, { at: [5, 5, 5] }, () => m.box(0.01, 0.01, 0.01))
      branch(m)
    })
    expect(late.notes).toEqual(['too many parts'])
    expect(late.recipe.parts.length).toBe(120)
    const mine = late.recipe.shapes.slice(120)
    expect(mine.map((s) => s.part)).toEqual([null, null])
    // Each shape covers the same box in the model as when its parts were made.
    alone.recipe.shapes.forEach((s, i) => {
      const want = boundsOf([s], alone.recipe.parts)
      const got = boundsOf([mine[i]!], late.recipe.parts)
      for (const k of [0, 1, 2]) {
        expect(got.min[k], `shape ${i} min ${k}`).toBeCloseTo(want.min[k]!, 9)
        expect(got.max[k], `shape ${i} max ${k}`).toBeCloseTo(want.max[k]!, 9)
      }
    })
    const at = (r: Recipe, name: string) => {
      const a = r.anchors[name]!
      const f = partTransform(r.parts, a.part)
      const o = apply(f.r, a.at)
      return [f.p[0] + o[0], f.p[1] + o[1], f.p[2] + o[2]]
    }
    const ring = at(alone.recipe, 'ring')
    at(late.recipe, 'ring').forEach((v, k) => expect(v).toBeCloseTo(ring[k]!, 9))
  })

  it('finds where the weight hanging from a part sits, with the parts inside it, in its own frame', () => {
    // A turned arm with a heavy weight further down it, inside a part of its own.
    const { recipe } = buildRecipe((m) => {
      m.box(1, 1, 1, { at: [3, 0, 0] })
      m.part('arm', { at: [0, 1, 0], rot: [0, 0, Math.PI / 2] }, () => {
        m.box(0.1, 1, 0.1, { at: [0, -0.5, 0] })
        m.part('weight', { at: [0, -1, 0] }, () => m.box(0.2, 0.2, 0.2, { at: [0, -0.1, 0] }))
      })
    })
    // Volumes 0.01 at y -0.5 and 0.008 at y -1.1: in the arm's frame, whatever turns it.
    const arm = hangOf(recipe, 'arm')!
    ;[0, (-0.5 * 0.01 - 1.1 * 0.008) / 0.018, 0].forEach((v, k) => expect(arm[k]).toBeCloseTo(v, 9))
    hangOf(recipe, 'weight')!.forEach((v, k) => expect(v).toBeCloseTo([0, -0.1, 0][k]!, 9))
    const empty = buildRecipe((m) => {
      m.sphere(0.1)
      m.part('empty', () => m.part('in', () => {}))
    })
    expect(hangOf(empty.recipe, 'empty')).toBeNull()
  })

  it('refuses a model with no shapes, and measures the ones it has', () => {
    expect(() => buildRecipe(() => {})).toThrow('the model has no shapes')
    const { recipe } = buildRecipe((m) => m.box(2, 1, 4, { at: [1, 0.5, 0] }))
    expect(recipe.bounds).toEqual({ min: [0, 0, -2], max: [2, 1, 2] })
  })
})

describe('colours', () => {
  it('knows every CSS colour name', () => {
    const names = Object.keys(Color.NAMES)
    expect(names.length).toBe(148)
    for (const name of names) expect(parseColor(name), name).toMatch(/^#[0-9a-f]{6}$/)
    // A few of the ones designers used, as CSS has them.
    expect(parseColor('saddlebrown')).toBe('#8b4513')
    expect(parseColor('DodgerBlue')).toBe('#1e90ff')
    // The game's own softer plain colours stay.
    expect(parseColor('red')).toBe('#e8503f')
  })

  it('reads hex with see-through, rgb() and hsl() however they are written', () => {
    expect(parseColor('#ff8800cc')).toBe('#ff8800')
    expect(parseColor('#f80c')).toBe('#ff8800')
    expect(parseColor('rgb(255, 136, 0)')).toBe('#ff8800')
    expect(parseColor('rgb(255 136 0 / 50%)')).toBe('#ff8800')
    expect(parseColor('rgba(100%, 0%, 0%, 0.5)')).toBe('#ff0000')
    expect(parseColor('hsl(0, 100%, 50%)')).toBe('#ff0000')
    expect(parseColor('hsl(120deg 100% 25%)')).toBe('#008000')
    expect(parseColor('hsla(240, 100%, 50%, 0.3)')).toBe('#0000ff')
    expect(parseColor('sparkly')).toBeNull()
    expect(parseColor('#12345')).toBeNull()
    expect(parseColor(42)).toBeNull()
  })

  it("takes no colour from an object's own fields: a shape keeps a string", () => {
    for (const name of ['constructor', 'Constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) expect(parseColor(name), name).toBeNull()
    const { recipe, notes } = buildRecipe((m) => m.box(1, 1, 1, { color: 'Constructor' }))
    expect(recipe.shapes[0]!.color).toBe('#9aa3ad')
    expect(notes).toEqual(['unknown colour "Constructor"'])
  })
})
