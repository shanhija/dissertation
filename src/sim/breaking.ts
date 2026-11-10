/**
 * Breakable pieces of the arena (a.breakable) and their rubble. A piece takes blows in joules: a
 * body, a loose thing or a doctor knocked flat striking it brings its ½mv²; a blast brings what it
 * would throw a doctor there with, ½ · 80 kg · (its speed there)². A blow under a twentieth of the
 * piece's strength leaves no mark; the rest add up, and at its strength the piece breaks: its
 * colliders go, the pages fold it out of the drawing, and it falls apart into rubble (bodies that
 * tumble, pass through doctors and are gone after a few seconds), what was placed on it flying off
 * whole. A breakable piece standing on it falls whole, as rubble of one lump a solid. A doctor
 * walking into a piece never breaks it: standing doctors do not strike as bodies do.
 */

import RAPIER, { type Collider, type RigidBody } from '@dimforge/rapier3d-compat'

import type { ArenaDecor, ArenaSolid, MaterialName, Prim, Vec3 } from '../protocol'
import { DOCTOR_MASS, qrot, type Q } from './forces'
import { G, MAX_BODIES, add, eulerQuat, groups, len, norm, scale, sub, type Body, type Owner, type Sim } from './sim'

export interface Piece {
  id: string
  /** Joules of blows it takes to break, and what it has taken. */
  strength: number
  damage: number
  broken: boolean
  colliders: Collider[]
  solids: ArenaSolid[]
  decor: ArenaDecor[]
  /** The box round it, its middle, its reach from there (metres), and what it is mostly made of, in what colour. */
  min: Vec3
  max: Vec3
  at: Vec3
  size: number
  material: MaterialName
  color: string
  /** When each striker last counted, so the parts of one ragdoll (or one bounce) count once. */
  struck: Map<string, number>
}

/** Joules a piece of a cubic metre takes to break, by what it is made of; a bigger one takes more, as its cross-section grows. */
const TOUGH: Record<MaterialName, number> = {
  glass: 150, paper: 300, water: 300, books: 500, fabric: 500, carpet: 500, plain: 800, planks: 800, wood: 900, plaster: 900, chalkboard: 900,
  tiles: 1200, earth: 1200, grass: 1200, brick: 2500, concrete: 3000, stone: 3000, marble: 3000, lava: 3000, rock: 3500, brass: 6000, metal: 8000,
}
/** A blow under this share of a piece's strength leaves no mark. */
const MARK = 0.05
/** Seconds before the same striker counts again on the same piece. */
const RESTRIKE = 0.3
/** The owner of rubble bodies. */
export const RUBBLE = 'rubble'
const RUBBLE_LIFE = 6
/** Rubble in the arena at once (the oldest goes first), and lumps one piece falls into. */
const MAX_RUBBLE = 120
const RUBBLE_PER_PIECE = 24
/** At most how big a lump is, metres (a solid is cut in up to four along each side, at least in two along its longest). */
const LUMP = 0.6
/** A lump is this much of the cell it was cut as, so lumps start apart, and apart from whatever the piece stood flush against: nothing jams. */
const GAP = 0.88
/** Rubble weighs as wood does, whatever it was, and no lump more than RUBBLE_MASS kg: heavy enough to tumble and knock, too light to wreck all round it. */
const RUBBLE_DENSITY = 600
const RUBBLE_MASS = 400
/** A placed model bigger than this (metres) goes in the dust rather than flying off whole. */
const WHOLE = 3
const DUST = '#b8ab94'

const r3 = (v: number) => Math.round(v * 1000) / 1000
const rv = (v: Vec3): Vec3 => [r3(v[0]), r3(v[1]), r3(v[2])]
const v3 = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z]

/** A solid's extent as a box [x, y, z] round its middle, and its volume. */
function extent(s: ArenaSolid): { box: Vec3; volume: number } {
  const [x, y, z] = s.size
  switch (s.kind) {
    case 'box':
      return { box: [x, y, z], volume: x * y * z }
    case 'ramp':
      return { box: [x, y, z], volume: (x * y * z) / 2 }
    case 'cylinder':
      return { box: [2 * x, y, 2 * x], volume: Math.PI * x * x * y }
    case 'sphere':
      return { box: [2 * x, 2 * x, 2 * x], volume: (4 / 3) * Math.PI * x ** 3 }
  }
}

/** A placed model's box: its middle from the model's origin (in the model's frame, scaled), its middle in the arena, and its size. */
function placedBox(sim: Sim, d: ArenaDecor): { mid: Vec3; at: Vec3; size: Vec3 } {
  const b = sim.models.get(d.model)!.bounds
  const mid = [0, 1, 2].map((i) => ((b.max[i]! + b.min[i]!) / 2) * d.scale) as Vec3
  const size = [0, 1, 2].map((i) => Math.max(0.05, (b.max[i]! - b.min[i]!) * d.scale)) as Vec3
  return { mid, at: add(d.at, qrot(eulerQuat(d.rot), mid)), size }
}

/** Settles a piece once built: the box round it, what it is mostly made of (its biggest solid), and its strength (given, else by that material and its size). */
export function finishPiece(sim: Sim, p: Piece, strength: number | null): void {
  let volume = 0
  let main: { volume: number; s: ArenaSolid } | null = null
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  /** A turned box: how far it reaches along each axis of the world is its half sizes turned. */
  const take = (at: Vec3, rot: Vec3, size: Vec3) => {
    const q = eulerQuat(rot)
    const reach: Vec3 = [0, 0, 0]
    for (const axis of [
      [size[0] / 2, 0, 0],
      [0, size[1] / 2, 0],
      [0, 0, size[2] / 2],
    ] as Vec3[]) {
      const v = qrot(q, axis)
      for (let i = 0; i < 3; i++) reach[i]! += Math.abs(v[i]!)
    }
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, at[i]! - reach[i]!)
      max[i] = Math.max(max[i]!, at[i]! + reach[i]!)
    }
  }
  for (const s of p.solids) {
    const e = extent(s)
    volume += e.volume
    if (!main || e.volume > main.volume) main = { volume: e.volume, s }
    take(s.at, s.rot, e.box)
  }
  for (const d of p.decor) {
    const b = placedBox(sim, d)
    // Only models: their boxes, a third of which they fill, say.
    if (!p.solids.length) volume += (b.size[0] * b.size[1] * b.size[2]) / 3
    take(b.at, d.rot, b.size)
  }
  p.min = min
  p.max = max
  p.at = scale(add(min, max), 0.5)
  p.size = len(sub(max, min)) / 2
  p.material = main?.s.material ?? p.decor[0]!.material
  p.color = main?.s.color ?? DUST
  p.strength = strength ?? TOUGH[p.material] * Math.min(60, Math.max(0.05, volume)) ** (2 / 3)
}

/** Something striking a breakable piece, with the energy it came in with: a body, a loose thing, or a doctor knocked flat. */
export function strike(sim: Sim, o: Owner | undefined, by: Owner | undefined): void {
  if (o?.kind !== 'arena' || o.piece === null || !by) return
  const p = sim.arena!.pieces.get(o.piece)!
  if (p.broken) return
  let mass: number
  let speed: number
  let at: Vec3
  if (by.kind === 'body') {
    const b = sim.bodies.get(by.id)
    if (!b || !b.solid || b.stuck || !b.rb.isDynamic()) return
    mass = b.rb.mass()
    speed = Math.max(len(b.vel), len(b.velBefore))
    at = v3(b.rb.translation())
  } else if (by.kind === 'thing') {
    const t = sim.things.get(by.id)
    if (!t?.body) return
    mass = t.body.mass()
    speed = Math.max(t.speed, t.speedBefore)
    at = v3(t.body.translation())
  } else if (by.kind === 'doctor') {
    const d = sim.doctors.get(by.id)
    if (!d?.rag) return
    mass = DOCTOR_MASS * d.size ** 3
    speed = Math.max(d.ragSpeed, d.ragSpeedBefore)
    at = d.rag.pelvis()
  } else return
  const who = `${by.kind}:${by.id}`
  if (sim.time - (p.struck.get(who) ?? -1) < RESTRIKE) return
  p.struck.set(who, sim.time)
  hitPiece(sim, p, 0.5 * mass * speed * speed, at, scale(norm(sub(p.at, at)), speed))
}

/**
 * A blast strikes every breakable piece within its radius that it reaches (nothing else of the
 * arena between), as hard as it would throw a doctor standing at the piece's nearest point.
 */
export function blastPieces(sim: Sim, at: Vec3, radius: number, speed: number): void {
  const centre = { x: at[0], y: at[1], z: at[2] }
  for (const p of sim.arena?.pieces.values() ?? []) {
    if (p.broken || len(sub(p.at, at)) > radius + p.size) continue
    // Its nearest point (a piece of models alone: its middle, less half its reach).
    let near = p.at
    let dist = p.colliders.length ? Infinity : Math.max(0, len(sub(p.at, at)) - p.size / 2)
    for (const c of p.colliders) {
      const proj = c.projectPoint(centre, true)!
      const d = proj.isInside ? 0 : len(sub(v3(proj.point), at))
      if (d < dist) {
        dist = d
        near = v3(proj.point)
      }
    }
    if (dist > radius) continue
    if (dist > 0.05 && p.colliders.length) {
      const dir = scale(sub(near, at), 1 / dist)
      const hit = sim.world.castRay(new RAPIER.Ray(centre, { x: dir[0], y: dir[1], z: dir[2] }), dist + 0.05, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(0xffff, G.ARENA))
      const o = hit ? sim.owners.get(hit.collider.handle) : undefined
      if (hit && !(o?.kind === 'arena' && o.piece === p.id)) continue
    }
    const v = Math.abs(speed) * (1 - dist / Math.max(0.01, radius))
    hitPiece(sim, p, 0.5 * DOCTOR_MASS * v * v, dist > 0.05 ? near : p.at, scale(norm(sub(p.at, at)), v * Math.sign(speed)))
  }
}

/** A blow to a piece, in joules, at a point, pushing along push (m/s): a mark, or once they add up to its strength, the break. */
function hitPiece(sim: Sim, p: Piece, joules: number, at: Vec3, push: Vec3): void {
  if (p.broken || !(joules >= p.strength * MARK)) return
  p.damage += joules
  if (p.damage >= p.strength) return breakPiece(sim, p, push, false)
  const hard = Math.min(1, joules / p.strength)
  sim.emit({ type: 'burst', at: rv(at), color: p.color, size: 0.25, count: 5 + Math.round(12 * hard), glow: false })
  sim.emit({ type: 'sound', at: rv(at), sound: 'crunch', pitch: p.material === 'glass' ? 1.6 : 0.9, volume: r3(0.35 + 0.65 * hard) })
}

/**
 * A piece breaks: struck along push (m/s), it falls apart; fell, it lost what held it up and
 * drops whole, each solid one lump (a ramp, which no lump is shaped like, still in pieces). Then
 * any breakable piece standing on it falls in turn.
 */
function breakPiece(sim: Sim, p: Piece, push: Vec3, fell: boolean): void {
  p.broken = true
  for (const c of p.colliders) {
    sim.owners.delete(c.handle)
    sim.world.removeCollider(c, true)
  }
  sim.arena!.view.broken.push(p.id)
  sim.emit({ type: 'break', piece: p.id, at: rv(p.at), material: p.material, color: p.color, size: r3(p.size), fell })
  if (p.size > 1.5 && !fell) sim.emit({ type: 'shake', at: rv(p.at), strength: r3(Math.min(0.6, p.size / 8)) })
  // What lay on it falls.
  const near = (rb: RigidBody) => len(sub(v3(rb.translation()), p.at)) < p.size + 1.5
  for (const b of sim.bodies.values()) if (b.rb.isDynamic() && near(b.rb)) b.rb.wakeUp()
  for (const t of sim.things.values()) if (t.body && near(t.body)) t.body.wakeUp()

  // It falls apart, out from its middle and on along the blow: each solid in lumps, cut
  // unevenly, as many as it has room for; each placed model whole.
  const thrown = (from: Vec3): Vec3 =>
    fell ? [0, 0, 0] : add(add(scale(norm(sub(from, p.at)), 1.5 + sim.random() * 2.5), len(push) > 1e-6 ? scale(norm(push), Math.min(10, len(push)) * 0.35) : [0, 0, 0]), [0, 1 + sim.random() * 1.5, 0])
  const each = Math.max(1, Math.floor(RUBBLE_PER_PIECE / Math.max(1, p.solids.length)))
  for (const s of p.solids) {
    const { box } = extent(s)
    if (fell && s.kind !== 'ramp') {
      const shape = s.kind === 'cylinder' ? 'cylinder' : s.kind === 'sphere' ? 'ball' : 'box'
      lump(sim, s.at, eulerQuat(s.rot), shape, box, [0, 0, 0], { model: null, prim: { shape, size: box, color: s.color, glow: false, material: s.material }, scale: 1 }, [0, 0, 0])
      continue
    }
    const n = box.map((v) => Math.max(1, Math.min(4, Math.ceil(v / LUMP))))
    const longest = box.indexOf(Math.max(...box))
    n[longest] = Math.max(2, n[longest]!)
    while (n[0]! * n[1]! * n[2]! > each) n[n.indexOf(Math.max(...n))]!--
    const cuts = n.map((k, i) => {
      const w = Array.from({ length: k }, () => 0.6 + sim.random() * 0.8)
      const sum = w.reduce((a, b) => a + b, 0)
      const edges = [-box[i]! / 2]
      for (const x of w) edges.push(edges.at(-1)! + (x / sum) * box[i]!)
      return edges
    })
    const q = eulerQuat(s.rot)
    for (let i = 0; i < n[0]!; i++)
      for (let j = 0; j < n[1]!; j++)
        for (let k = 0; k < n[2]!; k++) {
          const lo: Vec3 = [cuts[0]![i]!, cuts[1]![j]!, cuts[2]![k]!]
          const hi: Vec3 = [cuts[0]![i + 1]!, cuts[1]![j + 1]!, cuts[2]![k + 1]!]
          const c = scale(add(lo, hi), 0.5)
          // A round solid or a ramp keeps the lumps whose middles were inside it, smaller still.
          const inside =
            s.kind === 'box' ||
            (s.kind === 'cylinder' ? Math.hypot(c[0], c[2]) <= s.size[0] : s.kind === 'sphere' ? len(c) <= s.size[0] : c[1] <= -box[1] / 2 + box[1] * (c[2] / box[2] + 0.5))
          if (!inside) continue
          const size = scale(sub(hi, lo), s.kind === 'box' ? GAP : GAP * 0.85)
          const pos = add(s.at, qrot(q, c))
          lump(sim, pos, q, 'box', size, [0, 0, 0], { model: null, prim: { shape: 'box', size, color: s.color, glow: false, material: s.material }, scale: 1 }, thrown(pos))
        }
  }
  for (const d of p.decor) {
    const b = placedBox(sim, d)
    if (Math.max(...b.size) > WHOLE) continue
    lump(sim, d.at, eulerQuat(d.rot), 'box', b.size, b.mid, { model: d.model, prim: null, scale: d.scale }, thrown(b.at))
  }
  // A breakable piece standing on its top, over it, has lost what held it up.
  for (const o of sim.arena!.pieces.values()) {
    if (o.broken || Math.abs(o.min[1] - p.max[1]) > 0.15) continue
    if (o.min[0] >= p.max[0] || o.max[0] <= p.min[0] || o.min[2] >= p.max[2] || o.max[2] <= p.min[2]) continue
    breakPiece(sim, o, [0, 0, 0], true)
  }
}

/**
 * One lump of rubble: a box of a solid, a whole solid of the shape given (size as a body's: a
 * ball's and a cylinder's x their width), or a placed model whole, its collider a box round it
 * (mid from its origin). Still at the start (vel zero), it hardly turns either.
 */
function lump(sim: Sim, at: Vec3, q: Q, shape: 'box' | 'ball' | 'cylinder', size: Vec3, mid: Vec3, look: { model: string | null; prim: Prim | null; scale: number }, vel: Vec3): void {
  const rubble = [...sim.bodies.values()].filter((b) => b.owner === RUBBLE)
  if (rubble.length >= MAX_RUBBLE) sim.removeBody(rubble[0]!)
  if (sim.bodies.size >= MAX_BODIES) return
  const still = len(vel) < 1e-6
  const spin = () => (sim.random() - 0.5) * (still ? 1 : 10)
  const rb = sim.world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(at[0], at[1], at[2])
      .setRotation(q)
      .setLinvel(vel[0], vel[1], vel[2])
      .setAngvel({ x: spin(), y: spin(), z: spin() })
      .setCcdEnabled(true),
  )
  const desc = shape === 'ball' ? RAPIER.ColliderDesc.ball(size[0] / 2) : shape === 'cylinder' ? RAPIER.ColliderDesc.cylinder(size[1] / 2, size[0] / 2) : RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2)
  const collider = sim.world.createCollider(
    desc
      .setTranslation(mid[0], mid[1], mid[2])
      .setMass(Math.max(0.05, Math.min(RUBBLE_MASS, RUBBLE_DENSITY * size[0] * size[1] * size[2])))
      .setFriction(0.8)
      .setRestitution(0.15)
      // It tumbles over the arena, other bodies, things and crates, and through doctors.
      .setCollisionGroups(groups(G.BODY, G.ARENA | G.BODY | G.THING | G.CRATE))
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
    rb,
  )
  const b: Body = {
    id: sim.nextId('b'),
    rb,
    collider,
    source: { attacker: null, thing: null, what: 'the arena' },
    owner: RUBBLE,
    model: look.model,
    prim: look.prim,
    scale: look.scale,
    born: sim.time,
    until: sim.time + RUBBLE_LIFE + sim.random() * 2,
    hit: null,
    tick: null,
    handle: null,
    spares: null,
    gone: null,
    vel,
    velBefore: vel,
    shape,
    size,
    mid,
    k: 1,
    poses: {},
    face: false,
    trail: null,
    solid: true,
    fixed: false,
    stuck: null,
  }
  sim.own(collider, { kind: 'body', id: b.id })
  sim.bodies.set(b.id, b)
}

/** Rubble shrinks away over its last half second. */
export function stepRubble(sim: Sim): void {
  for (const b of sim.bodies.values()) {
    if (b.owner !== RUBBLE) continue
    const left = b.until - sim.time
    if (left >= 0.5) continue
    b.k = Math.max(0.05, left / 0.5)
    sim.shapeBody(b)
  }
}
