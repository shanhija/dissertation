/**
 * What is worn swings. Each named part of a worn model hangs from its pivot like a pendulum with
 * some stiffness of its own, its weight where hangOf finds it: thrown by how that weight's frame
 * moves (starting, stopping, turning, the bob of each step, a jump, a landing, a fall) and pulled
 * by the world as the doctor bends or lies. At rest it is as it was made on a doctor standing
 * upright, so a part made sticking up stands, wobbling. A part inside a part is carried by the
 * outer one's swing and swings on from it, so a chain of parts bends down its length.
 *
 * A part does not swing into the doctor's trunk or head (an upright ellipse round the body's
 * middle in the model's frame): its weight comes no nearer the middle than the body's surface, or
 * than a little inside where it was made, as made parts often hug the body or sink into it.
 *
 * It follows where each weight was in the world at the last frame drawn (the matrices three.js
 * last worked out), which costs nothing and is only a frame late.
 */

import { Matrix3, Matrix4, Quaternion, Vector3, type Group } from 'three'

import { hangOf, partTransform, type PartDef, type Recipe } from '../model/kit'
import { GRAVITY } from '../protocol'

/**
 * Stiffness, over what the world's pull gives a hanging weight: a part made hanging straight down
 * is limp, so it falls toward the ground with a doctor lying down; one made sticking out or up is
 * springy, stiffer than the pull, so it stays out or up; one made hanging aslant, between.
 */
const LIMP = 0.25
const SPRINGY = 1.6
/** Damping as a share of critical: lively, still in a few swings. */
const DAMP = 0.2
/** Weight nearer its pivot than this swings as though this far (nearer would only buzz). */
const MIN_LEVER = 0.08
/** Weight nearer its pivot than this does not swing at all: it turns about itself. */
const NO_LEVER = 0.015
const MAX_ANGLE = 1.4
/**
 * How much of how hard its frame is thrown a part feels: the doctors start and stop far harder
 * than people do (at up to 67 m/s²), and all of it would fling everything out flat at every step.
 */
const THROW = 0.5
/** How much nearer the body's middle than made a weight may swing, as a share of how deep it sits (depth, squared distances). */
const SLACK = 0.8
/** How hard a frame is thrown at most, m/s², and how far a weight may move in a frame before it counts as a jump to elsewhere. */
const MAX_ACCEL = 60
const TELEPORT = 1.5

/** An upright ellipse in a model's own frame, round its centre (x, z) with half-widths rx and rz: the body a worn part may not swing into. */
export interface Fence {
  x: number
  z: number
  rx: number
  rz: number
}

interface Swinger {
  group: Group
  rest: Quaternion
  /** Its pivot and how far its weight hangs from it, in the frame it hangs in. */
  pivot: Vector3
  reach: number
  /** How deep into the body its weight may go (see depth), 0 when it may go anywhere. */
  floor: number
  /** From the pivot toward the weight at rest, as a unit vector, in the frame the part hangs in. */
  dir: Vector3
  lever: number
  /** Its stiffness, 1/s²: how hard it springs back per radian. */
  stiff: number
  /** The weight at rest in the frame the part hangs in: followed through the world to see how it is thrown. */
  weight: Vector3
  /** What the world's pull turns it by at rest, which its stiffness holds: (dir × down) / lever. */
  hold: Vector3
  /** Its turn from rest, a rotation vector in the frame it hangs in, and how fast that turns. */
  angle: Vector3
  spin: Vector3
  was: Vector3
  vel: Vector3
  accel: Vector3
  seen: number
}

const at = new Vector3()
const v = new Vector3()
const pull = new Vector3()
const r = new Vector3()
const torque = new Vector3()
const axis = new Vector3()
const turn = new Quaternion()
const inverse = new Matrix3()
const toModel = new Matrix4()
const fromWorld = new Matrix4()
const held = new Vector3()

export class Swing {
  private readonly swingers: Swinger[] = []

  /** How far a point of the model's frame is from the body's middle, squared, as a share of the body's own reach that way: 1 on its surface, below inside. */
  private depth(p: Vector3): number {
    const f = this.fence!
    return ((p.x - f.x) / f.rx) ** 2 + ((p.z - f.z) / f.rz) ** 2
  }

  /** Where the weight is, in the model's frame, turned by `angle` from rest. */
  private weightAt(s: Swinger, angle: Vector3, out: Vector3): Vector3 {
    const a = angle.length()
    out.copy(s.dir)
    if (a > 1e-6) out.applyAxisAngle(axis.copy(angle).divideScalar(a), a)
    return out.multiplyScalar(s.reach).add(s.pivot).applyMatrix4(toModel)
  }

  /** The parts of a model, its root (where it is worn) and the body round it, if any. */
  constructor(
    recipe: Recipe,
    parts: readonly { def: PartDef; group: Group }[],
    private readonly root: Group,
    private readonly fence: Fence | null,
  ) {
    for (const { def, group } of parts) {
      const hang = hangOf(recipe, def.name)
      if (hang === null) continue
      const rest = group.quaternion.clone()
      const dir = new Vector3(...hang).applyQuaternion(rest)
      const lever = dir.length()
      if (lever < NO_LEVER) continue
      dir.divideScalar(lever)
      // Down, at rest, in the frame of the part it hangs from (the model's own frame is upright on an upright doctor).
      const up = partTransform(recipe.parts, def.parent).r
      const down = new Vector3(-up[3], -up[4], -up[5]).multiplyScalar(GRAVITY)
      const g = GRAVITY / Math.max(lever, MIN_LEVER)
      const weight = new Vector3(...def.at).addScaledVector(dir, lever)
      const frame = partTransform(recipe.parts, def.parent)
      const inModel = new Vector3(
        frame.p[0] + frame.r[0] * weight.x + frame.r[1] * weight.y + frame.r[2] * weight.z,
        0,
        frame.p[2] + frame.r[6] * weight.x + frame.r[7] * weight.y + frame.r[8] * weight.z,
      )
      this.swingers.push({
        group,
        rest,
        pivot: new Vector3(...def.at),
        reach: lever,
        floor: fence === null ? 0 : Math.min(1, SLACK * this.depth(inModel)),
        dir,
        lever: Math.max(lever, MIN_LEVER),
        stiff: g * (SPRINGY + (LIMP - SPRINGY) * Math.max(0, dir.dot(down) / GRAVITY)),
        weight,
        hold: dir.clone().cross(down).divideScalar(Math.max(lever, MIN_LEVER)),
        angle: new Vector3(),
        spin: new Vector3(),
        was: new Vector3(),
        vel: new Vector3(),
        accel: new Vector3(),
        seen: 0,
      })
    }
  }

  /** Whether anything in it swings. */
  get moves(): boolean {
    return this.swingers.length > 0
  }

  /** Swings every part on by dt seconds. */
  step(dt: number): void {
    if (dt <= 0) return
    const k = 1 - Math.exp(-dt * 25)
    const n = Math.max(1, Math.ceil(dt * 120))
    const h = dt / n
    if (this.fence) fromWorld.copy(this.root.matrixWorld).invert()
    for (const s of this.swingers) {
      const frame = s.group.parent!.matrixWorld
      at.copy(s.weight).applyMatrix4(frame)
      // How its frame is thrown, smoothed over the snapshots' steps; nothing at first, or after a jump to elsewhere.
      if (s.seen < 2 || at.distanceTo(s.was) > TELEPORT) {
        s.vel.set(0, 0, 0)
        s.accel.set(0, 0, 0)
      } else {
        v.subVectors(at, s.was).divideScalar(dt).sub(s.vel).multiplyScalar(k)
        s.vel.add(v)
        s.accel.lerp(v.divideScalar(dt).clampLength(0, MAX_ACCEL), k)
      }
      s.was.copy(at)
      s.seen++
      // The pull it feels, in the frame it hangs in: the world's, less (some of) how its frame is thrown.
      pull.set(0, -GRAVITY, 0).addScaledVector(s.accel, -THROW)
      const strength = pull.length()
      pull.applyMatrix3(inverse.setFromMatrix4(frame).invert()).normalize().multiplyScalar(strength)
      const damp = 2 * DAMP * Math.sqrt(s.stiff + GRAVITY / s.lever)
      const fenced = s.floor > 0.05
      if (fenced) toModel.multiplyMatrices(fromWorld, frame)
      for (let i = 0; i < n; i++) {
        const a = s.angle.length()
        r.copy(s.dir)
        if (a > 1e-6) r.applyAxisAngle(axis.copy(s.angle).divideScalar(a), a)
        torque.crossVectors(r, pull).divideScalar(s.lever).sub(s.hold)
        s.spin.addScaledVector(torque.addScaledVector(s.angle, -s.stiff).addScaledVector(s.spin, -damp), h)
        if (!fenced) {
          s.angle.addScaledVector(s.spin, h)
          continue
        }
        // No deeper into the body than its floor, or than it was: stopped there, bouncing back a little.
        const was = this.depth(this.weightAt(s, s.angle, r))
        held.copy(s.angle)
        s.angle.addScaledVector(s.spin, h)
        const now = this.depth(this.weightAt(s, s.angle, r))
        if (now < s.floor && now < was) {
          s.angle.copy(held)
          s.spin.multiplyScalar(-0.2)
        }
      }
      s.angle.clampLength(0, MAX_ANGLE)
      const a = s.angle.length()
      if (a > 1e-6) s.group.quaternion.multiplyQuaternions(turn.setFromAxisAngle(axis.copy(s.angle).divideScalar(a), a), s.rest)
      else s.group.quaternion.copy(s.rest)
    }
  }
}
