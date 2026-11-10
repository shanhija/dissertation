/**
 * Clothes that move: worn parts swinging from their pivots (swing.ts) and the coat's panels
 * bending (doctor.ts), without a browser.
 */
import { BufferAttribute, BufferGeometry, Group, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { buildRecipe, type Kit } from '../model/kit'
import { bendPanel } from './doctor'
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
  /** A strip of cloth down a panel's middle, waist to hem, facing out. */
  function strip(): BufferGeometry {
    const g = new BufferGeometry()
    const ys = Array.from({ length: 30 }, (_, i) => -i * 0.02)
    g.setAttribute('position', new BufferAttribute(new Float32Array(ys.flatMap((y) => [0, y, 0])), 3))
    g.setAttribute('normal', new BufferAttribute(new Float32Array(ys.flatMap(() => [0, 0, 1])), 3))
    return g
  }
  const points = (g: BufferGeometry, name: string) => {
    const a = g.getAttribute(name)
    return Array.from({ length: a.count }, (_, i) => new Vector3(a.getX(i), a.getY(i), a.getZ(i)))
  }

  it('bends out below the pockets, keeping its length and its cloth facing out', () => {
    const rest = strip()
    const out = rest.clone()
    bendPanel(out, rest, 0)
    expect(points(out, 'position')).toEqual(points(rest, 'position'))
    bendPanel(out, rest, 0.7)
    const p = points(out, 'position')
    const r = points(rest, 'position')
    p.forEach((v, i) => {
      if (r[i]!.y >= -0.3) expect(v.distanceTo(r[i]!)).toBeLessThan(1e-6)
    })
    expect(p.at(-1)!.z).toBeGreaterThan(0.05)
    let length = 0
    for (let i = 1; i < p.length; i++) length += p[i]!.distanceTo(p[i - 1]!)
    expect(length).toBeCloseTo(0.58, 2)
    // Each normal stays a unit across the cloth's run.
    const n = points(out, 'normal')
    for (let i = 1; i < p.length; i++) {
      expect(n[i]!.length()).toBeCloseTo(1, 5)
      expect(Math.abs(n[i]!.dot(p[i]!.clone().sub(p[i - 1]!).normalize()))).toBeLessThan(0.05)
    }
  })
})
