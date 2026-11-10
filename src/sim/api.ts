/**
 * The objects made code gets: `w`, the world (for a thing's code and the arena's alike), `me`,
 * the thing itself, and the handle of every body spawned. Everything a made thing does to the
 * round goes through here and on to the Sim, whose rules (the caps, the limits) hold whatever
 * the code asks. Whatever made code passes in is checked: numbers that are not numbers are
 * dropped, sizes and speeds are clamped, and an unknown target does nothing.
 *
 * CONTRACT: the designer's prompt (server/apidoc.ts) describes exactly these objects.
 */

import RAPIER, { type Collider } from '@dimforge/rapier3d-compat'

import { buildRecipe } from '../model/kit'
import { SOUNDS, type Prim, type Quat, type SoundName, type Vec3 } from '../protocol'
import { blast, endPos, lookQuat, placeOf, stick, unstick, type Field, type Follow, type Tie, type TieRef } from './forces'
import { call } from './sandbox'
import {
  G,
  MAX_BODIES,
  eulerQuat,
  MAX_BODIES_PER_SOURCE,
  MAX_FIELDS_PER_SOURCE,
  MAX_SIGHTS,
  MAX_SIGHTS_PER_SOURCE,
  MAX_TIES_PER_SOURCE,
  MAX_ZONES_PER_SOURCE,
  aimOf,
  add,
  finiteVec,
  groups,
  len,
  norm,
  quatOf,
  scale,
  sub,
  type Body,
  type Doctor,
  type DoctorView,
  type Effect,
  type Sight,
  type Sim,
  type Source,
  type Thing,
  type Zone,
} from './sim'

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const numOr = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def)
const r3 = (v: number) => Math.round(v * 1000) / 1000
const rq = (q: { x: number; y: number; z: number; w: number }): Quat => [r3(q.x), r3(q.y), r3(q.z), r3(q.w)]
/** A size made code gave: one number for all three, or [x, y, z]. */
const sizeOr = (v: unknown, lo: number, hi: number): Vec3 | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return [v, v, v].map((x) => clamp(Math.abs(x), lo, hi)) as Vec3
  const f = finiteVec(v)
  return f ? (f.map((x) => clamp(Math.abs(x), lo, hi)) as Vec3) : null
}
/** A turn made code gave: rot (radians), or face and up directions; null when none. */
const turnOf = (o: Record<string, unknown>): { x: number; y: number; z: number; w: number } | null => {
  const look = lookQuat(finiteVec(o.face), finiteVec(o.up))
  if (look) return look
  const rot = finiteVec(o.rot)
  return rot ? eulerQuat(rot) : null
}

/** A colour made code gave, as '#rrggbb', or the default. */
export function colorOr(c: unknown, def: string): string {
  if (typeof c !== 'string') return def
  const s = c.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(s)) return s
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`
  return NAMED[s] ?? def
}

const NAMED: Record<string, string> = {
  red: '#d9412b', orange: '#ee8a2a', yellow: '#f2cf3a', green: '#4fa548', blue: '#3c6fd8', purple: '#8a4fc8', pink: '#f08cc0', white: '#f4f1ea',
  black: '#26252b', gray: '#8a8f98', grey: '#8a8f98', brown: '#7a5232', gold: '#e2b33c', silver: '#c4c9d1', cyan: '#3ac8d6', teal: '#2a9488',
  lime: '#9ad62f', magenta: '#d93cb0', navy: '#25336e', maroon: '#6e2430', beige: '#e3d6b8', cream: '#f6edd5', tan: '#cfa77a', olive: '#7a8030',
}

export interface MadeWorld {
  readonly time: number
}

/**
 * The world as made code sees it. `owner` names who spawns (a thing's id or 'arena'), `source`
 * says who is to blame for harm, `holder` is the doctor whose hand the thing is in (null for the
 * arena and for a thing lying loose).
 */
export function worldApi(sim: Sim, owner: string, source: () => Source, holder: () => Doctor | null, modelFor: (name: string) => string | null, defineModel: (name: string, build: unknown) => string | null) {
  const doctorOf = (target: unknown): Doctor | null => {
    const id = typeof target === 'string' ? target : target !== null && typeof target === 'object' && typeof (target as { id?: unknown }).id === 'string' ? (target as { id: string }).id : null
    return id === null ? null : (sim.doctors.get(id) ?? null)
  }
  const bodyOf = (target: unknown): Body | null => {
    const id = target !== null && typeof target === 'object' && typeof (target as { id?: unknown }).id === 'string' ? (target as { id: string }).id : null
    return id === null ? null : (sim.bodies.get(id) ?? null)
  }
  const handles = new WeakMap<Body, unknown>()

  const handleOf = (b: Body): unknown => {
    const known = handles.get(b)
    if (known) return known
    const h = Object.freeze({
      id: b.id,
      age: () => r3(sim.time - b.born),
      pos: (): Vec3 => {
        if (!sim.bodies.has(b.id)) return b.gone!.map(r3) as Vec3
        const t = b.rb.translation()
        return [r3(t.x), r3(t.y), r3(t.z)]
      },
      vel: (): Vec3 => {
        if (!sim.bodies.has(b.id)) return [0, 0, 0]
        const v = b.rb.linvel()
        return [r3(v.x), r3(v.y), r3(v.z)]
      },
      alive: () => sim.bodies.has(b.id),
      setVel: (v: unknown) => {
        const f = finiteVec(v)
        if (f && sim.bodies.has(b.id)) b.rb.setLinvel(xyz(capSpeed(f, 80)), true)
      },
      push: (v: unknown) => {
        const f = finiteVec(v)
        if (!f || !sim.bodies.has(b.id)) return
        const cur = b.rb.linvel()
        b.rb.setLinvel(xyz(capSpeed([cur.x + f[0], cur.y + f[1], cur.z + f[2]], 80)), true)
      },
      setPos: (p: unknown) => {
        const f = finiteVec(p)
        if (f && sim.bodies.has(b.id)) b.rb.setTranslation({ x: f[0], y: f[1], z: f[2] }, true)
      },
      resize: (k: unknown) => {
        if (!sim.bodies.has(b.id)) return
        b.k = clamp(numOr(k, 1), 0.1, 10)
        sim.shapeBody(b)
      },
      pose: (part: unknown, rot: unknown) => {
        const r = finiteVec(rot)
        if (typeof part === 'string' && r && (part in b.poses || Object.keys(b.poses).length < 24)) b.poses[part.slice(0, 40)] = r.map(r3) as Vec3
      },
      stick: (target: unknown) => {
        if (!sim.bodies.has(b.id)) return
        const t = target !== null && typeof target === 'object' ? (target as Record<string, unknown>) : null
        // What a hit gets ({ doctor, body, arena }), or a doctor or a body itself.
        const d = doctorOf(t?.doctor ?? target)
        const o = bodyOf(t?.body ?? target)
        unstick(b)
        stick(b, d ? { doctor: d } : o && o !== b ? { body: o } : null)
      },
      unstick: () => unstick(b),
      remove: () => sim.removeBody(b),
    })
    handles.set(b, h)
    return h
  }

  /** What made code means by a thing to follow or tie: a doctor, a body, this thing (me), or nothing. */
  const thingOf = (target: unknown): Thing | null => {
    const id = target !== null && typeof target === 'object' ? (target as { id?: unknown }).id : target
    return typeof id === 'string' ? (sim.things.get(id) ?? null) : null
  }
  const followOf = (target: unknown): Follow => {
    const d = doctorOf(target)
    if (d) return { kind: 'doctor', id: d.id }
    const b = bodyOf(target)
    if (b) return { kind: 'body', id: b.id }
    const t = thingOf(target)
    return t ? { kind: 'thing', thing: t } : null
  }
  const tieRefOf = (target: unknown): TieRef | null => {
    const p = finiteVec(target)
    if (p) return { kind: 'point', p }
    const d = doctorOf(target)
    if (d) return { kind: 'doctor', id: d.id }
    const b = bodyOf(target)
    if (b) return { kind: 'body', id: b.id }
    const t = thingOf(target)
    return t ? { kind: 'thing', id: t.id } : null
  }

  const sightHandles = new WeakMap<Sight, unknown>()
  const sightHandle = (s: Sight): unknown => {
    const known = sightHandles.get(s)
    if (known) return known
    const live = () => sim.sights.get(s.id) === s
    const h = Object.freeze({
      id: s.id,
      alive: live,
      age: () => r3(sim.time - s.born),
      pos: (): Vec3 => {
        const at = [0, 1, 2].map((i) => s.at[i]! + s.vel[i]! * (sim.time - s.tAt)) as Vec3
        return (placeOf(sim, at, s.follow) ?? at).map(r3) as Vec3
      },
      set: (spec: unknown) => {
        if (!live() || spec === null || typeof spec !== 'object') return
        const o = spec as Record<string, unknown>
        const patch: Parameters<Sim['reshow']>[1] = {}
        const at = finiteVec(o.at)
        if (at) {
          s.at = at
          s.tAt = sim.time
          patch.at = at.map(r3) as Vec3
        }
        const q = turnOf(o)
        if (q) patch.q = rq(q)
        const size = sizeOr(o.scale, 0.01, 60)
        if (size) patch.scale = size.map(r3) as Vec3
        if (typeof o.opacity === 'number' && Number.isFinite(o.opacity)) patch.opacity = r3(clamp(o.opacity, 0, 1))
        if (Object.keys(patch).length) sim.reshow(s.id, patch)
      },
      pose: (part: unknown, rot: unknown) => {
        const r = finiteVec(rot)
        if (!live() || typeof part !== 'string' || !r || (!(part in s.poses) && Object.keys(s.poses).length >= 24)) return
        s.poses[part.slice(0, 40)] = r.map(r3) as Vec3
        sim.reshow(s.id, { poses: { ...s.poses } })
      },
      remove: () => sim.removeSight(s),
    })
    sightHandles.set(s, h)
    return h
  }

  const holderCollider = (): Collider | null => holder()?.collider ?? null

  return Object.freeze({
    get time() {
      return r3(sim.time)
    },
    random: () => sim.random(),
    doctors: (): DoctorView[] => [...sim.doctors.values()].map((d) => sim.view(d)),
    others: (): DoctorView[] => {
      const me = holder()
      return [...sim.doctors.values()].filter((d) => d.alive && d !== me).map((d) => sim.view(d))
    },
    doctor: (id: unknown): DoctorView | null => {
      const d = doctorOf(id)
      return d ? sim.view(d) : null
    },
    ray: (from: unknown, dir: unknown, max: unknown) => {
      const f = finiteVec(from)
      const dv = finiteVec(dir)
      if (!f || !dv || len(dv) < 1e-9) return null
      const d = norm(dv)
      const exclude = holderCollider()
      const hit = sim.world.castRayAndGetNormal(
        new RAPIER.Ray({ x: f[0], y: f[1], z: f[2] }, { x: d[0], y: d[1], z: d[2] }),
        clamp(numOr(max, 100), 0.01, 200),
        true,
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        groups(0xffff, G.ARENA | G.DOCTOR | G.BODY | G.CRATE | G.THING),
        exclude ?? undefined,
        undefined,
        (c: Collider) => {
          const o = sim.owners.get(c.handle)
          return !(o?.kind === 'body' && sim.bodies.get(o.id)?.owner === owner) && !(o?.kind === 'thing' && o.id === owner)
        },
      )
      if (!hit) return null
      const o = sim.owners.get(hit.collider.handle)
      const point = add(f, scale(d, hit.timeOfImpact))
      const doc = o?.kind === 'doctor' ? sim.doctors.get(o.id) : undefined
      const body = o?.kind === 'body' ? sim.bodies.get(o.id) : undefined
      return {
        dist: r3(hit.timeOfImpact),
        point: point.map(r3) as Vec3,
        normal: [r3(hit.normal.x), r3(hit.normal.y), r3(hit.normal.z)] as Vec3,
        doctor: doc ? sim.view(doc) : null,
        body: body ? handleOf(body) : null,
        arena: o?.kind === 'arena',
      }
    },
    near: (at: unknown, radius: unknown) => {
      const c = finiteVec(at)
      const r = clamp(numOr(radius, 2), 0, 40)
      if (!c) return { doctors: [], bodies: [] }
      return {
        doctors: [...sim.doctors.values()].filter((d) => d.alive && len(sub(add(d.pos, [0, 0.9 * d.size, 0]), c)) <= r + 0.4).map((d) => sim.view(d)),
        bodies: [...sim.bodies.values()].filter((b) => {
          const t = b.rb.translation()
          return len(sub([t.x, t.y, t.z], c)) <= r
        }).map(handleOf),
      }
    },
    hurt: (target: unknown, amount: unknown, opts: unknown) => {
      const d = doctorOf(target)
      if (!d) return 0
      const o = (opts !== null && typeof opts === 'object' ? opts : {}) as { push?: unknown; from?: unknown }
      const from = finiteVec(o.from) ?? holder()?.pos ?? null
      const dealt = sim.harm(d, numOr(amount, 0), source())
      const pushV = finiteVec(o.push)
      if (pushV) sim.knock(d, pushV)
      else if (typeof o.push === 'number' && Number.isFinite(o.push) && from) {
        const away = norm([d.pos[0] - from[0], 0, d.pos[2] - from[2]])
        sim.knock(d, add(scale(away, clamp(o.push, -30, 30)), [0, Math.abs(clamp(o.push, -30, 30)) * 0.35, 0]))
      }
      return dealt
    },
    push: (target: unknown, v: unknown) => {
      const f = finiteVec(v)
      if (!f) return
      const d = doctorOf(target)
      if (d) return sim.knock(d, f)
      const b = bodyOf(target)
      if (b) {
        const cur = b.rb.linvel()
        b.rb.setLinvel(xyz(capSpeed([cur.x + f[0], cur.y + f[1], cur.z + f[2]], 80)), true)
      }
    },
    affect: (target: unknown, effect: unknown, secs: unknown) => {
      const d = doctorOf(target)
      if (!d || effect === null || typeof effect !== 'object') return
      const e = effect as Record<string, unknown>
      const fx: Partial<Omit<Effect, 'until'>> = {
        ...(e as Partial<Omit<Effect, 'until'>>),
        glow: e.glow === undefined || e.glow === null || e.glow === false ? null : colorOr(e.glow, '#9fd8ff'),
        wear: typeof e.wear === 'string' ? modelFor(e.wear) : null,
        tint: colorOr(e.tint, '#0c0a08'),
      }
      sim.affect(d, fx, numOr(secs, 3))
    },
    held: (target: unknown) => {
      const d = doctorOf(target)
      return d ? sim.held(d) : false
    },
    teleport: (target: unknown, at: unknown) => {
      const d = doctorOf(target)
      const p = finiteVec(at)
      if (d && p) sim.teleport(d, p)
    },
    curse: (target: unknown, text: unknown, uses: unknown) => {
      const d = doctorOf(target)
      if (d && typeof text === 'string') sim.curse(d, text, numOr(uses, 1))
    },
    model: (name: unknown, build: unknown): string | null => {
      if (typeof name !== 'string') return null
      return modelFor(name) !== null || defineModel(name, build) !== null ? name : null
    },
    spawn: (spec: unknown) => {
      if (spec === null || typeof spec !== 'object') return null
      const s = spec as Record<string, unknown>
      const at = finiteVec(s.at)
      if (!at) return null
      const model = typeof s.model === 'string' ? modelFor(s.model) : null
      const recipe = model ? sim.models.get(model)! : null
      const k = clamp(numOr(s.scale, 1), 0.05, 8)
      const shape: Prim['shape'] = s.shape === 'box' || s.shape === 'capsule' || s.shape === 'cylinder' || s.shape === 'ball' ? s.shape : recipe ? 'box' : 'ball'
      const sizeIn = typeof s.size === 'number' ? [s.size, s.size, s.size] : s.size
      let size = finiteVec(sizeIn)?.map((v) => clamp(Math.abs(v), 0.02, 8)) as Vec3 | undefined
      if (!size && recipe) size = [0, 1, 2].map((i) => clamp((recipe.bounds.max[i]! - recipe.bounds.min[i]!) * k, 0.02, 8)) as Vec3
      size ??= [0.2, 0.2, 0.2]
      const mine = [...sim.bodies.values()].filter((b) => b.owner === owner)
      while (mine.length >= MAX_BODIES_PER_SOURCE) sim.removeBody(mine.shift()!)
      if (sim.bodies.size >= MAX_BODIES) sim.removeBody(sim.bodies.values().next().value!)
      const vel = capSpeed(finiteVec(s.vel) ?? [0, 0, 0], 120)
      const fixed = s.fixed === true
      const face = s.face === true && !fixed
      const desc = (fixed ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic())
        .setTranslation(at[0], at[1], at[2])
        .setLinvel(vel[0], vel[1], vel[2])
        .setGravityScale(clamp(numOr(s.gravity, 1), -2, 4))
        .setCcdEnabled(true)
        .setLinearDamping(clamp(numOr(s.drag, 0), 0, 10))
      const rot = finiteVec(s.rot)
      const speed = len(vel)
      if (face && speed > 0.3) desc.setRotation(quatOf(Math.atan2(vel[0], vel[2]), Math.asin(clamp(vel[1] / speed, -1, 1))))
      else if (rot) desc.setRotation(eulerQuat(rot))
      // Turned by its flight, not by what it bumps into.
      if (face) desc.lockRotations()
      const spin = finiteVec(s.spin)
      if (spin && !face) desc.setAngvel({ x: clamp(spin[0], -50, 50), y: clamp(spin[1], -50, 50), z: clamp(spin[2], -50, 50) })
      const rb = sim.world.createRigidBody(desc)
      // A model's collider sits round the model as drawn, wherever its origin is.
      const mid: Vec3 = recipe ? ([0, 1, 2].map((i) => ((recipe.bounds.max[i]! + recipe.bounds.min[i]!) / 2) * k) as Vec3) : [0, 0, 0]
      const [x, y, z] = size
      const cdesc =
        shape === 'box'
          ? RAPIER.ColliderDesc.cuboid(x / 2, y / 2, z / 2)
          : shape === 'capsule'
            ? RAPIER.ColliderDesc.capsule(Math.max(0.01, y / 2 - x / 2), x / 2)
            : shape === 'cylinder'
              ? RAPIER.ColliderDesc.cylinder(y / 2, x / 2)
              : RAPIER.ColliderDesc.ball(x / 2)
      const mass = numOr(s.mass, NaN)
      const volume = shape === 'box' ? x * y * z : shape === 'ball' ? (Math.PI / 6) * x * x * x : (Math.PI / 4) * x * x * y
      if (Number.isFinite(mass)) cdesc.setDensity(clamp(mass, 0.01, 2000) / Math.max(volume, 1e-6))
      cdesc
        .setTranslation(mid[0], mid[1], mid[2])
        .setRestitution(clamp(numOr(s.bounce, 0.3), 0, 1.2))
        .setFriction(clamp(numOr(s.friction, 0.6), 0, 3))
        .setSensor(s.solid === false)
        .setCollisionGroups(groups(G.BODY, 0xffff))
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.DEFAULT | RAPIER.ActiveCollisionTypes.KINEMATIC_FIXED | RAPIER.ActiveCollisionTypes.KINEMATIC_KINEMATIC)
      const collider = sim.world.createCollider(cdesc, rb)
      const src = source()
      const b: Body = {
        id: sim.nextId('b'),
        rb,
        collider,
        source: src,
        owner,
        model: s.hidden === true ? null : model,
        prim: model || s.hidden === true ? null : { shape, size, color: colorOr(s.color, '#d8d2c4'), glow: s.glow === true, material: null },
        scale: model ? k : 1,
        born: sim.time,
        until: sim.time + clamp(numOr(s.life, 5), 0.05, 20),
        hit: s.hit,
        tick: s.tick,
        handle: null,
        spares: holder()?.id ?? null,
        gone: null,
        vel,
        velBefore: vel,
        shape,
        size,
        mid,
        k: 1,
        poses: {},
        face,
        trail: s.trail === undefined || s.trail === null || s.trail === false ? null : colorOr(s.trail, '#bdb8ae'),
        solid: s.solid !== false,
        fixed,
        stuck: null,
      }
      sim.own(collider, { kind: 'body', id: b.id })
      sim.bodies.set(b.id, b)
      b.handle = handleOf(b)
      return b.handle
    },
    zone: (spec: unknown, handlers: unknown) => {
      if (spec === null || typeof spec !== 'object') return null
      const s = spec as Record<string, unknown>
      const h = (handlers !== null && typeof handlers === 'object' ? handlers : {}) as Record<string, unknown>
      if (sim.zones.filter((z) => z.owner === owner && !z.dead).length >= MAX_ZONES_PER_SOURCE) return null
      const size = finiteVec(s.size)
      const shape: Zone['shape'] = size ? { kind: 'box', half: size.map((v) => clamp(Math.abs(v) / 2, 0.05, 15)) as Vec3 } : { kind: 'ball', radius: clamp(numOr(s.radius, 1.5), 0.1, 15) }
      let follow: Zone['follow'] = null
      const src = source()
      if (s.follow === 'holder' && src.thing) follow = { kind: 'holder', thing: src.thing }
      else if (s.follow !== undefined && s.follow !== null && typeof s.follow === 'object') {
        const id = (s.follow as { id?: unknown }).id
        if (typeof id === 'string' && sim.bodies.has(id)) follow = { kind: 'body', id }
        else if (typeof id === 'string' && sim.arena?.movers.has(id)) follow = { kind: 'mover', id }
      }
      const at = finiteVec(s.at) ?? [0, 0, 0]
      const z: Zone = {
        id: sim.nextId('z'),
        owner,
        source: src,
        shape,
        at,
        follow,
        until: typeof s.secs === 'number' && Number.isFinite(s.secs) ? sim.time + clamp(s.secs, 0.05, 60) : Infinity,
        inside: new Set(),
        enter: h.enter,
        stay: h.stay,
        exit: h.exit,
        dead: false,
      }
      sim.zones.push(z)
      return Object.freeze({
        id: z.id,
        remove: () => {
          z.dead = true
        },
      })
    },
    burst: (at: unknown, opts: unknown) => {
      const p = finiteVec(at)
      if (!p) return
      const o = (opts !== null && typeof opts === 'object' ? opts : {}) as Record<string, unknown>
      const dir = finiteVec(o.dir)
      sim.emit({
        type: 'burst',
        at: p,
        color: colorOr(o.color, '#ffffff'),
        size: clamp(numOr(o.size, 0.5), 0.05, 12),
        count: Math.round(clamp(numOr(o.count, 12), 1, 150)),
        glow: o.glow === true,
        speed: typeof o.speed === 'number' && Number.isFinite(o.speed) ? clamp(o.speed, 0, 80) : null,
        secs: typeof o.secs === 'number' && Number.isFinite(o.secs) ? clamp(o.secs, 0.1, 5) : null,
        dir: dir && len(dir) > 1e-6 ? (norm(dir).map(r3) as Vec3) : null,
        spread: clamp(numOr(o.spread, dir ? 0.35 : 1), 0, 1),
      })
    },
    puff: (at: unknown, opts: unknown) => {
      const p = finiteVec(at)
      if (!p) return
      const o = (opts !== null && typeof opts === 'object' ? opts : {}) as Record<string, unknown>
      sim.emit({ type: 'puff', at: p, color: colorOr(o.color, '#cfcac0'), size: clamp(numOr(o.size, 1), 0.05, 16), secs: clamp(numOr(o.secs, 1), 0.05, 8), rise: clamp(numOr(o.rise, 0), -5, 10), glow: o.glow === true })
    },
    shake: (at: unknown, strength: unknown) => {
      const p = finiteVec(at)
      if (p) sim.emit({ type: 'shake', at: p, strength: clamp(numOr(strength, 0.5), 0, 1) })
    },
    show: (name: unknown, spec: unknown) => {
      const model = typeof name === 'string' ? modelFor(name) : null
      if (!model) return null
      const o = (spec !== null && typeof spec === 'object' ? spec : {}) as Record<string, unknown>
      const mine = [...sim.sights.values()].filter((x) => x.owner === owner)
      while (mine.length >= MAX_SIGHTS_PER_SOURCE) sim.removeSight(mine.shift()!)
      if (sim.sights.size >= MAX_SIGHTS) sim.removeSight(sim.sights.values().next().value!)
      const follow = o.follow === undefined || o.follow === null ? null : followOf(o.follow)
      // Not following anything, and no place given: where the thing is (the arena: the middle).
      const own = source().thing
      const at = finiteVec(o.at) ?? (follow || !own ? [0, 0, 0] : sim.thingPos(own))
      const secs = clamp(numOr(o.secs, 1), 0.05, 30)
      const vel = capSpeed(finiteVec(o.vel) ?? [0, 0, 0], 200)
      const spin = (finiteVec(o.spin) ?? [0, 0, 0]).map((v) => clamp(v, -60, 60)) as Vec3
      const scale0 = sizeOr(o.scale, 0.01, 60) ?? [1, 1, 1]
      const grow = sizeOr(o.grow, 0.01, 60)
      const sight: Sight = {
        id: sim.nextId('v'),
        owner,
        at,
        vel,
        tAt: sim.time,
        born: sim.time,
        until: sim.time + secs,
        follow,
        tick: o.tick,
        handle: null,
        poses: {},
      }
      sim.sights.set(sight.id, sight)
      sight.handle = sightHandle(sight)
      const q = turnOf(o) ?? { x: 0, y: 0, z: 0, w: 1 }
      sim.emit({
        type: 'show',
        id: sight.id,
        model,
        at: at.map(r3) as Vec3,
        q: rq(q),
        scale: scale0.map(r3) as Vec3,
        grow: grow ? (grow.map(r3) as Vec3) : null,
        vel: vel.map(r3) as Vec3,
        spin: spin.map(r3) as Vec3,
        secs: r3(secs),
        fade: clamp(numOr(o.fade, 0.3), 0, 1),
        opacity: clamp(numOr(o.opacity, 1), 0, 1),
        light: o.light === undefined || o.light === null || o.light === false ? null : colorOr(o.light, '#fff2c8'),
        follow: follow?.kind === 'thing' ? { kind: 'thing', id: follow.thing.id } : follow?.kind === 'doctor' || follow?.kind === 'body' ? { kind: follow.kind, id: follow.id } : null,
      })
      return sight.handle
    },
    blast: (at: unknown, radius: unknown, speed: unknown) => {
      const p = finiteVec(at)
      if (!p) return []
      return blast(sim, p, clamp(numOr(radius, 3), 0.1, 25), clamp(numOr(speed, 10), -40, 40), holder()).map((r) => ({ doctor: sim.view(r.doctor), strength: r3(r.strength) }))
    },
    field: (spec: unknown) => {
      if (spec === null || typeof spec !== 'object') return null
      if (sim.fields.filter((f) => f.owner === owner && !f.dead).length >= MAX_FIELDS_PER_SOURCE) return null
      const src = source()
      const f: Field = {
        id: sim.nextId('f'),
        owner,
        source: src,
        at: [0, 0, 0],
        follow: null,
        radius: 3,
        until: sim.time + 5,
        pull: 0,
        swirl: 0,
        lift: 0,
        wind: [0, 0, 0],
        drag: 0,
        dead: false,
      }
      const set = (o: Record<string, unknown>) => {
        const at = finiteVec(o.at)
        if (at) f.at = at
        if (o.follow === 'holder' && src.thing) f.follow = { kind: 'holder', thing: src.thing }
        else if (o.follow !== undefined && o.follow !== null) {
          const mover = typeof (o.follow as { id?: unknown }).id === 'string' && sim.arena?.movers.has((o.follow as { id: string }).id) ? (o.follow as { id: string }).id : null
          f.follow = mover ? { kind: 'mover', id: mover } : followOf(o.follow)
        }
        if (o.radius !== undefined) f.radius = clamp(numOr(o.radius, f.radius), 0.2, 25)
        if (o.secs !== undefined) f.until = sim.time + clamp(numOr(o.secs, 5), 0.05, 30)
        for (const k of ['pull', 'swirl', 'lift', 'drag'] as const) if (o[k] !== undefined) f[k] = clamp(numOr(o[k], 0), k === 'drag' ? 0 : -120, k === 'drag' ? 20 : 120)
        const wind = finiteVec(o.wind)
        if (wind) f.wind = capSpeed(wind, 120)
      }
      set(spec as Record<string, unknown>)
      sim.fields.push(f)
      return Object.freeze({
        id: f.id,
        alive: () => !f.dead,
        set: (o: unknown) => {
          if (o !== null && typeof o === 'object' && !f.dead) set(o as Record<string, unknown>)
        },
        remove: () => {
          f.dead = true
        },
      })
    },
    tie: (a: unknown, b: unknown, opts: unknown) => {
      const ra = tieRefOf(a)
      const rb = tieRefOf(b)
      if (!ra || !rb || sim.ties.filter((t) => t.owner === owner && !t.dead).length >= MAX_TIES_PER_SOURCE) return null
      const pa = endPos(sim, ra)
      const pb = endPos(sim, rb)
      if (!pa || !pb) return null
      const o = (opts !== null && typeof opts === 'object' ? opts : {}) as Record<string, unknown>
      const tie: Tie = {
        id: sim.nextId('r'),
        owner,
        a: ra,
        b: rb,
        length: clamp(numOr(o.length, len(sub(pb, pa))), 0, 60),
        spring: clamp(numOr(o.spring, 0), 0, 1),
        until: sim.time + clamp(numOr(o.secs, 10), 0.05, 30),
        color: o.color === false || o.color === null ? null : colorOr(o.color, '#c9b48a'),
        width: clamp(numOr(o.width, 0.035), 0.005, 0.6),
        dead: false,
      }
      sim.ties.push(tie)
      return Object.freeze({
        id: tie.id,
        alive: () => !tie.dead,
        length: () => r3(tie.length),
        distance: () => {
          const p = endPos(sim, tie.a)
          const q = endPos(sim, tie.b)
          return p && q ? r3(len(sub(q, p))) : 0
        },
        setLength: (l: unknown) => {
          tie.length = clamp(numOr(l, tie.length), 0, 60)
        },
        remove: () => {
          tie.dead = true
        },
      })
    },
    topple: (target: unknown, v: unknown) => {
      const d = doctorOf(target)
      if (d) sim.topple(d, finiteVec(v) ?? [0, 4, 0])
    },
    beam: (from: unknown, to: unknown, opts: unknown) => {
      const a = finiteVec(from)
      const b = finiteVec(to)
      if (!a || !b) return
      const o = (opts !== null && typeof opts === 'object' ? opts : {}) as Record<string, unknown>
      sim.emit({ type: 'beam', from: a, to: b, color: colorOr(o.color, '#fff6a0'), width: clamp(numOr(o.width, 0.04), 0.005, 1.5), secs: clamp(numOr(o.secs, 0.12), 0.02, 3), jag: clamp(numOr(o.jag, 0), 0, 1) })
    },
    text: (at: unknown, text: unknown, color: unknown) => {
      const p = finiteVec(at)
      if (p && (typeof text === 'string' || typeof text === 'number')) sim.emit({ type: 'text', at: p, text: String(text).slice(0, 40), color: colorOr(color, '#ffffff') })
    },
    sound: (at: unknown, name: unknown, pitch: unknown, volume: unknown) => {
      const p = finiteVec(at)
      if (p && SOUNDS.includes(name as SoundName)) sim.emit({ type: 'sound', at: p, sound: name as SoundName, pitch: clamp(numOr(pitch, 1), 0.25, 4), volume: clamp(numOr(volume, 1), 0, 2) })
    },
  })
}

const xyz = (v: Vec3) => ({ x: v[0], y: v[1], z: v[2] })

function capSpeed(v: Vec3, max: number): Vec3 {
  const l = len(v)
  return l > max ? scale(v, max / l) : v
}

/** A thing's `me` and `w`. */
export function thingApi(sim: Sim, t: Thing): { me: unknown; w: unknown } {
  const holder = () => (t.holder ? (sim.doctors.get(t.holder) ?? null) : null)
  const source = (): Source => ({ attacker: t.holder ?? t.thrownBy, thing: t, what: t.kind.name })
  const modelFor = (name: string) => {
    const known = t.kind.models.get(name)
    if (!known) return null
    sim.addModel(known.id, known.recipe)
    return known.id
  }
  const defineModel = (name: string, build: unknown) => {
    if (typeof build !== 'function' || t.kind.models.size >= 24) return null
    const { recipe } = buildRecipe(build as never)
    const id = `thing:${t.kind.id}:${t.kind.models.size}`
    t.kind.models.set(name, { id, recipe })
    sim.addModel(id, recipe)
    return id
  }
  const w = worldApi(sim, t.id, source, holder, modelFor, defineModel)
  const me = Object.freeze({
    id: t.id,
    name: t.kind.name,
    budget: t.kind.budget,
    holder: () => {
      const d = holder()
      return d ? sim.view(d) : null
    },
    pos: () => sim.thingPos(t).map(r3) as Vec3,
    aim: () => {
      const d = holder()
      if (d) return { from: sim.handOf(d, t.hand).map(r3) as Vec3, dir: aimOf(d.yaw, d.pitch).map(r3) as Vec3, eye: sim.eyeOf(d).map(r3) as Vec3 }
      const p = sim.thingPos(t)
      return { from: p, dir: [0, 0, 1] as Vec3, eye: p }
    },
    pose: (part: unknown, rot: unknown) => {
      const r = finiteVec(rot)
      if (typeof part === 'string' && r && Object.keys(t.poses).length < 24) t.poses[part.slice(0, 40)] = r.map(r3) as Vec3
    },
    ride: (on: unknown) => {
      const d = holder()
      if (d) d.riding = on !== false ? t.id : d.riding === t.id ? null : d.riding
    },
    riding: () => holder()?.riding === t.id,
    disguise: (model: unknown) => {
      if (model === false || model === null) t.disguise = null
      else if (typeof model === 'string') t.disguise = modelFor(model)
      else t.disguise = `thing:${t.kind.id}`
    },
    resize: (k: unknown) => {
      t.scale = clamp(numOr(k, 1), 0.2, 4)
    },
    dealt: (target: unknown) => {
      const id = typeof target === 'string' ? target : (target as { id?: unknown } | null)?.id
      return typeof id === 'string' ? sim.dealt(t, id) : 0
    },
    drop: () => {
      const d = holder()
      if (d) sim.dropHeld(d, t.hand)
    },
    spend: () => {
      sim.emit({ type: 'burst', at: sim.thingPos(t), color: '#bbbbbb', size: 0.4, count: 8, glow: false })
      sim.removeThing(t)
    },
  })
  return { me, w }
}

/** The arena's `w`: harm from it is the arena's. */
export function arenaWorld(sim: Sim, arenaId: string): unknown {
  const models = new Map<string, string>()
  return worldApi(
    sim,
    'arena',
    () => ({ attacker: null, thing: null, what: 'the arena' }),
    () => null,
    (name) => models.get(name) ?? null,
    (name, build) => {
      if (typeof build !== 'function' || models.size >= 24) return null
      const { recipe } = buildRecipe(build as never)
      const id = `arena:${arenaId}:m${models.size}`
      models.set(name, id)
      sim.addModel(id, recipe)
      return id
    },
  )
}

/** Runs a made build function with a fresh budget, for the arena's decorations. */
export function recipeOf(build: unknown) {
  let out: ReturnType<typeof buildRecipe> | null = null
  const r = call(() => {
    out = buildRecipe(build as never)
  }, null)
  if (!r.ok) throw new Error(r.error.replace(/^Error: /, ''))
  return out!
}
