/**
 * How open an arena is to the sky, for its light: what is drawn over the floor is its roof, a slab
 * or a dome; what stands on the floor, a wall, or the floor itself however it lies is not.
 */
import { Box3, BoxGeometry, Vector3, type BufferGeometry } from 'three'
import { describe, expect, it } from 'vitest'

import { buildRecipe } from '../model/kit'
import { buildModel } from '../model/mesh'
import { openSky } from './place'

/** A model's lathe as the page draws it. */
const drawnLathe = (points: number[][]): BufferGeometry => buildModel(buildRecipe((m) => m.lathe(points)).recipe, 'drawn').parts.get(null)!.solid!

const BOUNDS = new Box3(new Vector3(-20, -1, -20), new Vector3(20, 9, 20))
const FLOOR = new BoxGeometry(40, 1, 40).translate(0, -0.5, 0).toNonIndexed()
const slab = (w: number, d: number, x: number, z: number): BufferGeometry => new BoxGeometry(w, 0.4, d).translate(x, 8, z).toNonIndexed()

describe('how open an arena is to the sky', () => {
  it('is open over a courtyard, closed under a roof', () => {
    expect(openSky([FLOOR], BOUNDS)).toBe(1)
    expect(openSky([FLOOR, slab(40, 40, 0, 0)], BOUNDS)).toBe(0)
  })

  it('is as open as the roof leaves it', () => {
    // A roof over the half where x < 0: two of the five rows of points under it, one on its edge.
    const half = openSky([FLOOR, slab(20, 40, -10, 0)], BOUNDS)
    expect(half).toBeGreaterThan(0.3)
    expect(half).toBeLessThan(0.7)
  })

  it('takes a dome for a roof, whatever made it, and not walls or what stands on the floor', () => {
    const dome = drawnLathe([
      [30, 0],
      [26, 3],
      [14, 7],
      [0, 9],
    ])
    expect(openSky([FLOOR, dome], BOUNDS)).toBe(0)
    const wall = new BoxGeometry(0.4, 8, 40).translate(-19.8, 4, 0).toNonIndexed()
    const statue = new BoxGeometry(1, 1.2, 1).translate(0, 0.6, 0).toNonIndexed()
    expect(openSky([FLOOR, wall, statue], BOUNDS)).toBe(1)
  })

  it('takes a bowl or a terrace for its own floor, not for a roof over the ground under it', () => {
    const bowl = drawnLathe([
      [0, 0],
      [20, 2],
      [40, 8],
    ])
    expect(openSky([bowl], BOUNDS)).toBe(1)
    const thick = new BoxGeometry(40, 6, 40).translate(0, -3, 0).toNonIndexed()
    expect(openSky([thick], BOUNDS)).toBe(1)
  })
})
