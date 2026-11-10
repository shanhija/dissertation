/**
 * Arenas: the builder `a` that arena code gets, the hall the game has of its own (played when
 * no arena from Opus is ready, and in the tests), and the checks a new arena passes before it is
 * played. An arena's code runs once to build (solids, movers, breakable pieces, zones, spawn
 * points, decorations, the sky) and its movers, zones and `every` hooks run each step after.
 *
 * CONTRACT: the arena designer's prompt (server/apidoc.ts) describes exactly this builder.
 */

import RAPIER from '@dimforge/rapier3d-compat'

import { MATERIALS, type ArenaDecor, type ArenaLight, type ArenaPortrait, type ArenaSolid, type MaterialName, type Sky, type Vec3 } from '../protocol'
import { arenaWorld, colorOr, recipeOf, thingApi } from './api'
import { finishPiece, type Piece } from './breaking'
import { call } from './sandbox'
import { recipeTriangles } from './shapes'
import { DT, G, Sim, eulerQuat, finiteVec, groups, type Mover } from './sim'

export interface ArenaSource {
  id: string
  name: string
  /** `function (a, w)`: made code, or the game's own. */
  build: unknown
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const numOr = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def)
const MAX_SOLIDS = 1200
const MAX_DECOR = 400
const MAX_SPAWNS = 16
const MAX_MOVERS = 40
const MAX_PIECES = 60
const MAX_EVERY = 8
const MAX_LIGHTS = 12
const MAX_PORTRAITS = 12
/** Triangles all the shaped solid pieces of an arena may have together, for their colliders. */
const MAX_SHAPED_TRIANGLES = 120_000

const materialOf = (m: unknown): MaterialName => (MATERIALS.includes(m as MaterialName) ? (m as MaterialName) : 'plain')
export const ARENA_REACH = 90

const DEFAULT_SKY: Sky = { color: '#2a2438', fog: 0.25, light: '#fff1d6', ground: '#3a3046' }

/** The points of a ramp: a wedge w wide, rising to h over its depth d toward +z, centred on its box. */
export function rampPoints(w: number, h: number, d: number): number[] {
  const x = w / 2
  const y = h / 2
  const z = d / 2
  return [-x, -y, -z, x, -y, -z, -x, -y, z, x, -y, z, -x, y, z, x, y, z]
}

/** Builds an arena into a sim's world; throws when its code fails or it has no spawn point. */
export function buildArena(sim: Sim, src: ArenaSource): void {
  if (sim.arena) throw new Error('the sim has an arena already')
  const fixed = sim.world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  const solids: ArenaSolid[] = []
  const decor: ArenaDecor[] = []
  const lights: ArenaLight[] = []
  const portraits: ArenaPortrait[] = []
  let shapedTriangles = 0
  const spawns: { p: Vec3; yaw: number }[] = []
  const movers = new Map<string, Mover>()
  const pieces = new Map<string, Piece>()
  const every: unknown[] = []
  const sky: Sky = { ...DEFAULT_SKY }
  let current: Mover | null = null
  /** The breakable piece being built, if one is. */
  let piece: Piece | null = null
  let lowest = Infinity
  const w = arenaWorld(sim, src.id)
  sim.arena = { view: { id: src.id, name: src.name, sky, solids, decor, lights, portraits, movers: [], broken: [] }, spawns, movers, pieces, every, floor: -30, w, errors: 0 }
  const outside = (what: string) => {
    if (piece) throw new Error(`${what} cannot be built inside a.breakable: build it outside`)
  }

  const solid = (kind: ArenaSolid['kind'], size: Vec3, opts: unknown) => {
    if (solids.length >= MAX_SOLIDS) return null
    const o = (opts !== null && typeof opts === 'object' ? opts : {}) as Record<string, unknown>
    const at = finiteVec(o.at) ?? [0, 0, 0]
    const rot = finiteVec(o.rot) ?? [0, 0, 0]
    const [x, y, z] = size
    const desc =
      kind === 'box'
        ? RAPIER.ColliderDesc.cuboid(x / 2, y / 2, z / 2)
        : kind === 'ramp'
          ? RAPIER.ColliderDesc.convexHull(new Float32Array(rampPoints(x, y, z)))!
          : kind === 'cylinder'
            ? RAPIER.ColliderDesc.cylinder(y / 2, x)
            : RAPIER.ColliderDesc.ball(x)
    desc
      .setTranslation(at[0], at[1], at[2])
      .setRotation(eulerQuat(rot))
      .setFriction(clamp(numOr(o.friction, 0.9), 0, 3))
      .setRestitution(clamp(numOr(o.bounce, 0), 0, 1.5))
      .setCollisionGroups(groups(G.ARENA, 0xffff))
    // A breakable piece hears what strikes it.
    if (piece) desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
    const collider = sim.world.createCollider(desc, current?.rb ?? fixed)
    sim.own(collider, { kind: 'arena', mover: current?.id ?? null, material: materialOf(o.material), piece: piece?.id ?? null })
    const id = `s${solids.length}`
    const made: ArenaSolid = { id, kind, size, at, rot, color: colorOr(o.color, '#8a8174'), material: materialOf(o.material), mover: current?.id ?? null, piece: piece?.id ?? null }
    solids.push(made)
    if (piece) {
      piece.colliders.push(collider)
      piece.solids.push(made)
    }
    if (!current) lowest = Math.min(lowest, at[1] - (rot.some((v) => v !== 0) ? Math.max(x, y, z) / 2 : kind === 'sphere' ? x : y / 2))
    return Object.freeze({ id })
  }
  const dims = (v: unknown, def: Vec3): Vec3 => (finiteVec(v)?.map((n) => clamp(Math.abs(n), 0.05, 240)) as Vec3 | undefined) ?? def

  /** A model placed in the arena; a solid one gets a collider exactly its shape. */
  const placed = (build: unknown, opts: unknown, isSolid: boolean) => {
    if (decor.length >= MAX_DECOR) return
    const o = (opts !== null && typeof opts === 'object' ? opts : {}) as Record<string, unknown>
    const model = `arena:${src.id}:decor${decor.length}`
    let recipe
    try {
      recipe = recipeOf(build).recipe
    } catch (err) {
      // An empty decoration (Opus writes `a.decor(function (m) {})` now and then) is nothing to draw, not a fault.
      if (/no shapes/.test((err as Error).message)) return
      throw new Error(`a.${isSolid ? 'solid' : 'decor'} number ${decor.length + 1}: ${(err as Error).message}`)
    }
    const at = finiteVec(o.at) ?? [0, 0, 0]
    const rot = finiteVec(o.rot) ?? [0, 0, 0]
    const k = clamp(numOr(o.scale, 1), 0.05, 20)
    if (isSolid) {
      const tris = recipeTriangles(recipe, k)
      shapedTriangles += tris.length / 9
      if (shapedTriangles > MAX_SHAPED_TRIANGLES) throw new Error(`the solid pieces have more than ${MAX_SHAPED_TRIANGLES} triangles in all: make solid pieces simpler and leave the fine shapes to a.decor`)
      const desc = RAPIER.ColliderDesc.trimesh(tris, Uint32Array.from({ length: tris.length / 3 }, (_, i) => i))
        .setTranslation(at[0], at[1], at[2])
        .setRotation(eulerQuat(rot))
        .setFriction(0.9)
        .setCollisionGroups(groups(G.ARENA, 0xffff))
      if (piece) desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
      const collider = sim.world.createCollider(desc, current?.rb ?? fixed)
      sim.own(collider, { kind: 'arena', mover: current?.id ?? null, material: materialOf(o.material), piece: piece?.id ?? null })
      piece?.colliders.push(collider)
      if (!current) lowest = Math.min(lowest, at[1] + recipe.bounds.min[1] * k)
    }
    sim.addModel(model, recipe)
    const made: ArenaDecor = { model, at, rot, scale: k, material: materialOf(o.material), solid: isSolid, mover: current?.id ?? null, piece: piece?.id ?? null }
    decor.push(made)
    piece?.decor.push(made)
  }

  const a = Object.freeze({
    box: (size: unknown, opts: unknown) => solid('box', dims(size, [1, 1, 1]), opts),
    ramp: (size: unknown, opts: unknown) => solid('ramp', dims(size, [2, 1, 3]), opts),
    cylinder: (r: unknown, h: unknown, opts: unknown) => {
      const rr = clamp(Math.abs(numOr(r, 0.5)), 0.05, 120)
      return solid('cylinder', [rr, clamp(Math.abs(numOr(h, 1)), 0.05, 240), rr], opts)
    },
    sphere: (r: unknown, opts: unknown) => {
      const rr = clamp(Math.abs(numOr(r, 0.5)), 0.05, 120)
      return solid('sphere', [rr, rr, rr], opts)
    },
    mover: (build: unknown, move: unknown) => {
      if (current) throw new Error('a mover cannot be built inside another mover')
      outside('a mover')
      if (movers.size >= MAX_MOVERS) return null
      const id = `m${movers.size}`
      const first = call<{ at?: unknown; rot?: unknown } | undefined>(move, null, 0)
      const at = (first.ok ? finiteVec(first.value?.at) : null) ?? [0, 0, 0]
      const rot = (first.ok ? finiteVec(first.value?.rot) : null) ?? [0, 0, 0]
      const rb = sim.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(at[0], at[1], at[2]).setRotation(eulerQuat(rot)))
      const m: Mover = { id, rb, move, at, rot, lastAt: at, lastRot: rot }
      movers.set(id, m)
      sim.arena!.view.movers.push(id)
      current = m
      try {
        const r = call(build, null)
        if (!r.ok) throw new Error(`mover ${id}: ${r.error}`)
      } finally {
        current = null
      }
      return Object.freeze({
        id,
        pos: (): Vec3 => {
          const t = m.rb.translation()
          return [t.x, t.y, t.z]
        },
      })
    },
    breakable: (build: unknown, opts: unknown) => {
      if (current) throw new Error('a breakable piece cannot be built inside a mover')
      outside('a breakable piece')
      if (pieces.size >= MAX_PIECES) return null
      const o = (opts !== null && typeof opts === 'object' ? opts : {}) as Record<string, unknown>
      const p: Piece = { id: `k${pieces.size}`, strength: 0, damage: 0, broken: false, colliders: [], solids: [], decor: [], min: [0, 0, 0], max: [0, 0, 0], at: [0, 0, 0], size: 0, material: 'plain', color: '#8a8174', struck: new Map() }
      piece = p
      try {
        const r = call(build, null)
        if (!r.ok) throw new Error(`breakable piece ${p.id}: ${r.error}`)
      } finally {
        piece = null
      }
      // Nothing built in it: nothing to break.
      if (!p.solids.length && !p.decor.length) return null
      pieces.set(p.id, p)
      finishPiece(sim, p, typeof o.strength === 'number' && Number.isFinite(o.strength) ? clamp(o.strength, 10, 200_000) : null)
      return Object.freeze({ id: p.id, broken: () => p.broken })
    },
    zone: (spec: unknown, handlers: unknown) => (w as { zone: (s: unknown, h: unknown) => unknown }).zone(spec, handlers),
    every: (fn: unknown) => {
      if (typeof fn === 'function' && every.length < MAX_EVERY) every.push(fn)
    },
    spawn: (at: unknown) => {
      const p = finiteVec(at)
      if (p && spawns.length < MAX_SPAWNS) spawns.push({ p, yaw: 0 })
    },
    decor: (build: unknown, opts: unknown) => placed(build, opts, false),
    solid: (build: unknown, opts: unknown) => placed(build, opts, true),
    light: (opts: unknown) => {
      outside('a lamp')
      if (lights.length >= MAX_LIGHTS) return
      const o = (opts !== null && typeof opts === 'object' ? opts : {}) as Record<string, unknown>
      const at = finiteVec(o.at)
      if (!at) return
      lights.push({ at, color: colorOr(o.color, '#ffe2b0'), power: clamp(numOr(o.power, 0.6), 0, 1), range: clamp(numOr(o.range, 12), 1, 40), mover: current?.id ?? null })
    },
    portrait: (opts: unknown) => {
      outside('a portrait')
      if (portraits.length >= MAX_PORTRAITS) return
      const o = (opts !== null && typeof opts === 'object' ? opts : {}) as Record<string, unknown>
      const at = finiteVec(o.at)
      if (!at) return
      // Unless told, the next doctor along: the leader first.
      const rank = Math.round(clamp(numOr(o.rank, portraits.length), 0, 7))
      portraits.push({ at, rot: finiteVec(o.rot) ?? [0, 0, 0], size: clamp(numOr(o.size, 1.2), 0.3, 6), rank, mover: current?.id ?? null })
    },
    sky: (opts: unknown) => {
      const o = (opts !== null && typeof opts === 'object' ? opts : {}) as Record<string, unknown>
      sky.color = colorOr(o.color, sky.color)
      sky.light = colorOr(o.light, sky.light)
      sky.ground = colorOr(o.ground, sky.ground)
      sky.fog = clamp(numOr(o.fog, sky.fog), 0, 1)
    },
  })

  const r = call(src.build, null, a, w)
  if (!r.ok) {
    sim.arena = null
    throw new Error(`the arena would not build: ${r.error}`)
  }
  if (spawns.length === 0) {
    sim.arena = null
    throw new Error('the arena has no spawn point (a.spawn)')
  }
  sim.arena.floor = Math.min(lowest, ...spawns.map((s) => s.p[1])) - 14
  // Every doctor starts facing the middle of the spawn points (yaw 0 looks along +z).
  const mx = spawns.reduce((sum, s) => sum + s.p[0], 0) / spawns.length
  const mz = spawns.reduce((sum, s) => sum + s.p[2], 0) / spawns.length
  for (const s of spawns) s.yaw = Math.hypot(mx - s.p[0], mz - s.p[2]) > 0.5 ? Math.atan2(mx - s.p[0], mz - s.p[2]) : 0
}

/**
 * Builds an arena in a sim of its own, stands a doctor on each spawn point and runs it for four
 * seconds. The problems found, each a line for the designer; none means it may be played.
 */
export function checkArena(src: ArenaSource): string[] {
  const sim = new Sim()
  sim.apiFor = thingApi
  const problems: string[] = []
  try {
    buildArena(sim, src)
  } catch (err) {
    sim.free()
    return [(err as Error).message]
  }
  const arena = sim.arena!
  // Scene queries see the colliders only after a step.
  sim.step()
  if (arena.spawns.length < 2) problems.push(`only ${arena.spawns.length} spawn point; give at least 8`)
  for (const [i, s] of arena.spawns.entries()) {
    if (Math.hypot(s.p[0], s.p[2]) > ARENA_REACH) problems.push(`spawn ${i} at ${s.p.join(', ')} is more than ${ARENA_REACH} m from the middle`)
    const ground = sim.groundBelow([s.p[0], s.p[1] + 0.6, s.p[2]], 3)
    if (!ground) problems.push(`spawn ${i} at ${s.p.join(', ')} has no floor under it within 2 m`)
    else if (ground.piece) problems.push(`spawn ${i} at ${s.p.join(', ')} stands on a breakable piece: a spawn point's floor must not break`)
  }
  sim.live = true
  const doctors = arena.spawns.slice(0, 8).map((_, i) => sim.addDoctor(`check${i}`, `check${i}`, true))
  const t0 = performance.now()
  for (let i = 0; i < 4 / DT; i++) {
    sim.step()
    if (i === Math.round(2 / DT)) {
      for (const d of doctors) if (d.cred < 100) problems.push(`a doctor standing at a spawn point (${d.pos.map((v) => v.toFixed(1)).join(', ')}) lost credibility within 2 s`)
    }
  }
  const ms = (performance.now() - t0) / (4 / DT)
  for (const d of doctors) if (d.pos[1] < arena.floor + 1) problems.push(`a doctor fell out from a spawn point`)
  // Every doctor can walk away from where it starts: toward the middle, else to a side.
  const start = doctors.map((d) => [...d.pos])
  const walk = (turn: number) => {
    for (const [i, d] of doctors.entries()) d.input = { ...d.input, move: [0, 1], yaw: arena.spawns[i]!.yaw + turn }
    for (let i = 0; i < 1.5 / DT; i++) sim.step()
  }
  walk(0)
  const stuck = () => doctors.filter((d, i) => Math.hypot(d.pos[0] - start[i]![0]!, d.pos[2] - start[i]![2]!) < 1)
  if (stuck().length) {
    for (const d of doctors) d.input = { ...d.input, move: [0, 0] }
    walk(Math.PI / 2)
    for (const d of stuck()) {
      const i = doctors.indexOf(d)
      problems.push(`the doctor at spawn ${i} (${arena.spawns[i]!.p.map((v) => v.toFixed(1)).join(', ')}) cannot walk away from it: something closes it in`)
    }
  }
  if (ms > 6) problems.push(`one step takes ${ms.toFixed(1)} ms; it must take under 6 (fewer solids, less code in every and move)`)
  for (const e of sim.errors) problems.push(`${e.owner}: ${e.error}`)
  sim.free()
  return [...new Set(problems)].slice(0, 12)
}
