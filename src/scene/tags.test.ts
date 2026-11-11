/**
 * Name tags without clutter: in full for every doctor near and the one at the crosshair however
 * far; a pip for the rest.
 */
import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { TAG_NEAR, fullTags } from './doctor'

const EYE = new Vector3(0, 1.6, 0)
const AHEAD = new Vector3(0, 0, 1)

describe('name tags', () => {
  it('are in full near, pips far', () => {
    const marks = new Map([
      ['near', new Vector3(3, 1.2, 5)],
      ['edge', new Vector3(0, 1.2, -TAG_NEAR + 0.5)],
      ['far', new Vector3(-20, 1.2, 25)],
    ])
    expect([...fullTags(EYE, AHEAD, marks)].sort()).toEqual(['edge', 'near'])
  })

  it('are in full for the one doctor nearest the crosshair, however far', () => {
    const marks = new Map([
      ['aimed', new Vector3(1, 1.2, 40)],
      ['beside', new Vector3(4, 1.2, 40)],
      ['behind', new Vector3(-30, 1.2, -30)],
    ])
    expect([...fullTags(EYE, AHEAD, marks)]).toEqual(['aimed'])
  })

  it('are pips when nobody far is at the crosshair', () => {
    const marks = new Map([['off', new Vector3(20, 1.2, 20)]])
    expect(fullTags(EYE, AHEAD, marks).size).toBe(0)
  })
})
