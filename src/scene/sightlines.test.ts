/**
 * What hides one doctor from another: a wall between hides them, a balcony or a lintel over their
 * head does not, nor a piece that has broken.
 */
import { BoxGeometry, Vector3, type BufferGeometry } from 'three'
import { describe, expect, it } from 'vitest'

import { buildRecipe } from '../model/kit'
import { buildModel } from '../model/mesh'
import { Sightlines } from './sightlines'

const box = (w: number, h: number, d: number, x: number, y: number, z: number): BufferGeometry => new BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed()
const FLOOR = box(60, 1, 60, 0, -0.5, 0)
const EYE = new Vector3(0, 1.6, -20)
/** A doctor's head 30 m ahead, and the line to it a little across. */
const HEAD = new Vector3(4, 1.6, 10)

describe('what hides one doctor from another', () => {
  it('sees across an open floor, and not through a wall between', () => {
    expect(new Sightlines([FLOOR]).clear(EYE, HEAD)).toBe(true)
    const wall = box(30, 4, 0.3, 0, 2, 0)
    expect(new Sightlines([FLOOR, wall]).clear(EYE, HEAD)).toBe(false)
    // The same wall behind the doctor, or beside the line, hides nothing.
    expect(new Sightlines([FLOOR, box(30, 4, 0.3, 0, 2, 14)]).clear(EYE, HEAD)).toBe(true)
    expect(new Sightlines([FLOOR, box(0.3, 4, 30, -6, 2, 0)]).clear(EYE, HEAD)).toBe(true)
  })

  it('sees a doctor under a balcony or through a doorway, whatever is over their head', () => {
    // A gallery 3 m deep over the doctor, its front 2.6 m up, and a wall with a doorway 6 m before them.
    const gallery = box(30, 0.5, 3, 0, 2.85, 10)
    const lintel = box(2, 0.6, 0.3, 4, 2.5, 4)
    const sides = [box(13, 2.8, 0.3, -3.5, 1.4, 4), box(13, 2.8, 0.3, 11.5, 1.4, 4)]
    const sight = new Sightlines([FLOOR, gallery, lintel, ...sides])
    expect(sight.clear(EYE, HEAD)).toBe(true)
    // Beside the doorway the wall hides them.
    expect(sight.clear(EYE, new Vector3(-4, 1.6, 10))).toBe(false)
  })

  it('takes a dome for a wall, from outside and from within', () => {
    const dome = buildModel(buildRecipe((m) => m.lathe([[8, 0], [7, 3], [4, 6], [0, 7]])).recipe, 'drawn').parts.get(null)!.solid!
    const sight = new Sightlines([FLOOR, dome])
    expect(sight.clear(new Vector3(0, 1.6, -20), new Vector3(0, 1.6, 0))).toBe(false)
    expect(sight.clear(new Vector3(-3, 1.6, 0), new Vector3(3, 1.6, 0))).toBe(true)
  })

  it('sees through a piece that has broken: its corners drawn together', () => {
    const wall = box(30, 4, 0.3, 0, 2, 0)
    const sight = new Sightlines([FLOOR, wall])
    expect(sight.clear(EYE, HEAD)).toBe(false)
    const p = wall.getAttribute('position')
    for (let i = 0; i < p.count; i++) p.setXYZ(i, 0, 2, 0)
    expect(sight.clear(EYE, HEAD)).toBe(true)
  })

  it('tests a line that starts or ends beyond what is drawn', () => {
    const sight = new Sightlines([FLOOR, box(30, 4, 0.3, 0, 2, 0)])
    expect(sight.clear(new Vector3(0, 1.6, -80), new Vector3(0, 1.6, 80))).toBe(false)
    expect(sight.clear(new Vector3(0, 40, -80), new Vector3(0, 40, 80))).toBe(true)
    expect(new Sightlines([]).clear(EYE, HEAD)).toBe(true)
  })

  it('keeps its grid in bounds over a huge arena, and still sees walls in it', () => {
    // Solids may be 240 m long and stand anywhere: a mountain range far off (2-metre cubes over
    // all of it would be more than an array can hold).
    const far = box(240, 240, 240, 40_000, 0, -40_000)
    const sight = new Sightlines([FLOOR, far, box(30, 4, 0.3, 0, 2, 0)])
    expect(sight.clear(EYE, HEAD)).toBe(false)
    expect(sight.clear(EYE, new Vector3(4, 1.6, -10))).toBe(true)
    expect(sight.clear(new Vector3(39_800, 10, -40_000), new Vector3(40_200, 10, -40_000))).toBe(false)
  })
})
