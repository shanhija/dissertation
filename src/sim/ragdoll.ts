/**
 * A doctor's body as a physical ragdoll in the round, the same on every screen: pelvis, chest and
 * head, upper and lower arms, thighs, and shins with feet. Ball joints at the waist and the neck,
 * held by soft springs (the chest folds and the head lolls, then they come back), ball joints at
 * the shoulders, and hinges at the hips, knees and elbows that bend only the ways they bend. It
 * takes over a doctor knocked hard or dismissed (sim.ts decides when): it falls, rolls and is
 * thrown like any body, flailing as it flies (arms windmilling, legs pedalling) and going limp
 * once it comes down; things and rays that touch its parts find the doctor, and a doctor still
 * in stands up where it settles ("ragdolling should be far more expressive").
 *
 * Each part's frame matches the drawn doctor's joint (the part hangs along its own -y from the
 * joint, the doctor facing +z), so the page turns the parts' rotations straight into its joints.
 */

import RAPIER, { type Collider, type RevoluteImpulseJoint, type RigidBody, type World } from '@dimforge/rapier3d-compat'

import type { Quat, RagSnap, Vec3 } from '../protocol'

/** The pelvis joint's height on a standing doctor of size 1: the trunk's origin. */
export const PELVIS_Y = 0.92

type Shape = { kind: 'box'; half: Vec3; at: Vec3 } | { kind: 'ball'; r: number; at: Vec3 } | { kind: 'capsule'; r: number; length: number; at: Vec3 }

interface PartSpec {
  /** The part it hangs from, and where on that part the joint is (null: the trunk). */
  parent: number | null
  anchor: Vec3
  shapes: Shape[]
  /** Kilograms, for a doctor of size 1. */
  mass: number
  /** A hinge about x with these limits (radians, + swings the part back, as the drawn joints), or a ball joint. */
  hinge: [number, number] | null
}

/** The parts' indices: what a snapshot sends their turns in. */
export const PELVIS = 0
export const CHEST = 1
export const HEAD = 2
/** Upper arm, forearm: right (3, 4) then left (5, 6). Thigh, shin: right (7, 8) then left (9, 10). */
export const UPPER = [3, 5] as const
export const THIGH = [7, 9] as const

const arm = (side: number): PartSpec[] => [
  { parent: CHEST, anchor: [side * 0.22, 0.42, 0], shapes: [{ kind: 'capsule', r: 0.06, length: 0.3, at: [0, -0.15, 0] }], mass: 2.5, hinge: null },
  { parent: -1, anchor: [0, -0.3, 0], shapes: [{ kind: 'capsule', r: 0.055, length: 0.31, at: [0, -0.155, 0] }], mass: 2, hinge: [-2.5, 0] },
]
const leg = (side: number): PartSpec[] => [
  { parent: PELVIS, anchor: [side * 0.1, 0, 0], shapes: [{ kind: 'capsule', r: 0.075, length: 0.44, at: [0, -0.22, 0] }], mass: 8, hinge: [-1.9, 0.5] },
  {
    parent: -1,
    anchor: [0, -0.44, 0],
    shapes: [
      { kind: 'capsule', r: 0.065, length: 0.43, at: [0, -0.215, 0] },
      { kind: 'box', half: [0.06, 0.035, 0.13], at: [0, -0.445, 0.05] },
    ],
    mass: 4.5,
    hinge: [0, 2.4],
  },
]

/** The parts in the order a snapshot sends their turns: pelvis, chest, head, right arm (upper, fore), left arm, right leg (thigh, shin), left leg. The right side is -x. */
const PARTS: PartSpec[] = [
  { parent: null, anchor: [0, PELVIS_Y, 0], shapes: [{ kind: 'box', half: [0.17, 0.1, 0.11], at: [0, 0, 0] }], mass: 14, hinge: null },
  // The chest from the waist (1.0 m on a standing doctor of size 1), the head from the neck (1.49 m).
  { parent: PELVIS, anchor: [0, 0.08, 0], shapes: [{ kind: 'box', half: [0.2, 0.23, 0.13], at: [0, 0.24, 0] }], mass: 19, hinge: null },
  { parent: CHEST, anchor: [0, 0.49, 0], shapes: [{ kind: 'ball', r: 0.13, at: [0, 0.11, 0] }], mass: 5, hinge: null },
  ...arm(-1),
  ...arm(1),
  ...leg(-1),
  ...leg(1),
]
// A part with parent -1 hangs from the part before it.
PARTS.forEach((p, i) => {
  if (p.parent === -1) p.parent = i - 1
})

const volumeOf = (s: Shape) => (s.kind === 'box' ? 8 * s.half[0] * s.half[1] * s.half[2] : s.kind === 'ball' ? (4 / 3) * Math.PI * s.r ** 3 : Math.PI * s.r * s.r * (s.length - 2 * s.r) + (4 / 3) * Math.PI * s.r ** 3)

const r3 = (v: number) => Math.round(v * 1000) / 1000
const v3 = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z]
const xyz = (v: Vec3) => ({ x: v[0], y: v[1], z: v[2] })
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
type Q = { x: number; y: number; z: number; w: number }
const qinv = (q: Q): Q => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w })
const qmul = (a: Q, b: Q): Q => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
})
const qrot = (q: Q, v: Vec3): Vec3 => {
  const cx = q.y * v[2] - q.z * v[1] + q.w * v[0]
  const cy = q.z * v[0] - q.x * v[2] + q.w * v[1]
  const cz = q.x * v[1] - q.y * v[0] + q.w * v[2]
  return [v[0] + 2 * (q.y * cz - q.z * cy), v[1] + 2 * (q.z * cx - q.x * cz), v[2] + 2 * (q.x * cy - q.y * cx)]
}

/** Turns v by the rotation about y. */
const turnY = (v: Vec3, yaw: number): Vec3 => [v[0] * Math.cos(yaw) + v[2] * Math.sin(yaw), v[1], -v[0] * Math.sin(yaw) + v[2] * Math.cos(yaw)]

export class Ragdoll {
  readonly parts: RigidBody[] = []
  readonly colliders: Collider[] = []
  sunk = false
  /** Where in their flailing this body starts, so no two flail alike. */
  private readonly seed: number

  /**
   * Builds the body standing where a doctor stands (feet at `at`, facing yaw, size s), moving at
   * vel and turning at spin (rad/s about the trunk), its colliders in the doctor's own groups.
   */
  constructor(
    private readonly world: World,
    at: Vec3,
    yaw: number,
    s: number,
    vel: Vec3,
    spin: Vec3,
    collisionGroups: number,
    own: (c: Collider) => void,
  ) {
    this.seed = (at[0] * 7.31 + at[2] * 3.17) % 6.28
    const q = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }
    const origins: Vec3[] = []
    const trunk: Vec3 = [at[0], at[1] + PELVIS_Y * s, at[2]]
    PARTS.forEach((p, i) => {
      const o: Vec3 = p.parent === null ? trunk : (() => {
        const base = origins[p.parent]!
        const a = turnY([p.anchor[0] * s, p.anchor[1] * s, p.anchor[2] * s], yaw)
        return [base[0] + a[0], base[1] + a[1], base[2] + a[2]]
      })()
      origins.push(o)
      // A point on the turning trunk moves at vel + spin × its offset.
      const r: Vec3 = [o[0] - trunk[0], o[1] - trunk[1], o[2] - trunk[2]]
      const v: Vec3 = [vel[0] + spin[1] * r[2] - spin[2] * r[1], vel[1] + spin[2] * r[0] - spin[0] * r[2], vel[2] + spin[0] * r[1] - spin[1] * r[0]]
      const rb = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(o[0], o[1], o[2])
          .setRotation(q)
          .setLinvel(v[0], v[1], v[2])
          .setAngvel({ x: spin[0], y: spin[1], z: spin[2] })
          .setLinearDamping(0.05)
          // Loose: limbs swing and flop rather than stiffen.
          .setAngularDamping(i <= HEAD ? 0.5 : 0.35)
          .setCcdEnabled(true),
      )
      const volume = p.shapes.reduce((sum, sh) => sum + volumeOf(sh), 0)
      for (const sh of p.shapes) {
        const c = sh.at.map((x) => x * s) as Vec3
        const desc =
          sh.kind === 'box'
            ? RAPIER.ColliderDesc.cuboid(sh.half[0] * s, sh.half[1] * s, sh.half[2] * s)
            : sh.kind === 'ball'
              ? RAPIER.ColliderDesc.ball(sh.r * s)
              : RAPIER.ColliderDesc.capsule(Math.max(0.01, sh.length / 2 - sh.r) * s, sh.r * s)
        desc
          .setTranslation(c[0], c[1], c[2])
          .setDensity(p.mass / volume)
          .setFriction(0.9)
          .setRestitution(0.1)
          .setCollisionGroups(collisionGroups)
        const collider = world.createCollider(desc, rb)
        own(collider)
        this.colliders.push(collider)
      }
      this.parts.push(rb)
      if (p.parent !== null) {
        const anchor = { x: p.anchor[0] * s, y: p.anchor[1] * s, z: p.anchor[2] * s }
        const zero = { x: 0, y: 0, z: 0 }
        const data = p.hinge ? RAPIER.JointData.revolute(anchor, zero, { x: 1, y: 0, z: 0 }) : RAPIER.JointData.spherical(anchor, zero)
        const joint = world.createImpulseJoint(data, this.parts[p.parent]!, rb, true)
        joint.setContactsEnabled(false)
        // A hinge's limits are set on the joint made (the description's are not passed on for hinges).
        if (p.hinge) (joint as RevoluteImpulseJoint).setLimits(p.hinge[0], p.hinge[1])
      }
    })
  }

  /**
   * Every step: the waist and the neck sprung back toward straight (softly: the chest folds and
   * the head lolls, then they come back), and while it flies, flailing that fades with its speed
   * and its time down (seconds since it fell; shorter for the dismissed).
   */
  step(age: number, dt: number, alive: boolean): void {
    if (this.sunk) return
    this.spring(PELVIS, CHEST, 16, dt)
    this.spring(CHEST, HEAD, 7, dt)
    const speed = len(this.velocity())
    const e = Math.max(0, 1 - age / (alive ? 1.5 : 0.9)) * Math.min(1, speed / 3)
    if (e < 0.02) return
    const chest = this.parts[CHEST]!.rotation()
    const pelvis = this.parts[PELVIS]!.rotation()
    for (const side of [0, 1] as const) {
      const sign = side ? 1 : -1
      // Arms windmilling, out of step with each other, flung out a little; legs pedalling.
      const pa = age * 13 + side * Math.PI + this.seed
      this.toward(this.parts[UPPER[side]]!, add(v3(this.parts[CHEST]!.angvel()), qrot(chest, [Math.sin(pa) * 12, 0, sign * (4 + Math.cos(pa) * 5)])), 0.3 * e)
      const pl = age * 10 + side * Math.PI + this.seed
      this.toward(this.parts[THIGH[side]]!, add(v3(this.parts[PELVIS]!.angvel()), qrot(pelvis, [Math.sin(pl) * 9, 0, sign * Math.cos(pl) * 2])), 0.22 * e)
    }
  }

  /** A soft spring at a ball joint: the child's turn drawn back toward its parent's, equal and opposite. */
  private spring(parent: number, child: number, k: number, dt: number): void {
    const a = this.parts[parent]!
    const b = this.parts[child]!
    const qa = a.rotation()
    const r = qmul(qinv(qa), b.rotation())
    const w = Math.max(-1, Math.min(1, r.w))
    const half = Math.acos(Math.abs(w))
    const sin = Math.sin(half)
    if (sin < 1e-4) return
    const sign = w < 0 ? -1 : 1
    const angle = 2 * half
    const axis = qrot(qa, [(r.x / sin) * sign, (r.y / sin) * sign, (r.z / sin) * sign])
    // Stiffer the further it bends: a little give, then firm.
    const d = scale(axis, angle * k * (1 + angle * angle) * dt)
    const wb = v3(b.angvel())
    const wa = v3(a.angvel())
    b.setAngvel(xyz(sub(wb, scale(d, 0.75))), true)
    a.setAngvel(xyz(add(wa, scale(d, 0.25))), true)
  }

  /** Turns a part's spin a share of the way toward a spin. */
  private toward(rb: RigidBody, target: Vec3, share: number): void {
    const w = v3(rb.angvel())
    rb.setAngvel(xyz(add(w, scale(sub(target, w), share))), true)
  }

  /** The pelvis joint (the trunk's origin), world. */
  pelvis(): Vec3 {
    const t = this.parts[0]!.translation()
    return [t.x, t.y, t.z]
  }

  /** How fast the trunk moves. */
  velocity(): Vec3 {
    const v = this.parts[0]!.linvel()
    return [v.x, v.y, v.z]
  }

  /** Adds a velocity to every part (a knock while down throws it again). */
  push(v: Vec3): void {
    for (const rb of this.parts) {
      const cur = rb.linvel()
      rb.setLinvel({ x: cur.x + v[0], y: cur.y + v[1], z: cur.z + v[2] }, true)
    }
  }

  /** It stops touching anything and drops through the floor. */
  sink(): void {
    this.sunk = true
    for (const c of this.colliders) c.setCollisionGroups(0)
    for (const rb of this.parts) rb.wakeUp()
  }

  snap(): RagSnap {
    const p = this.pelvis()
    return {
      p: [r3(p[0]), r3(p[1]), r3(p[2])],
      q: this.parts.map((rb) => {
        const q = rb.rotation()
        return [r3(q.x), r3(q.y), r3(q.z), r3(q.w)] as Quat
      }),
    }
  }

  /** Takes the body out of the world; returns its colliders' handles, which are no one's any more. */
  remove(): number[] {
    const handles = this.colliders.map((c) => c.handle)
    for (const rb of this.parts) this.world.removeRigidBody(rb)
    return handles
  }
}
