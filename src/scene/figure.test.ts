/**
 * The doctor's body as geometry (figure.ts): every skinned vertex goes wholly with its joints, and
 * the coat's shoulders lie over the sleeves' caps, so the arms do not stand up above them.
 */
import { Vector3, type BufferGeometry } from 'three'
import { describe, expect, it } from 'vitest'

import { BODY } from '../doctor'
import { COAT, SLEEVE, TROUSER_LEG, trunk } from './figure'

describe("the doctor's body", () => {
  it('weighs every vertex of a skinned part wholly, to joints it has', () => {
    for (const [g, joints] of [
      [COAT, 4],
      [SLEEVE, 2],
      [TROUSER_LEG, 2],
    ] as [BufferGeometry, number][]) {
      const index = g.getAttribute('skinIndex')
      const weight = g.getAttribute('skinWeight')
      for (let i = 0; i < weight.count; i++) {
        expect(weight.getX(i) + weight.getY(i) + weight.getZ(i) + weight.getW(i)).toBeCloseTo(1, 6)
        for (let k = 0; k < 4; k++) expect(index.getComponent(i, k)).toBeLessThan(joints)
      }
    }
  })

  it("lays the coat's shoulder over the top of each sleeve", () => {
    const pos = SLEEVE.getAttribute('position')
    const top = Math.max(...Array.from({ length: pos.count }, (_, i) => pos.getY(i)))
    for (const side of [-1, 1]) {
      // The sleeve's cap as it hangs from the shoulder, and the coat round the trunk at its height.
      const cap = new Vector3(side * BODY.shoulders.half, BODY.shoulders.y + top, 0)
      expect(Math.hypot(cap.x, cap.z)).toBeLessThan(trunk(Math.atan2(cap.x, cap.z), cap.y))
    }
  })
})
