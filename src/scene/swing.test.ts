/**
 * Clothes that move: worn parts swinging from their pivots (swing.ts) and the coat's skirt
 * draped by its springs (figure.ts), without a browser.
 */
import { BufferGeometry, Group, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { buildRecipe, type Kit } from '../model/kit'
import { BEND_FROM, SKIRT, SPRINGS, drape } from './figure'
import { Swing, type Fence } from './swing'

/** A model's part groups on a doctor's root, as ModelInstance makes them, and its swing. */
function worn(build: (m: Kit) => void, fence: Fence | null = null) {
  const { recipe } = buildRecipe(build)
  const root = new Group()
  const groups = new Map<string | null, Group>([[null, root]])
  const parts = recipe.parts.map((def) => {
    const group = new Group()
    group.position.set(...def.at)
    group.rotation.set(...def.rot)
    groups.get(def.parent)!.add(group)
    groups.set(def.name, group)
    return { def, group }
  })
  const swing = new Swing(recipe, parts, root, fence)
  const part = (name: string) => parts.find((p) => p.def.name === name)!.group
  /** Steps it as the page does: the doctor moved, the clothes swung, the frame drawn. */
  const run = (from: number, secs: number, move: (t: number) => void) => {
    for (let t = from; t < from + secs; t += 1 / 60) {
      move(t)
      swing.step(1 / 60)
      root.updateMatrixWorld(true)
    }
  }
  return { root, swing, part, run }
}

/** Which way a part points from its pivot, in the world. */
const pointing = (g: Group, local: Vector3) => g.localToWorld(local.clone()).sub(g.getWorldPosition(new Vector3())).normalize()

const cape = (m: Kit) => m.part('cape', { at: [0, 1.4, -0.15] }, () => m.box(0.5, 0.8, 0.02, { at: [0, -0.4, 0] }))

describe('worn parts', () => {
  it('stay as made while the doctor stands still', () => {
    const { swing, part, run } = worn(cape)
    expect(swing.moves).toBe(true)
    run(0, 2, () => {})
    expect(part('cape').quaternion.angleTo(part('cape').quaternion.clone().identity())).toBeLessThan(1e-6)
  })

  it('lag behind a start, swing on past a stop and come back to rest', () => {
    const { root, part, run } = worn(cape)
    const down = new Vector3(0, -1, 0)
    run(0, 0.5, () => {})
    // Off forward at 10 m/s²: the cape's hem trails behind (toward -z).
    run(0.5, 0.3, (t) => (root.position.z = 5 * (t - 0.5) ** 2))
    expect(pointing(part('cape'), down).z).toBeLessThan(-0.15)
    // Stopping dead: it swings on forward.
    const at = root.position.z
    let ahead = -1
    run(0.8, 0.5, () => {
      root.position.z = at
      ahead = Math.max(ahead, pointing(part('cape'), down).z)
    })
    expect(ahead).toBeGreaterThan(0.15)
    run(1.3, 4, () => {})
    expect(Math.abs(pointing(part('cape'), down).z)).toBeLessThan(0.02)
  })

  it('fall toward the ground with a doctor lying down', () => {
    const { root, part, run } = worn(cape)
    run(0, 0.5, () => {})
    // On its back: the cape, made hanging down its back, would stick out sideways if it were stiff.
    root.rotation.x = -Math.PI / 2
    root.position.y = 0.3
    run(0.5, 0.1, () => {})
    run(0.6, 4, () => {})
    expect(pointing(part('cape'), new Vector3(0, -1, 0)).y).toBeLessThan(-0.85)
  })

  it('made standing up stay up, wobbling back after a shove', () => {
    const { root, part, run } = worn((m) => m.part('rod', { at: [0, 1.75, 0] }, () => m.cylinder(0.02, 0.02, 0.3, { at: [0, 0.15, 0] })))
    const up = new Vector3(0, 1, 0)
    run(0, 0.5, () => {})
    let most = 0
    run(0.5, 0.2, (t) => {
      root.position.x = 6 * (t - 0.5) ** 2
      most = Math.max(most, Math.abs(pointing(part('rod'), up).x))
    })
    expect(most).toBeGreaterThan(0.1)
    const at = root.position.x
    run(0.7, 4, () => (root.position.x = at))
    expect(pointing(part('rod'), up).y).toBeGreaterThan(0.999)
  })

  it('do not swing into the body, made clear of it or hugging it', () => {
    // A cape on the back of a trunk round the origin, its weight 0.4 below a pivot 0.15 behind:
    // stopping dead would swing it forward through the doctor. The trunk's back is at 0.12, then
    // at 0.2, past the cape's weight, as when a cape is made sunk into the coat.
    for (const back of [0.12, 0.2]) {
      const { root, part, run } = worn(cape, { x: 0, z: 0, rx: 0.2, rz: back })
      const down = new Vector3(0, -1, 0)
      run(0, 0.5, () => {})
      run(0.5, 0.3, (t) => (root.position.z = 5 * (t - 0.5) ** 2))
      expect(pointing(part('cape'), down).z, `back ${back}`).toBeLessThan(-0.15)
      const at = root.position.z
      let ahead = -1
      run(0.8, 1, () => {
        root.position.z = at
        ahead = Math.max(ahead, pointing(part('cape'), down).z)
      })
      expect(ahead, `back ${back}`).toBeLessThan(0.08)
    }
  })

  it('in a chain bend down their length', () => {
    const { root, part, run } = worn((m) =>
      m.part('upper', { at: [0, 1.4, -0.15] }, () => {
        m.box(0.3, 0.3, 0.02, { at: [0, -0.15, 0] })
        m.part('lower', { at: [0, -0.3, 0] }, () => m.box(0.3, 0.3, 0.02, { at: [0, -0.15, 0] }))
      }),
    )
    run(0, 0.5, () => {})
    let bent = 0
    run(0.5, 0.6, (t) => {
      root.position.z = t < 0.8 ? 5 * (t - 0.5) ** 2 : root.position.z
      bent = Math.max(bent, part('lower').quaternion.angleTo(part('lower').quaternion.clone().identity()))
    })
    expect(bent).toBeGreaterThan(0.05)
  })

  it('leave a part whose weight is at its pivot alone', () => {
    const { swing } = worn((m) => m.part('wheel', { at: [0, 1, 0] }, () => m.torus(0.1, 0.02)))
    expect(swing.moves).toBe(false)
  })
})

describe('the coat', () => {
  const rest = SKIRT.geometry.getAttribute('position')
  const at = (g: BufferGeometry, i: number) => new Vector3().fromBufferAttribute(g.getAttribute('position'), i)
  const still = SPRINGS.map(() => ({ angle: 0, bend: 0 }))
  /** The cloth straight down the back, waist to hem, as made. */
  const back = Array.from({ length: rest.count }, (_, i) => i)
    .filter((i) => Math.abs(SKIRT.theta[i]! - Math.PI) < 0.03 && SKIRT.out[i]! > -0.001 && Math.abs(at(SKIRT.geometry, i).x) < 0.01)
    .sort((a, b) => SKIRT.below[a]! - SKIRT.below[b]!)
  const length = (g: BufferGeometry) => back.slice(1).reduce((sum, i, k) => sum + at(g, i).distanceTo(at(g, back[k]!)), 0)

  it('hangs as made while its springs are still', () => {
    const out = SKIRT.geometry.clone()
    drape(out, SKIRT, still)
    for (let i = 0; i < rest.count; i++) expect(at(out, i).distanceTo(at(SKIRT.geometry, i))).toBeLessThan(1e-6)
  })

  it('bends out below the pockets, keeping its length', () => {
    expect(back.length).toBeGreaterThan(10)
    const out = SKIRT.geometry.clone()
    drape(out, SKIRT, SPRINGS.map(() => ({ angle: 0, bend: 0.7 })))
    for (const i of back) if (SKIRT.below[i]! <= BEND_FROM) expect(at(out, i).distanceTo(at(SKIRT.geometry, i))).toBeLessThan(1e-6)
    const hem = back.at(-1)!
    expect(-at(out, hem).z + at(SKIRT.geometry, hem).z).toBeGreaterThan(0.05)
    expect(length(out)).toBeCloseTo(length(SKIRT.geometry), 2)
  })

  it('swings out round one spring, the cloth going smoothly to the still ones', () => {
    const out = SKIRT.geometry.clone()
    drape(out, SKIRT, SPRINGS.map((_, i) => ({ angle: i === 0 ? 0.5 : 0, bend: 0 })))
    /** How far the hem moved at a polar angle. */
    const moved = (θ: number) => {
      let best = -1
      for (let i = 0; i < rest.count; i++) if (Math.abs(SKIRT.below[i]! - 0.58) < 0.001 && SKIRT.out[i]! > -0.001 && (best < 0 || Math.abs(SKIRT.theta[i]! - θ) < Math.abs(SKIRT.theta[best]! - θ))) best = i
      return at(out, best).distanceTo(at(SKIRT.geometry, best))
    }
    // Swung as a whole on its own side of the front: the hem 0.58 m below the waist moves about 0.58 * 2 sin(0.25).
    expect(moved(SPRINGS[0]!)).toBeCloseTo(0.58 * 2 * Math.sin(0.25), 1)
    expect(moved(0.3)).toBeCloseTo(moved(SPRINGS[0]!), 2)
    const between = moved((SPRINGS[0]! + SPRINGS[1]!) / 2)
    expect(between).toBeGreaterThan(0.05)
    expect(between).toBeLessThan(moved(SPRINGS[0]!) - 0.05)
    expect(moved(SPRINGS[2]!)).toBeLessThan(1e-6)
    expect(moved(SPRINGS[3]!)).toBeLessThan(1e-6)
  })

  it('keeps its cloth facing out as it flares', () => {
    const out = SKIRT.geometry.clone()
    drape(out, SKIRT, SPRINGS.map((_, i) => ({ angle: 0.3 + 0.1 * i, bend: 0.4 })))
    const n = out.getAttribute('normal')
    let outward = 0
    for (const i of back) {
      const normal = new Vector3().fromBufferAttribute(n, i)
      expect(normal.length()).toBeCloseTo(1, 5)
      if (normal.z < 0) outward++
    }
    expect(outward).toBe(back.length)
  })
})
