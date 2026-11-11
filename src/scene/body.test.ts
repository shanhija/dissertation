import { Group, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { BODY } from '../doctor'
import { buildArena } from '../sim/arena'
import { LECTURE_HALL } from '../sim/hall'
import { Sim, initPhysics } from '../sim/sim'
import { applyRag, reach, type DoctorMesh } from './doctor'
import { JOINTS } from './figure'

/** The end of a two-part limb posed as reach says, from a shoulder at s. */
function endOf(s: Vector3, pose: ReturnType<typeof reach>, a: number, b: number): { elbow: Vector3; end: Vector3 } {
  const shoulder = new Group()
  shoulder.position.copy(s)
  shoulder.quaternion.copy(pose.q)
  const elbow = new Group()
  elbow.position.set(0, -a, 0)
  elbow.rotation.set(pose.elbow, 0, 0)
  shoulder.add(elbow)
  shoulder.updateMatrixWorld(true)
  return { elbow: elbow.getWorldPosition(new Vector3()), end: elbow.localToWorld(new Vector3(0, -b, 0)) }
}

describe('reaching', () => {
  it('puts the hand on any target within reach, the elbow toward the pole', () => {
    const s = new Vector3(-0.22, 0.42, 0)
    const pole = new Vector3(-0.5, -1, -0.35)
    const a = JOINTS.upper
    const b = JOINTS.fore + JOINTS.palm
    for (const t of [new Vector3(-0.28, 0.3, 0.45), new Vector3(0.1, 0.1, 0.3), new Vector3(-0.4, 0.6, 0.2), new Vector3(-0.2, -0.1, 0.25), new Vector3(0, 0.5, 0.3)]) {
      const pose = reach(s, t, a, b, pole)
      const { elbow, end } = endOf(s, pose, a, b)
      expect(end.distanceTo(t), `target ${t.toArray()}`).toBeLessThan(1e-3)
      // The elbow lies on the pole's side of the line from shoulder to hand.
      const line = t.clone().sub(s).normalize()
      const off = elbow.clone().sub(s)
      off.sub(line.multiplyScalar(off.dot(line)))
      expect(off.dot(pole), `target ${t.toArray()}`).toBeGreaterThan(0)
    }
  })

  it('stretches straight toward a target out of reach', () => {
    const s = new Vector3(0, 0, 0)
    const pose = reach(s, new Vector3(0, 0, 2), 0.3, 0.3, new Vector3(0, -1, 0))
    const { end } = endOf(s, pose, 0.3, 0.3)
    expect(end.z).toBeGreaterThan(0.59)
    expect(Math.abs(end.y)).toBeLessThan(0.02)
  })
})

/** A doctor's joints with nothing drawn on them, placed as DoctorMesh places them. */
function skeleton(): DoctorMesh {
  const g = (x: number, y: number, z: number, parent: Group) => {
    const o = new Group()
    o.position.set(x, y, z)
    parent.add(o)
    return o
  }
  const root = new Group()
  const body = g(0, 0, 0, root)
  const pelvis = g(0, BODY.hips.y, 0, body)
  const spine = g(0, JOINTS.waist, 0, body)
  const neck = g(0, JOINTS.neck - JOINTS.waist, 0, spine)
  const head = g(0, BODY.head.center[1] - JOINTS.neck, 0, neck)
  const hips: Group[] = []
  const knees: Group[] = []
  const ankles: Group[] = []
  const shoulders: Group[] = []
  const elbows: Group[] = []
  const wrists: Group[] = []
  for (const side of [-1, 1]) {
    const hip = g(side * JOINTS.hipX, 0, 0, pelvis)
    const knee = g(0, -JOINTS.thigh, 0, hip)
    hips.push(hip)
    knees.push(knee)
    ankles.push(g(0, -JOINTS.shin, 0, knee))
    const shoulder = g(side * BODY.shoulders.half, BODY.shoulders.y - JOINTS.waist, 0, spine)
    const elbow = g(0, -JOINTS.upper, 0, shoulder)
    shoulders.push(shoulder)
    elbows.push(elbow)
    wrists.push(g(0, -JOINTS.fore, 0, elbow))
  }
  return { root, body, pelvis, spine, neck, head, hips, knees, ankles, shoulders, elbows, wrists } as unknown as DoctorMesh
}

describe('the ragdoll as drawn', () => {
  it('lays the joints where the game\'s ragdoll has its parts', async () => {
    await initPhysics()
    const sim = new Sim(() => 0.5)
    buildArena(sim, LECTURE_HALL)
    sim.live = true
    const d = sim.addDoctor('a', 'A', false)
    sim.teleport(d, [0, 0.05, 0])
    for (let i = 0; i < 10; i++) sim.step()
    sim.knock(d, [0, 9, 14])
    for (let i = 0; i < 25; i++) sim.step()
    const snap = sim.snapshot().doctors[0]!
    expect(snap.rag).not.toBe(null)
    const m = skeleton()
    m.root.position.set(...snap.p)
    m.root.rotation.y = snap.yaw
    applyRag(m, snap.rag!.p, snap.rag!.q)
    m.root.updateMatrixWorld(true)
    const at = (o: Group) => o.getWorldPosition(new Vector3())
    const part = (i: number) => {
      const t = d.rag!.parts[i]!.translation()
      return new Vector3(t.x, t.y, t.z)
    }
    // Each part's origin is its joint: the pelvis, the waist, the neck, shoulders, elbows, hips, knees.
    expect(at(m.pelvis).distanceTo(part(0))).toBeLessThan(0.01)
    expect(at(m.spine).distanceTo(part(1))).toBeLessThan(0.02)
    expect(at(m.neck).distanceTo(part(2))).toBeLessThan(0.02)
    for (const i of [0, 1]) {
      expect(at(m.shoulders[i]!).distanceTo(part(3 + 2 * i))).toBeLessThan(0.02)
      expect(at(m.elbows[i]!).distanceTo(part(4 + 2 * i))).toBeLessThan(0.02)
      expect(at(m.hips[i]!).distanceTo(part(7 + 2 * i))).toBeLessThan(0.02)
      expect(at(m.knees[i]!).distanceTo(part(8 + 2 * i))).toBeLessThan(0.02)
    }
    sim.free()
  })
})
