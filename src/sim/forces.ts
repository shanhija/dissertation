/**
 * What moves things by force rather than by walking or flying: blasts, fields, ties (ropes and
 * springs) and bodies stuck to what they hit. Each acts alike on whatever it reaches: a doctor
 * standing (through their knock: push and vy), a doctor lying as a ragdoll (through every part),
 * a body or a loose thing (through its velocity). Masses: a doctor 80 kg times their size cubed,
 * a body or a thing its own, anything fixed or stuck too heavy to move.
 *
 * Fairness, as for holds: a doctor pulled hard by a field or a taut tie counts as held (sim.ts's
 * control rule), and once they shake it off, fields and ties let them be for HOLD_MAX; a blast
 * still reaches them, but only pushes (sim.ts's flopFree). A doctor a force moves is the doing of
 * whoever's thing made it (sim.blame).
 */

import RAPIER from '@dimforge/rapier3d-compat'

import type { Vec3 } from '../protocol'
import { blastPieces } from './breaking'
import { PELVIS_Y } from './ragdoll'
import { add, dot, len, norm, scale, sub, quatOf, type Body, type Doctor, type Sim, type Source, type Thing } from './sim'

/** A doctor's mass at size 1, kilograms. */
export const DOCTOR_MASS = 80
/** Field pull (m/s²) at which a doctor can no longer walk against it: held, for the hold rule. */
export const FORCED = 30
/** How high on a doctor a tie holds them: their chest, at size 1. */
export const CHEST = 1.15
const MIDDLE = 0.85

export type Q = { x: number; y: number; z: number; w: number }

export const qmul = (a: Q, b: Q): Q => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
})
export const qinv = (q: Q): Q => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w })
/** v turned by q. */
export function qrot(q: Q, v: Vec3): Vec3 {
  const cx = q.y * v[2] - q.z * v[1] + q.w * v[0]
  const cy = q.z * v[0] - q.x * v[2] + q.w * v[1]
  const cz = q.x * v[1] - q.y * v[0] + q.w * v[2]
  return [v[0] + 2 * (q.y * cz - q.z * cy), v[1] + 2 * (q.z * cx - q.x * cz), v[2] + 2 * (q.x * cy - q.y * cx)]
}
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/** The turn that points +z along face, with +y toward up as near as it can (or, with no face, +y along up). */
export function lookQuat(face: Vec3 | null, up: Vec3 | null): Q | null {
  if (face && len(face) > 1e-6) {
    const z = norm(face)
    let hint = up && len(up) > 1e-6 ? norm(up) : ([0, 1, 0] as Vec3)
    if (len(cross(hint, z)) < 1e-3) hint = Math.abs(z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    const x = norm(cross(hint, z))
    const y = cross(z, x)
    return fromBasis(x, y, z)
  }
  if (up && len(up) > 1e-6) {
    const u = norm(up)
    const d = u[1]
    if (d < -0.9999) return { x: 1, y: 0, z: 0, w: 0 }
    // The shortest turn from +y to u.
    const c = cross([0, 1, 0], u)
    const w = 1 + d
    const l = Math.hypot(c[0], c[1], c[2], w)
    return { x: c[0] / l, y: c[1] / l, z: c[2] / l, w: w / l }
  }
  return null
}

function fromBasis(x: Vec3, y: Vec3, z: Vec3): Q {
  const [m00, m10, m20] = x
  const [m01, m11, m21] = y
  const [m02, m12, m22] = z
  const tr = m00 + m11 + m22
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1)
    return { w: 0.25 / s, x: (m21 - m12) * s, y: (m02 - m20) * s, z: (m10 - m01) * s }
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22)
    return { w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s }
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22)
    return { w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s }
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11)
  return { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s }
}

const v3 = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z]
const capLen = (v: Vec3, max: number): Vec3 => {
  const l = len(v)
  return l > max ? scale(v, max / l) : v
}

// ------------------------------------------------------------------------------ what forces move

/** Something a force can move: where it is, how fast it goes, how heavy it is, and how to change its speed. */
export interface Actor {
  pos: Vec3
  vel: Vec3
  /** Kilograms; Infinity for what does not move. */
  mass: number
  /** Changes its velocity. */
  add(dv: Vec3): void
  doctor: Doctor | null
}

/** A doctor as a force sees them, at `height` up their body (a ragdoll: its pelvis). Null when out and gone. */
export function doctorActor(d: Doctor, height = MIDDLE): Actor | null {
  if (d.rag) {
    const rag = d.rag
    return { pos: rag.pelvis(), vel: rag.velocity(), mass: DOCTOR_MASS * d.size ** 3, add: (dv) => rag.push(dv), doctor: d }
  }
  if (!d.alive) return null
  return {
    pos: [d.pos[0], d.pos[1] + height * d.size, d.pos[2]],
    vel: [d.walk[0] + d.push[0] + d.carry[0], d.vy, d.walk[2] + d.push[2] + d.carry[2]],
    mass: DOCTOR_MASS * d.size ** 3,
    add: (dv) => {
      const p = capLen([d.push[0] + dv[0], 0, d.push[2] + dv[2]], 30)
      d.push = p
      d.vy = Math.max(-45, Math.min(30, d.vy + dv[1]))
      if (dv[1] > 0.05 && d.vy > 0.5) d.grounded = false
    },
    doctor: d,
  }
}

function rbActor(rb: RAPIER.RigidBody): Actor {
  const moves = rb.isDynamic()
  return {
    pos: v3(rb.translation()),
    vel: v3(rb.linvel()),
    mass: moves ? Math.max(0.01, rb.mass()) : Infinity,
    add: (dv) => {
      if (!moves) return
      const v = capLen(add(v3(rb.linvel()), dv), 80)
      rb.setLinvel({ x: v[0], y: v[1], z: v[2] }, true)
    },
    doctor: null,
  }
}

export function bodyActor(b: Body): Actor {
  return rbActor(b.rb)
}

/** A thing: in a hand, its holder (at the hand); loose, its body. */
export function thingActor(sim: Sim, t: Thing): Actor | null {
  if (t.dead) return null
  if (t.holder) {
    const d = sim.doctors.get(t.holder)
    const a = d ? doctorActor(d) : null
    if (a && d && !d.rag) a.pos = sim.handOf(d, t.hand)
    return a
  }
  return t.body ? rbActor(t.body) : null
}

/** Everything a force reaches: doctors (standing or lying), bodies that move, and loose things. */
function everything(sim: Sim, spare: Doctor | null): Actor[] {
  const out: Actor[] = []
  for (const d of sim.doctors.values()) {
    if (d === spare) continue
    const a = doctorActor(d)
    if (a) out.push(a)
  }
  for (const b of sim.bodies.values()) if (b.rb.isDynamic()) out.push(bodyActor(b))
  for (const t of sim.things.values()) if (!t.holder && t.body && !t.dead) out.push(rbActor(t.body))
  return out
}

// ------------------------------------------------------------------------------ blasts

/**
 * Throws everyone and everything within radius away from a point: speed m/s (what a doctor gets)
 * at the middle, falling to nothing at the edge, lighter bodies flying faster; the arena shelters
 * what is behind it. Doctors are knocked (hard enough, flat), and the breakable pieces of the arena
 * it reaches are struck (breaking.ts). Returns the doctors it reached.
 */
export function blast(sim: Sim, at: Vec3, radius: number, speed: number, spare: Doctor | null): { doctor: Doctor; strength: number }[] {
  const reached: { doctor: Doctor; strength: number }[] = []
  for (const a of everything(sim, spare)) {
    const rel = sub(a.pos, at)
    const dist = Math.max(0, len(rel) - (a.doctor ? 0.35 * a.doctor.size : 0.1))
    if (dist > radius) continue
    // From a little way out of the point, so a blast on a wall's face is not stopped by the wall.
    const dir = len(rel) < 1e-3 ? ([0, 1, 0] as Vec3) : norm(rel)
    if (!sim.clear(add(at, scale(dir, Math.min(0.2, len(rel) * 0.5))), a.pos)) continue
    const strength = Math.max(0, Math.min(1, 1 - dist / Math.max(0.01, radius)))
    const push = scale(norm(add(dir, [0, 0.35, 0])), speed * strength)
    if (a.doctor) {
      sim.knock(a.doctor, push)
      reached.push({ doctor: a.doctor, strength })
    } else a.add(capLen(scale(push, Math.max(0.3, Math.min(3, Math.sqrt(DOCTOR_MASS / a.mass)))), 60))
  }
  blastPieces(sim, at, radius, speed)
  return reached
}

// ------------------------------------------------------------------------------ fields

export type Follow = { kind: 'holder'; thing: Thing } | { kind: 'thing'; thing: Thing } | { kind: 'body'; id: string } | { kind: 'doctor'; id: string } | { kind: 'mover'; id: string } | null

export interface Field {
  id: string
  owner: string
  source: Source
  at: Vec3
  follow: Follow
  radius: number
  until: number
  pull: number
  swirl: number
  lift: number
  wind: Vec3
  drag: number
  dead: boolean
}

/** Where a followed point is now: at in the frame of what it follows (null when that is gone). */
export function placeOf(sim: Sim, at: Vec3, follow: Follow): Vec3 | null {
  if (!follow) return at
  const f = frameOf(sim, follow)
  return f ? add(f.p, qrot(f.q, at)) : null
}

/**
 * The frame of what something follows: a doctor's feet facing where they face; a body's middle
 * and turn; a thing's hand (aiming where its holder looks) or its body; the holder's feet (for
 * 'holder', whose x is to their right, as a zone's).
 */
export function frameOf(sim: Sim, f: NonNullable<Follow>): { p: Vec3; q: Q } | null {
  if (f.kind === 'body') {
    const b = sim.bodies.get(f.id)
    return b ? { p: v3(b.rb.translation()), q: b.rb.rotation() } : null
  }
  if (f.kind === 'mover') {
    const m = sim.arena?.movers.get(f.id)
    return m ? { p: v3(m.rb.translation()), q: m.rb.rotation() } : null
  }
  if (f.kind === 'doctor') {
    const d = sim.doctors.get(f.id)
    if (!d || (!d.alive && !d.rag)) return null
    return { p: [...d.pos], q: quatOf(d.yaw, 0) }
  }
  const t = f.thing
  if (t.dead) return null
  if (t.holder) {
    const d = sim.doctors.get(t.holder)!
    if (f.kind === 'holder') return { p: [...d.pos], q: quatOf(d.yaw, 0) }
    return { p: sim.handOf(d, t.hand), q: d.riding === t.id ? quatOf(d.yaw, 0) : quatOf(d.yaw, d.pitch) }
  }
  return t.body ? { p: v3(t.body.translation()), q: t.body.rotation() } : null
}

export function stepFields(sim: Sim, dt: number): void {
  const fields = sim.fields
  for (const f of fields) {
    if (f.dead) continue
    if (f.until < sim.time) {
      f.dead = true
      continue
    }
    const c = fieldCenter(sim, f)
    if (!c) {
      f.dead = true
      continue
    }
    const spare = f.source.thing?.holder ? (sim.doctors.get(f.source.thing.holder) ?? null) : null
    for (const a of everything(sim, spare)) {
      // Shaken free: fields let them be.
      if (a.doctor?.alive && sim.time < a.doctor.freeUntil) continue
      const rel = sub(a.pos, c)
      const dist = len(rel)
      if (dist > f.radius) continue
      // Whole within seven tenths of the radius, then fading to the edge.
      const k = dist < f.radius * 0.7 ? 1 : (f.radius - dist) / (f.radius * 0.3)
      let acc: Vec3 = [f.wind[0], f.wind[1] + f.lift, f.wind[2]]
      if (dist > 0.15) acc = add(acc, scale(rel, -f.pull / dist))
      const flat = Math.hypot(rel[0], rel[2])
      if (flat > 0.1) acc = add(acc, [(rel[2] / flat) * f.swirl, 0, (-rel[0] / flat) * f.swirl])
      acc = capLen(add(acc, scale(a.vel, -f.drag)), 150)
      if (a.doctor) {
        if (!a.doctor.rag) a.doctor.forced += len(acc) * k
        sim.blame(a.doctor, f.source)
      }
      a.add(scale(acc, k * dt))
    }
  }
}

function fieldCenter(sim: Sim, f: Field): Vec3 | null {
  if (f.follow?.kind === 'holder') {
    const t = f.follow.thing
    if (t.dead) return null
    if (t.holder) {
      const d = sim.doctors.get(t.holder)!
      // [right, up, ahead] from the holder's feet.
      const fwd: Vec3 = [Math.sin(d.yaw), 0, Math.cos(d.yaw)]
      const right: Vec3 = [-Math.cos(d.yaw), 0, Math.sin(d.yaw)]
      return [d.pos[0] + right[0] * f.at[0] + fwd[0] * f.at[2], d.pos[1] + f.at[1], d.pos[2] + right[2] * f.at[0] + fwd[2] * f.at[2]]
    }
    return t.body ? add(v3(t.body.translation()), f.at) : null
  }
  return placeOf(sim, f.at, f.follow)
}

// ------------------------------------------------------------------------------ ties

export type TieRef = { kind: 'point'; p: Vec3 } | { kind: 'doctor'; id: string } | { kind: 'body'; id: string } | { kind: 'thing'; id: string }

export interface Tie {
  id: string
  owner: string
  /** Whose doing a doctor it pulls is. */
  source: Source
  a: TieRef
  b: TieRef
  length: number
  /** 0 a rope (only stops it growing longer), up to 1 a stiff spring. */
  spring: number
  until: number
  color: string | null
  width: number
  dead: boolean
}

/** What a tie's end holds on to now (null: it is gone, and the tie with it). */
export function endActor(sim: Sim, r: TieRef): Actor | null {
  if (r.kind === 'point') return { pos: r.p, vel: [0, 0, 0], mass: Infinity, add: () => {}, doctor: null }
  if (r.kind === 'doctor') {
    const d = sim.doctors.get(r.id)
    if (!d || (d.alive && sim.time < d.freeUntil)) return null
    return doctorActor(d, CHEST)
  }
  if (r.kind === 'body') {
    const b = sim.bodies.get(r.id)
    return b ? bodyActor(b) : null
  }
  const t = sim.things.get(r.id)
  return t ? thingActor(sim, t) : null
}

export function stepTies(sim: Sim, dt: number): void {
  for (const t of sim.ties) {
    if (t.dead) continue
    const a = t.until >= sim.time ? endActor(sim, t.a) : null
    const b = a ? endActor(sim, t.b) : null
    if (!a || !b || (a.doctor && a.doctor === b.doctor)) {
      t.dead = true
      continue
    }
    const d = sub(b.pos, a.pos)
    const l = len(d)
    if (l < 1e-4) continue
    const n = scale(d, 1 / l)
    const stretch = l - t.length
    const vrel = dot(sub(b.vel, a.vel), n)
    let dv: number
    if (t.spring <= 0) {
      if (stretch <= 0) continue
      // A rope pulls in only as fast as closes what it is stretched by in an eighth of a second.
      dv = Math.max(-25, -stretch * 8) - vrel
      if (dv >= 0) continue
    } else {
      // Stiffness a second²: from a slow bungee at 0 to a snap at 1 (0.6 settles in about half a second).
      const k = 10 + 390 * t.spring * t.spring
      dv = (-k * stretch - Math.sqrt(k) * vrel) * dt
    }
    const wa = 1 / a.mass
    const wb = 1 / b.mass
    if (wa + wb === 0) continue
    dv = Math.max(-20, Math.min(20, dv))
    a.add(scale(n, (-dv * wa) / (wa + wb)))
    b.add(scale(n, (dv * wb) / (wa + wb)))
    if (a.doctor) sim.blame(a.doctor, t.source)
    if (b.doctor) sim.blame(b.doctor, t.source)
    // Held, for the hold rule: by a rope pulling at all, by a spring pulling hard.
    const hard = t.spring <= 0 || Math.abs(dv) / dt > FORCED
    if (hard) {
      if (a.doctor && !a.doctor.rag) a.doctor.tugged = true
      if (b.doctor && !b.doctor.rag) b.doctor.tugged = true
    }
  }
}

/** Where a tie's end is, for its length when made. */
export function endPos(sim: Sim, r: TieRef): Vec3 | null {
  return endActor(sim, r)?.pos ?? null
}

// ------------------------------------------------------------------------------ sticking

export type Stuck = { kind: 'world' } | { kind: 'doctor'; id: string; at: Vec3; q: Q } | { kind: 'body'; id: string; at: Vec3; q: Q }

/** The frame a body stuck to a doctor goes with: their pelvis, turned as they face (lying: their trunk). */
function doctorFrame(d: Doctor): { p: Vec3; q: Q } {
  if (d.rag) {
    const trunk = d.rag.parts[0]!
    return { p: v3(trunk.translation()), q: trunk.rotation() }
  }
  return { p: [d.pos[0], d.pos[1] + PELVIS_Y * d.size, d.pos[2]], q: quatOf(d.yaw, 0) }
}

/** Sticks a body to a doctor, another body, or (target null) where it is. A body stuck to anything that moves passes through what it touches. */
export function stick(b: Body, target: { doctor: Doctor } | { body: Body } | null): void {
  const p = v3(b.rb.translation())
  const q = b.rb.rotation()
  let frame: { p: Vec3; q: Q } | null = null
  if (target && 'doctor' in target) {
    if (!target.doctor.alive && !target.doctor.rag) return
    frame = doctorFrame(target.doctor)
    b.stuck = { kind: 'doctor', id: target.doctor.id, at: qrot(qinv(frame.q), sub(p, frame.p)), q: qmul(qinv(frame.q), q) }
  } else if (target && 'body' in target) {
    if (target.body === b) return
    frame = { p: v3(target.body.rb.translation()), q: target.body.rb.rotation() }
    b.stuck = { kind: 'body', id: target.body.id, at: qrot(qinv(frame.q), sub(p, frame.p)), q: qmul(qinv(frame.q), q) }
  } else b.stuck = { kind: 'world' }
  b.rb.setLinvel({ x: 0, y: 0, z: 0 }, false)
  b.rb.setAngvel({ x: 0, y: 0, z: 0 }, false)
  b.rb.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true)
  if (b.stuck.kind !== 'world') b.collider.setSensor(true)
}

export function unstick(b: Body): void {
  if (!b.stuck) return
  const fixed = b.fixed
  b.stuck = null
  b.collider.setSensor(!b.solid)
  if (!fixed) b.rb.setBodyType(RAPIER.RigidBodyType.Dynamic, true)
}

/** Stuck bodies go where what they are stuck to goes; one whose holder is gone falls loose. */
export function stepStuck(sim: Sim): void {
  for (const b of sim.bodies.values()) {
    const s = b.stuck
    if (!s || s.kind === 'world') continue
    let frame: { p: Vec3; q: Q } | null = null
    if (s.kind === 'doctor') {
      const d = sim.doctors.get(s.id)
      if (d && (d.alive || d.rag)) frame = doctorFrame(d)
    } else {
      const o = sim.bodies.get(s.id)
      if (o) frame = { p: v3(o.rb.translation()), q: o.rb.rotation() }
    }
    if (!frame) {
      unstick(b)
      continue
    }
    const p = add(frame.p, qrot(frame.q, s.at))
    b.rb.setNextKinematicTranslation({ x: p[0], y: p[1], z: p[2] })
    b.rb.setNextKinematicRotation(qmul(frame.q, s.q))
  }
}

// ------------------------------------------------------------------------------ momentum

/**
 * A body that hits a standing doctor knocks them by its momentum: its speed toward them, times
 * its share of the two masses. Light things barely move anyone; heavy, fast ones knock them flat.
 */
export function momentum(sim: Sim, b: Body, d: Doctor, came: Vec3): void {
  if (!d.alive || d.rag || b.stuck || !b.solid || !b.rb.isDynamic()) return
  const mid: Vec3 = [d.pos[0], d.pos[1] + MIDDLE * d.size, d.pos[2]]
  const n = norm(sub(mid, v3(b.rb.translation())))
  const vn = dot(came, n)
  if (vn < 2) return
  const mb = Math.max(0.01, b.rb.mass())
  const md = DOCTOR_MASS * d.size ** 3
  const dv = (vn * mb * 1.4) / (mb + md)
  if (dv < 0.8) return
  const flat = norm([n[0], 0, n[2]])
  sim.blame(d, b.source)
  sim.knock(d, [flat[0] * dv, Math.max(n[1], 0.25) * dv, flat[2] * dv])
}
