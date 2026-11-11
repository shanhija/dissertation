/**
 * One round's world on the server: Rapier physics, the doctors, the things (held, loose or in a
 * crate), the bodies things and the arena spawn, the crates, the zones, and the rules of harm.
 * Plain numbers in, a snapshot out: the server feeds it inputs, steps it at 60 Hz and sends what
 * `snapshot()` returns. Made code reaches it only through the objects api.ts builds; every rule
 * that keeps a round fair (the caps, who is out, where a crate lands) lives here.
 */

import RAPIER, { type Collider, type KinematicCharacterController, type RigidBody, type World } from '@dimforge/rapier3d-compat'

import {
  BARE_HANDS,
  BUDGET_WINDOW,
  CRATE_OWNER_ONLY,
  FALL_DAMAGE,
  FISTS_BUDGET,
  GRAVITY,
  HIT_CAP,
  HANDS,
  HOLD_MAX,
  NO_INPUT,
  PER_SECOND_CAP,
  SHOVE_DAMAGE,
  START_CRED,
  type ArenaView,
  type Budget,
  type BodySnap,
  type CrateSnap,
  type DoctorFx,
  type DoctorSnap,
  type GameEvent,
  type Hand,
  type HeldInfo,
  type Input,
  type MaterialName,
  type Me,
  type MoverSnap,
  type Origin,
  type Prim,
  type Quat,
  type Recipe,
  type Snap,
  type ThingSnap,
  type TieEnd,
  type TieSnap,
  type Vec3,
} from '../protocol'
import { stepRubble, strike, type Piece } from './breaking'
import { FORCED, momentum, stepFields, stepStuck, stepTies, type Field, type Follow, type Stuck, type Tie, type TieRef } from './forces'
import { PELVIS_Y, Ragdoll } from './ragdoll'
import { call } from './sandbox'

export const DT = 1 / 60
/** Walking speed, m/s: a brisk old academic's, not a sprinter's ("perhaps doctors aren't so fast"). */
const WALK = 4.8
/** The highest step a doctor walks up (hopping onto it when Rapier's own stepping will not). */
const STEP = 0.5
const JUMP = 7.6
/**
 * Coming down faster than this (m/s) costs credibility, FALL_HURT for each m/s over
 * (2026-11-10: "fall damage, yes"): a drop of about 3.6 m is safe, 5 m costs about 4, and from
 * about 6.4 m up it is the most one hit may take (HIT_CAP).
 */
const FALL_SAFE = 12
const FALL_HURT = 2.5
/** The doctor's capsule at size 1: its round ends' radius and its straight middle's half height. */
const RADIUS = 0.33
const HALF = 0.52
const CENTER = RADIUS + HALF
export const EYE = 1.55
const SHOVE_REACH = 1.7
const SHOVE_EVERY = 0.45
const PICK_REACH = 2.3
const CRATE_REACH = 2.8
/** Seconds a crate takes to come in ("like summoning in? they teleport in and are blueish half transparent wireframes before that"). */
const CRATE_WARP = 3
const CRATE_HALF = 0.45
/** How far above a doctor's feet (a jump) and below them (a drop) a crate may come in. */
const CRATE_RISE = 1
const CRATE_DROP = 3
/** A crate first tries to come in within this angle (radians) either side of where its asker looks, so they see it come. */
const CRATE_FRONT = (50 * Math.PI) / 180
/** The asker's words a crate keeps, at most. */
const ASK_SHOWN = 60
const THROW_SPEED = 16
const THROWN_DAMAGE = 6
/** A made thing's code that throws this many times stops: it fizzles. */
const MAX_ERRORS = 6
/**
 * A spent thing (no uses left) is gone once what it set going (bodies, sights, zones, fields,
 * ropes) has played out, but no sooner than SPENT_MIN seconds (its code may still be counting
 * toward something) and no later than SPENT_MAX (what it sets going lasts at most 30 s).
 */
const SPENT_MIN = 3
const SPENT_MAX = 30
export const MAX_BODIES = 300
export const MAX_BODIES_PER_SOURCE = 40
export const MAX_ZONES_PER_SOURCE = 8
/** Sights (models shown, never touched) one thing or the arena may have at once, and in all. */
export const MAX_SIGHTS_PER_SOURCE = 60
export const MAX_SIGHTS = 400
export const MAX_FIELDS_PER_SOURCE = 4
export const MAX_TIES_PER_SOURCE = 8
/** Events of what is seen and heard one step may send; past it they are dropped. */
const MAX_SHOWN = 600
/** A knock at least this fast (m/s) knocks a doctor flat: a ragdoll until they get up. */
export const FLOP = 11.5
/** Seconds after getting up when knocks only push. */
const FLOP_REST = 1.5
/** A hard landing this soon after a blow is the blow's doing (charged to its thing's budget); a fall out of the arena this soon, credited to its doer. */
const LANDING_BLAME = 3
const FALL_OUT_BLAME = 5
/** Seconds between two words that one thing is spent on one doctor. */
const SPENT_EVERY = 2
/** A dismissed doctor's body lies this long, then sinks through the floor and is gone. */
const DEAD_LIES = 7
const DEAD_GONE = 8.5

/** Collision groups: membership in the high half, what it meets in the low half. */
export const G = { ARENA: 1, DOCTOR: 2, BODY: 4, THING: 8, CRATE: 16 } as const
const ALL = 0xffff
export const groups = (member: number, filter: number) => (member << 16) | filter

let ready: Promise<void> | null = null
/** Rapier's WebAssembly, loaded once per process. */
export function initPhysics(): Promise<void> {
  ready ??= RAPIER.init()
  return ready
}

// ------------------------------------------------------------------------------ small vector help

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
export const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
export const norm = (a: Vec3): Vec3 => {
  const l = len(a)
  return l < 1e-9 ? [0, 0, 1] : scale(a, 1 / l)
}
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const r3 = (v: number) => Math.round(v * 1000) / 1000
const v3 = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z]
const rv = (v: Vec3): Vec3 => [r3(v[0]), r3(v[1]), r3(v[2])]
const rq = (q: { x: number; y: number; z: number; w: number }): Quat => [r3(q.x), r3(q.y), r3(q.z), r3(q.w)]

/** Where yaw and pitch look: yaw 0 toward +z, pitch + up. */
export const aimOf = (yaw: number, pitch: number): Vec3 => [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)]
const forwardOf = (yaw: number): Vec3 => [Math.sin(yaw), 0, Math.cos(yaw)]
const rightOf = (yaw: number): Vec3 => [-Math.cos(yaw), 0, Math.sin(yaw)]

/** The rotation that turns +z to look along yaw and pitch. */
export function quatOf(yaw: number, pitch: number): { x: number; y: number; z: number; w: number } {
  const cy = Math.cos(yaw / 2)
  const sy = Math.sin(yaw / 2)
  const cp = Math.cos(-pitch / 2)
  const sp = Math.sin(-pitch / 2)
  // q = qy(yaw) * qx(-pitch)
  return { x: cy * sp, y: sy * cp, z: -sy * sp, w: cy * cp }
}

// ------------------------------------------------------------------------------ the state

/** A thing kind, compiled: its model, its code and the extra models its code made. */
export interface ThingKind {
  id: string
  name: string
  description: string
  budget: Budget
  /** Uses a new one has (see USES). */
  uses: number
  recipe: Recipe
  /** The made `function (me, w)`: returns the thing's handlers. */
  factory: unknown
  /** Models the code defined, by the name it gave them. */
  models: Map<string, { id: string; recipe: Recipe }>
}

export interface Effect {
  until: number
  speed: number
  jump: number
  gravity: number
  size: number
  slip: number
  reverse: boolean
  /** False: they can use, pick up and throw nothing. */
  hands: boolean
  /** 0..1, drawn as trembling. */
  shake: number
  glow: string | null
  /** A model id drawn on them. */
  wear: string | null
  /** 0..1 of their own view covered, in tint. */
  blind: number
  tint: string | null
}

/** What all the effects on a doctor add up to. */
type Fx = Omit<Effect, 'until' | 'glow' | 'wear'> & { glow: string | null; wear: string[] }

/** An effect holds a doctor when it all but stops their walking, binds their hands or all but blinds them. */
const holds = (e: { speed: number; hands: boolean; blind: number }) => e.speed < 0.25 || !e.hands || e.blind >= 0.7

export interface Doctor {
  id: string
  name: string
  bot: boolean
  body: RigidBody
  collider: Collider
  pos: Vec3
  yaw: number
  pitch: number
  /** Walking velocity (x, z), eased toward what the keys want. */
  walk: Vec3
  /** Knocked velocity (x, z), dying away. */
  push: Vec3
  vy: number
  grounded: boolean
  /** The velocity of the mover under the feet, carried along. */
  carry: Vec3
  /** The mover under the feet, which carries rather than sweeps. */
  on: string | null
  cred: number
  alive: boolean
  /** The thing in each hand (0 left, 1 right). */
  hands: [string | null, string | null]
  /** The thing in hand they ride. */
  riding: string | null
  writing: boolean
  input: Input
  counts: Input['presses']
  /** Each hand's button was down the last step. */
  wasUsing: [boolean, boolean]
  effects: Effect[]
  size: number
  hurtAt: number
  hurtLog: { by: string; t: number; amount: number }[]
  shoveAt: number
  /** What their next request(s) must follow, and whose it is (a player, or null: the arena). */
  curse: { text: string; uses: number; by: string | null } | null
  lastPos: Vec3
  /** Seconds held in a row (see HOLD_MAX), and until when they are free of holds. */
  heldFor: number
  freeUntil: number
  /** Knocked flat or dismissed: the body is a ragdoll, since when, how long it has lain still, and until when knocks only push. */
  rag: Ragdoll | null
  ragSince: number
  ragStill: number
  flopFree: number
  /** This step: a taut tie pulls them, and how hard fields push them (m/s²), for the hold rule. */
  tugged: boolean
  forced: number
  /** Held by a tie or a field the last step. */
  pinned: boolean
  /** The floor's material under their feet, or null. */
  floor: MaterialName | null
  /** Knocked flat: how fast the body went before this step's contacts and the step before, for what it strikes. */
  ragSpeed: number
  ragSpeedBefore: number
  /** What their bare hands have taken (shoves), budgeted as a thing's is, at FISTS_BUDGET. */
  fists: Ledger
  /** The last time another doctor hurt them or moved them through made code, and how: a landing soon after is charged to it, a fall out credited. */
  lastBlow: { src: Source; t: number } | null
}

/** Who did it: a player through a thing or their bare hands, or the arena. */
export interface Source {
  attacker: string | null
  thing: Thing | null
  /** The attacker's bare hands, when it is a shove: budgeted as a thing is. */
  fists: Ledger | null
  /** In the hit and the out line: the thing's name, 'a shove', 'a fall', 'the arena'. */
  what: string
}

/** What a budget counts: what was taken, from whom and when (the last BUDGET_WINDOW seconds count), and when it last said it was spent on each player. */
export interface Ledger {
  hits: { victim: string; t: number; amount: number }[]
  shown: Map<string, number>
}

export interface Handlers {
  use?: unknown
  hold?: unknown
  release?: unknown
  alt?: unknown
  tick?: unknown
  picked?: unknown
  dropped?: unknown
  thrown?: unknown
}

export interface Thing {
  id: string
  /** The hand it is in, while in one. */
  hand: Hand
  kind: ThingKind
  holder: string | null
  body: RigidBody | null
  collider: Collider | null
  thrownBy: string | null
  thrownAt: number
  handlers: Handlers
  errors: number
  dead: boolean
  /** What it has taken, from whom and when: its budget counts the last BUDGET_WINDOW seconds. */
  hits: { victim: string; t: number; amount: number }[]
  /** When it last said it was spent on each player. */
  shown: Map<string, number>
  /** When it last hurt each player, for the rule that it never reaches everyone at once. */
  lately: Map<string, number>
  poses: Record<string, Vec3>
  scale: number
  /** The `me` made code was given, and its `w`. */
  me: unknown
  w: unknown
  /** Its speed before this step's contacts and the step before, when loose. */
  speed: number
  speedBefore: number
  /** Its holder looks like this model instead of a doctor (a model id), or not. */
  disguise: string | null
  /** How it came out of its crate (null: from none). */
  origin: Origin | null
  /** Uses left (see USES); the trial's are endless. */
  left: number
  /**
   * The press its holder is working through, from a press to letting go: whether it has cost its
   * use yet, the seconds held since (toward the next use), and whether it did something in them.
   */
  press: { paid: boolean; held: number; busy: boolean } | null
  /** Its last use spent: out of every hand, unseen, playing out what it set going; where it was, since when, and who used it last (for what it still does). */
  spent: { at: Vec3; t: number; by: string | null } | null
}

export interface Body {
  id: string
  rb: RigidBody
  collider: Collider
  source: Source
  owner: string
  model: string | null
  prim: Prim | null
  scale: number
  born: number
  until: number
  hit: unknown
  tick: unknown
  handle: unknown
  /** Bodies a thing spawned leave their own doctor alone for a moment, so a shot is not stopped by the shooter. */
  spares: string | null
  /** Where it was when it went, for code that still asks. */
  gone: Vec3 | null
  /** Its velocity before this step and the step before (a contact is reported a step after it is solved): a hit reports the faster, how it came in before it bounced. */
  vel: Vec3
  velBefore: Vec3
  /** Its collider: the shape, its size and its offset from the body (a model's middle) before any resize, and the resize. */
  shape: Prim['shape']
  size: Vec3
  mid: Vec3
  k: number
  /** Parts of its model turned by code. */
  poses: Record<string, Vec3>
  /** It turns to point its +z where it flies. */
  face: boolean
  trail: string | null
  /** Spawned solid (else it passes through everything) and fixed (else it moves). */
  solid: boolean
  fixed: boolean
  stuck: Stuck | null
}

/** A model shown for a while (w.show): only seen, never touched. The page animates it from the event; code may steer it. */
export interface Sight {
  id: string
  owner: string
  /** Where it is (in the frame of what it follows), moving at vel since tAt. */
  at: Vec3
  vel: Vec3
  tAt: number
  born: number
  until: number
  follow: Follow
  tick: unknown
  handle: unknown
  poses: Record<string, Vec3>
}

export type ZoneShape = { kind: 'box'; half: Vec3 } | { kind: 'ball'; radius: number }

export interface Zone {
  id: string
  owner: string
  source: Source
  shape: ZoneShape
  at: Vec3
  follow: { kind: 'holder'; thing: Thing } | { kind: 'body'; id: string } | { kind: 'mover'; id: string } | null
  until: number
  inside: Set<string>
  enter: unknown
  stay: unknown
  exit: unknown
  dead: boolean
}

/** How a crate's thing came: designed from the asker's words (twisted by the genie or not, under a curse's words or none), or from the archive. */
export type Made = { archive: false; genie: boolean; again: string | null; curse: string | null } | { archive: true }

export interface Crate {
  id: string
  owner: string
  body: RigidBody
  /** Its middle. */
  p: Vec3
  state: CrateSnap['state']
  /** How far it has come in, 0..1. */
  arrived: number
  kind: ThingKind | null
  /** The asker's words, cut to ASK_SHOWN; null for the random button. */
  ask: string | null
  /** How its thing came, once filled. */
  made: Made | null
  /** When it turned ready in a live round (one ready before, in the countdown, when the round went live): for CRATE_OWNER_ONLY seconds after, only its owner may open it. */
  readyAt: number | null
}

export interface Mover {
  id: string
  rb: RigidBody
  move: unknown
  at: Vec3
  rot: Vec3
  /** Where it was a step ago, to tell how fast any point of it moves (turning included). */
  lastAt: Vec3
  lastRot: Vec3
}

/** The arena as built in this world (arena.ts builds it). */
export interface Arena {
  view: ArenaView
  spawns: { p: Vec3; yaw: number }[]
  movers: Map<string, Mover>
  /** Its breakable pieces (a.breakable), by id. */
  pieces: Map<string, Piece>
  every: unknown[]
  floor: number
  w: unknown
  errors: number
}

export type Owner =
  | { kind: 'doctor'; id: string }
  | { kind: 'thing'; id: string }
  | { kind: 'body'; id: string }
  | { kind: 'crate'; id: string }
  | { kind: 'arena'; mover: string | null; material: MaterialName; piece: string | null }

export interface DoctorView {
  id: string
  name: string
  pos: Vec3
  eye: Vec3
  aim: Vec3
  vel: Vec3
  yaw: number
  pitch: number
  cred: number
  alive: boolean
  grounded: boolean
  /** What is in one of their hands (the left's first), and what is in each. */
  holding: string | null
  hands: [string | null, string | null]
  size: number
}

export interface HitTarget {
  doctor: DoctorView | null
  body: unknown
  arena: boolean
  thing: boolean
  crate: boolean
  point: Vec3
  speed: number
  vel: Vec3
}

/** Made-code errors, for the log and the tests. */
export interface MadeError {
  owner: string
  error: string
}

export class Sim {
  readonly world: World
  readonly controller: KinematicCharacterController
  private readonly queue = new RAPIER.EventQueue(true)
  readonly doctors = new Map<string, Doctor>()
  readonly things = new Map<string, Thing>()
  readonly bodies = new Map<string, Body>()
  readonly zones: Zone[] = []
  readonly fields: Field[] = []
  readonly ties: Tie[] = []
  readonly sights = new Map<string, Sight>()
  /** What code set on sights this step, sent once at its end. */
  private readonly reshows = new Map<string, Extract<GameEvent, { type: 'reshow' }>>()
  private shown = 0
  readonly crates = new Map<string, Crate>()
  readonly owners = new Map<number, Owner>()
  readonly models = new Map<string, Recipe>()
  readonly fresh: string[] = []
  readonly kinds = new Map<string, ThingKind>()
  readonly errors: MadeError[] = []
  arena: Arena | null = null
  time = 0
  /** Harm counts only while the round is on. */
  live = false
  private events: GameEvent[] = []
  /** Counts everything made code does (events, and every call of its handles but their reads), to tell whether a use did anything. */
  stirs = 0
  private seq = 0
  /** Made-code objects for the arena and things, built by api.ts. */
  apiFor: ((sim: Sim, thing: Thing) => { me: unknown; w: unknown }) | null = null

  constructor(readonly random: () => number = Math.random) {
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 })
    this.world.timestep = DT
    this.controller = this.world.createCharacterController(0.02)
    this.controller.enableSnapToGround(0.35)
    this.controller.enableAutostep(0.45, 0.15, false)
    this.controller.setMaxSlopeClimbAngle((52 * Math.PI) / 180)
    this.controller.setMinSlopeSlideAngle((40 * Math.PI) / 180)
    this.controller.setApplyImpulsesToDynamicBodies(true)
    this.controller.setCharacterMass(80)
  }

  nextId(prefix: string): string {
    return `${prefix}${++this.seq}`
  }

  emit(e: GameEvent): void {
    this.stirs++
    if (e.type === 'burst' || e.type === 'puff' || e.type === 'beam' || e.type === 'text' || e.type === 'sound' || e.type === 'shake' || e.type === 'show' || e.type === 'impact') {
      if (this.shown >= MAX_SHOWN) return
      this.shown++
    }
    this.events.push(e)
  }

  /** Code changed a sight: merged with whatever else it changed this step. */
  reshow(id: string, patch: Omit<Extract<GameEvent, { type: 'reshow' }>, 'type' | 'id'>): void {
    const e = this.reshows.get(id) ?? { type: 'reshow', id }
    Object.assign(e, patch)
    this.reshows.set(id, e)
  }

  removeSight(s: Sight): void {
    if (!this.sights.delete(s.id)) return
    this.reshow(s.id, { gone: true })
  }

  own(collider: Collider, owner: Owner): void {
    this.owners.set(collider.handle, owner)
  }

  addModel(id: string, recipe: Recipe): void {
    if (this.models.has(id)) return
    this.models.set(id, recipe)
    this.fresh.push(id)
  }

  /** The new models since the last call, to send. */
  drainModels(): Record<string, Recipe> {
    const out: Record<string, Recipe> = {}
    for (const id of this.fresh.splice(0)) out[id] = this.models.get(id)!
    return out
  }

  madeError(owner: string, error: string): void {
    this.errors.push({ owner, error })
    if (this.errors.length > 200) this.errors.splice(0, 100)
  }

  // ---------------------------------------------------------------------------- doctors

  addDoctor(id: string, name: string, bot: boolean): Doctor {
    if (this.doctors.has(id)) throw new Error(`doctor ${id} is here already`)
    const spawn = this.freeSpawn()
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.p[0], spawn.p[1] + CENTER, spawn.p[2]))
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(HALF, RADIUS).setCollisionGroups(groups(G.DOCTOR, ALL)),
      body,
    )
    const d: Doctor = {
      id,
      name,
      bot,
      body,
      collider,
      pos: [...spawn.p],
      yaw: spawn.yaw,
      pitch: 0,
      walk: [0, 0, 0],
      push: [0, 0, 0],
      vy: 0,
      grounded: false,
      carry: [0, 0, 0],
      on: null,
      cred: START_CRED,
      alive: true,
      hands: [null, null],
      riding: null,
      writing: false,
      input: { ...NO_INPUT, yaw: spawn.yaw },
      counts: { use: [0, 0], other: [0, 0], throw: [0, 0], pick: 0, jump: 0 },
      wasUsing: [false, false],
      effects: [],
      size: 1,
      hurtAt: -10,
      hurtLog: [],
      shoveAt: -10,
      curse: null,
      lastPos: [...spawn.p],
      heldFor: 0,
      freeUntil: -10,
      rag: null,
      ragSince: 0,
      ragStill: 0,
      flopFree: -10,
      tugged: false,
      forced: 0,
      pinned: false,
      floor: null,
      ragSpeed: 0,
      ragSpeedBefore: 0,
      fists: { hits: [], shown: new Map() },
      lastBlow: null,
    }
    this.own(collider, { kind: 'doctor', id })
    this.doctors.set(id, d)
    return d
  }

  removeDoctor(id: string): void {
    const d = this.doctors.get(id)
    if (!d) return
    this.dropHeld(d)
    this.endRag(d)
    this.owners.delete(d.collider.handle)
    this.world.removeRigidBody(d.body)
    this.doctors.delete(id)
  }

  /** A spawn point no doctor stands near, else the one farthest from them all. */
  private freeSpawn(): { p: Vec3; yaw: number } {
    const spawns = this.arena?.spawns ?? [{ p: [0, 1, 0] as Vec3, yaw: 0 }]
    let best = spawns[0]!
    let bestDist = -1
    const start = Math.floor(this.random() * spawns.length)
    for (let k = 0; k < spawns.length; k++) {
      const s = spawns[(start + k) % spawns.length]!
      let near = Infinity
      for (const d of this.doctors.values()) near = Math.min(near, len(sub(d.pos, s.p)))
      if (near > bestDist) {
        best = s
        bestDist = near
      }
    }
    return best
  }

  /** Counters the input carries become this step's presses. */
  setInput(id: string, input: Input): void {
    const d = this.doctors.get(id)
    if (d) d.input = input
  }

  /** Ignores what was pressed before: a doctor placed in a new round starts with no presses pending. */
  syncPresses(id: string): void {
    const d = this.doctors.get(id)
    if (d) d.counts = { ...d.input.presses }
  }

  view(d: Doctor): DoctorView {
    const eye = this.eyeOf(d)
    const vel: Vec3 = [d.walk[0] + d.push[0], d.vy, d.walk[2] + d.push[2]]
    return {
      id: d.id,
      name: d.name,
      pos: [...d.pos],
      eye,
      aim: aimOf(d.yaw, d.pitch),
      vel,
      yaw: d.yaw,
      pitch: d.pitch,
      cred: d.cred,
      alive: d.alive,
      grounded: d.grounded,
      holding: this.inHand(d, 0)?.kind.name ?? this.inHand(d, 1)?.kind.name ?? null,
      hands: [this.inHand(d, 0)?.kind.name ?? null, this.inHand(d, 1)?.kind.name ?? null],
      size: d.size,
    }
  }

  eyeOf(d: Doctor): Vec3 {
    return [d.pos[0], d.pos[1] + EYE * d.size, d.pos[2]]
  }

  /** Where a thing in hand is: in front of the eyes, out to the side of its hand. */
  handOf(d: Doctor, hand: Hand): Vec3 {
    const aim = aimOf(d.yaw, d.pitch)
    const right = scale(rightOf(d.yaw), hand === 1 ? 0.28 : -0.28)
    const eye = this.eyeOf(d)
    return [eye[0] + aim[0] * 0.5 * d.size + right[0] * d.size, eye[1] + aim[1] * 0.5 * d.size - 0.28 * d.size, eye[2] + aim[2] * 0.5 * d.size + right[2] * d.size]
  }

  /** The thing in one of a doctor's hands. */
  inHand(d: Doctor, hand: Hand): Thing | null {
    const id = d.hands[hand]
    return id ? (this.things.get(id) ?? null) : null
  }

  private fx(d: Doctor): Fx {
    const out: Fx = { speed: 1, jump: 1, gravity: 1, size: 1, slip: 0, reverse: false, hands: true, shake: 0, glow: null, wear: [], blind: 0, tint: null }
    for (const e of d.effects) {
      out.speed *= e.speed
      out.jump *= e.jump
      out.gravity *= e.gravity
      out.size *= e.size
      out.slip = Math.max(out.slip, e.slip)
      out.reverse ||= e.reverse
      out.hands &&= e.hands
      out.shake = Math.max(out.shake, e.shake)
      if (e.glow) out.glow = e.glow
      if (e.wear && !out.wear.includes(e.wear)) out.wear.push(e.wear)
      if (e.blind > out.blind) {
        out.blind = e.blind
        out.tint = e.tint
      }
    }
    out.speed = clamp(out.speed, 0, 2.5)
    out.jump = clamp(out.jump, 0, 2.8)
    out.gravity = clamp(out.gravity, 0.15, 2.5)
    out.size = clamp(out.size, 0.35, 2.2)
    out.wear = out.wear.slice(-3)
    // Shaken free: nothing holds them for a while.
    if (this.time < d.freeUntil) {
      out.speed = Math.max(out.speed, 0.5)
      out.jump = Math.max(out.jump, 0.5)
      out.hands = true
      out.blind = Math.min(out.blind, 0.5)
    }
    return out
  }

  /** The control rule for a doctor standing (see HOLD_MAX): held seconds count up, free ones down. */
  private holdRule(d: Doctor, fx: Fx, dt: number): Fx {
    const pinned = d.tugged || d.forced >= FORCED
    d.pinned = pinned
    d.tugged = false
    d.forced = 0
    if (!holds(fx) && !pinned) {
      d.heldFor = Math.max(0, d.heldFor - dt)
      return fx
    }
    d.heldFor += dt
    if (d.heldFor < HOLD_MAX) return fx
    this.shakeFree(d)
    // Ties and fields let go of them (forces.ts leaves the free alone), and what they pulled stops.
    if (pinned) {
      d.pinned = false
      d.push = [0, 0, 0]
      d.vy = Math.min(d.vy, 0)
    }
    return this.fx(d)
  }

  /**
   * Held HOLD_MAX in all: the holds end, and for as long again no hold takes and knocks only push.
   * A ragdoll is not stood up (it may be flying): it lies on and gets up as it would, and its free
   * time starts when it does.
   */
  private shakeFree(d: Doctor): void {
    d.heldFor = 0
    d.freeUntil = this.time + HOLD_MAX
    d.flopFree = Math.max(d.flopFree, this.time + HOLD_MAX)
    d.effects = d.effects.filter((e) => !holds(e) && e.speed >= 0.5 && e.jump >= 0.5)
    this.emit({ type: 'burst', at: add(d.pos, [0, 1, 0]), color: '#f4ecd8', size: 0.7, count: 14, glow: false })
  }

  private stepDoctor(d: Doctor, dt: number): void {
    const input = d.input
    // What was pressed since the last step.
    const p = input.presses
    const c = d.counts
    const usePressed = HANDS.map((h) => p.use[h] > c.use[h])
    const otherPressed = HANDS.map((h) => p.other[h] > c.other[h])
    const throwPressed = HANDS.map((h) => p.throw[h] > c.throw[h])
    const pickPressed = p.pick > c.pick
    const jumpPressed = p.jump > c.jump
    d.counts = { use: [...p.use], other: [...p.other], throw: [...p.throw], pick: p.pick, jump: p.jump }
    d.yaw = input.yaw
    d.pitch = clamp(input.pitch, -1.45, 1.45)
    if (d.rag) return this.stepRag(d, dt)
    if (!d.alive) return
    d.effects = d.effects.filter((e) => e.until > this.time)
    const fx = this.holdRule(d, this.fx(d), dt)
    if (Math.abs(fx.size - d.size) > 0.01) {
      d.size = fx.size
      d.collider.setRadius(RADIUS * d.size)
      d.collider.setHalfHeight(HALF * d.size)
    }
    const typing = d.writing
    // Writing a request, or with hands bound, nothing is used, picked up or thrown.
    const busy = typing || !fx.hands
    if (!typing && (jumpPressed || input.jump) && d.grounded && fx.jump > 0.01) {
      d.vy = JUMP * Math.sqrt(fx.jump)
      d.grounded = false
    }
    if (!busy) {
      // Each mouse button works the hand on its side: what is in it, or a shove with it empty.
      for (const h of HANDS) {
        const act = (a: 'use' | 'alt' | 'throw') => this.emit({ type: 'act', who: d.id, act: a, hand: h })
        const held = this.inHand(d, h)
        if (usePressed[h]) {
          if (held) {
            act('use')
            this.work(held, 'use', dt)
          } else this.shove(d, h)
        }
        // Using it may have dropped it or spent it.
        const still = this.inHand(d, h)
        if (still && still === held && input.hands[h] && !usePressed[h]) this.work(still, 'hold', dt)
        if (still && d.wasUsing[h] && !input.hands[h]) this.work(still, 'release', dt)
        if (still && otherPressed[h] && this.inHand(d, h) === still) {
          act('alt')
          this.work(still, 'alt', dt)
        }
        if (throwPressed[h] && this.inHand(d, h)) {
          act('throw')
          this.throwHeld(d, h)
        }
      }
      if (pickPressed) this.pick(d)
    } else
      for (const h of HANDS) {
        const held = this.inHand(d, h)
        if (d.wasUsing[h] && held) this.work(held, 'release', dt)
      }
    d.wasUsing = [input.hands[0] && !busy, input.hands[1] && !busy]

    let mx = typing ? 0 : input.move[0]
    let mz = typing ? 0 : input.move[1]
    if (fx.reverse) {
      mx = -mx
      mz = -mz
    }
    const l = Math.hypot(mx, mz)
    if (l > 1) {
      mx /= l
      mz /= l
    }
    const fwd = forwardOf(d.yaw)
    const right = rightOf(d.yaw)
    const want: Vec3 = scale(add(scale(right, mx), scale(fwd, mz)), WALK * fx.speed)
    const grip = d.grounded ? 14 * (1 - fx.slip * 0.9) : 2.5
    const k = 1 - Math.exp(-grip * dt)
    d.walk = [d.walk[0] + (want[0] - d.walk[0]) * k, 0, d.walk[2] + (want[2] - d.walk[2]) * k]
    const decay = Math.exp(-(d.grounded ? 5 : 0.5) * dt)
    d.push = [d.push[0] * decay, 0, d.push[2] * decay]
    d.vy = Math.max(-45, d.vy - GRAVITY * fx.gravity * dt)

    // The mover under the feet carries the doctor along.
    d.carry = [0, 0, 0]
    d.on = null
    const center = d.body.translation()
    const below = this.world.castRay(new RAPIER.Ray({ x: center.x, y: d.pos[1] + 0.15, z: center.z }, { x: 0, y: -1, z: 0 }), 0.45, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(ALL, G.ARENA))
    d.floor = null
    if (below) {
      const o = this.owners.get(below.collider.handle)
      if (o?.kind === 'arena') d.floor = o.material
      if (o?.kind === 'arena' && o.mover) {
        d.carry = moverVelocity(this.arena!.movers.get(o.mover)!, d.pos, DT)
        d.on = o.mover
      }
    }

    const desired = { x: (d.walk[0] + d.push[0] + d.carry[0]) * dt, y: (d.vy + (d.grounded ? Math.min(0, d.carry[1]) : 0)) * dt, z: (d.walk[2] + d.push[2] + d.carry[2]) * dt }
    if (d.grounded && d.carry[1] > 0) desired.y += d.carry[1] * dt
    this.controller.computeColliderMovement(d.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(G.DOCTOR, G.ARENA | G.CRATE | G.DOCTOR | G.BODY))
    const m = this.controller.computedMovement()
    const wasGrounded = d.grounded
    d.grounded = this.controller.computedGrounded()
    if (!wasGrounded && d.grounded && !d.riding) this.landed(d, -d.vy, fx.jump)
    if (d.grounded && d.vy < 0) d.vy = -1
    if (!wasGrounded && d.grounded && d.vy < -1) d.vy = -1
    // Stairs. Rapier steps a character up only when it meets a step squarely; met at a slant, or
    // slowly, it slides along the riser ("the doc can't always walk up the stairs without
    // jumping"). Blocked while walking on the ground, it looks just ahead the way it walks, and
    // where a step's top is within STEP of its feet, it hops up onto it.
    if (wasGrounded && !typing && d.vy <= 0) {
      const wl = Math.hypot(d.walk[0], d.walk[2])
      if (wl > 0.8) {
        const dir: Vec3 = [d.walk[0] / wl, 0, d.walk[2] / wl]
        if ((m.x * dir[0] + m.z * dir[2]) / dt < wl * 0.5) this.hopStair(d, dir)
      }
    }
    if (d.vy > 0 && m.y < desired.y * 0.5) d.vy = 0
    // A knock that runs into a wall stops there. Only a wall: the controller now and then stops
    // short on the floor itself (a rug on the boards), which must not end a knock in mid-slide.
    let wall = false
    for (let i = 0; i < this.controller.numComputedCollisions() && !wall; i++) wall = Math.abs(this.controller.computedCollision(i)?.normal1.y ?? 1) < 0.7
    if (wall && Math.abs(desired.x) > 1e-5 && Math.abs(m.x) < Math.abs(desired.x) * 0.5) d.push[0] = 0
    if (wall && Math.abs(desired.z) > 1e-5 && Math.abs(m.z) < Math.abs(desired.z) * 0.5) d.push[2] = 0
    d.lastPos = [...d.pos]
    d.pos = [d.pos[0] + m.x, d.pos[1] + m.y, d.pos[2] + m.z]
    d.body.setNextKinematicTranslation({ x: d.pos[0], y: d.pos[1] + CENTER * d.size, z: d.pos[2] })

    if (this.arena && d.pos[1] < this.arena.floor) this.fallOut(d)
  }

  /** Hops a doctor up onto a step just ahead in a direction: a riser in the way, room above it, and a flat top no higher than STEP. */
  private hopStair(d: Doctor, dir: Vec3): void {
    const reach = RADIUS * d.size + 0.3
    const along = (y: number) =>
      this.world.castRay(new RAPIER.Ray({ x: d.pos[0], y: d.pos[1] + y, z: d.pos[2] }, { x: dir[0], y: 0, z: dir[2] }), reach, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(ALL, G.ARENA | G.CRATE), d.collider)
    const riser = along(0.08)
    if (!riser || along(STEP + 0.06)) return
    const over = riser.timeOfImpact + 0.14
    const top = this.groundBelow([d.pos[0] + dir[0] * over, d.pos[1] + STEP + 0.05, d.pos[2] + dir[2] * over], STEP + 0.05)
    if (!top?.flat) return
    const rise = top.y - d.pos[1]
    if (rise < 0.04 || rise > STEP) return
    d.vy = Math.sqrt(2 * GRAVITY * (rise + 0.1))
    d.grounded = false
  }

  /** Out of the arena: back at a spawn point, for FALL_DAMAGE credited to whoever last moved or hurt them, if lately (outside every budget and cap: a fall out always costs its FALL_DAMAGE). */
  private fallOut(d: Doctor): void {
    if (d.rag) {
      this.endRag(d)
      d.collider.setEnabled(true)
    }
    const blow = this.blowWithin(d, FALL_OUT_BLAME)
    const spawn = this.freeSpawn()
    this.emit({ type: 'sound', at: [...d.pos], sound: 'splat', pitch: 0.7 })
    d.pos = [...spawn.p]
    d.lastPos = [...spawn.p]
    d.walk = [0, 0, 0]
    d.push = [0, 0, 0]
    d.vy = 0
    d.body.setTranslation({ x: d.pos[0], y: d.pos[1] + CENTER * d.size, z: d.pos[2] }, true)
    if (this.live) this.take(d, FALL_DAMAGE, { attacker: blow?.attacker ?? null, thing: null, fists: null, what: 'a fall from the arena' })
    // Back in, they start clean: nothing after is put down to that blow.
    d.lastBlow = null
  }

  /** Puts a doctor at a spawn point with full credibility, empty hands and no effects: the start of a round. */
  respawn(d: Doctor): void {
    this.dropHeld(d)
    this.endRag(d)
    d.flopFree = -10
    const spawn = this.freeSpawnFor(d)
    d.pos = [...spawn.p]
    d.lastPos = [...spawn.p]
    d.yaw = spawn.yaw
    d.input = { ...d.input, yaw: spawn.yaw }
    d.walk = [0, 0, 0]
    d.push = [0, 0, 0]
    d.vy = 0
    d.cred = START_CRED
    d.alive = true
    d.effects = []
    d.heldFor = 0
    d.freeUntil = -10
    d.lastBlow = null
    d.curse = null
    d.collider.setEnabled(true)
    d.body.setTranslation({ x: d.pos[0], y: d.pos[1] + CENTER * d.size, z: d.pos[2] }, true)
  }

  private freeSpawnFor(d: Doctor): { p: Vec3; yaw: number } {
    const others = [...this.doctors.values()].filter((o) => o !== d)
    const spawns = this.arena?.spawns ?? [{ p: [0, 1, 0] as Vec3, yaw: 0 }]
    let best = spawns[0]!
    let bestDist = -1
    for (const s of spawns) {
      let near = Infinity
      for (const o of others) near = Math.min(near, len(sub(o.pos, s.p)))
      if (near > bestDist + 0.01) {
        best = s
        bestDist = near
      }
    }
    return best
  }

  private shove(d: Doctor, hand: Hand): void {
    if (this.time - d.shoveAt < SHOVE_EVERY) return
    d.shoveAt = this.time
    this.emit({ type: 'act', who: d.id, act: 'shove', hand })
    const fwd = forwardOf(d.yaw)
    let target: Doctor | null = null
    let best = Infinity
    for (const o of this.doctors.values()) {
      if (o === d || !o.alive) continue
      const to = sub(o.pos, d.pos)
      const flat: Vec3 = [to[0], 0, to[2]]
      const dist = len(flat)
      if (dist > SHOVE_REACH * Math.max(1, d.size) || Math.abs(to[1]) > 1.6) continue
      if (dist > 0.2 && dot(norm(flat), fwd) < 0.45) continue
      if (dist < best) {
        best = dist
        target = o
      }
    }
    this.emit({ type: 'sound', at: this.handOf(d, hand), sound: 'whoosh', pitch: 1.2 })
    if (!target) return
    this.harm(target, SHOVE_DAMAGE, { attacker: d.id, thing: null, fists: d.fists, what: 'a shove' })
    this.knock(target, add(scale(fwd, 10), [0, 4.5, 0]))
    this.emit({ type: 'sound', at: [...target.pos], sound: 'thud', pitch: 1 })
  }

  /**
   * Adds velocity to a doctor: x and z as a knock that dies away, y as a lift. A knock of FLOP or
   * more knocks them flat (a ragdoll); one that comes while they are down throws the ragdoll.
   */
  knock(d: Doctor, v: Vec3): void {
    const k = Math.min(1, 28 / Math.max(1e-6, len(v)))
    if (d.rag) return d.rag.push(scale(v, k))
    if (d.alive && len(v) * k >= FLOP && this.time >= d.flopFree) return this.flop(d, scale(v, k))
    d.push = [d.push[0] + v[0] * k, 0, d.push[2] + v[2] * k]
    if (v[1] * k > 0) {
      d.vy = Math.max(d.vy, 0) + v[1] * k
      d.grounded = false
    } else d.vy += v[1] * k
  }

  /**
   * Takes credibility, by the rules: at most HIT_CAP a hit; at most the thing's budget (bare
   * hands': FISTS_BUDGET) from one player in any BUDGET_WINDOW seconds; at most PER_SECOND_CAP a
   * second from one attacker (the arena counts as one); and a thing never reaches every other
   * player within one second when there are three or more. Returns what was taken. What was
   * taken shows over the victim's head; a hit the budget leaves nothing of says the thing is spent.
   */
  harm(victim: Doctor, amount: number, src: Source): number {
    if (!this.live || !victim.alive) return 0
    this.blame(victim, src)
    if (!(amount > 0)) return 0
    let take = Math.min(HIT_CAP, amount)
    const by = src.attacker ?? 'arena'
    victim.hurtLog = victim.hurtLog.filter((h) => h.t > this.time - 1)
    const lastSecond = victim.hurtLog.filter((h) => h.by === by).reduce((s, h) => s + h.amount, 0)
    take = Math.min(take, PER_SECOND_CAP - lastSecond)
    const thing = src.thing
    const ledger = thing ?? src.fists
    if (ledger) {
      const left = Math.round(((thing ? thing.kind.budget : FISTS_BUDGET) - this.dealt(ledger, victim.id)) * 10) / 10
      if (take > 0 && left <= 0) this.spent(victim, src, ledger)
      take = Math.min(take, left)
    }
    if (thing) {
      const others = [...this.doctors.values()].filter((o) => o.alive && o.id !== src.attacker)
      const recent = new Set([...thing.lately].filter(([, t]) => t > this.time - 1).map(([id]) => id))
      if (others.length >= 3 && !recent.has(victim.id) && recent.size + 1 >= others.length) take = 0
    }
    take = Math.round(take * 10) / 10
    if (take <= 0) return 0
    victim.hurtLog.push({ by, t: this.time, amount: take })
    if (ledger) {
      ledger.hits = ledger.hits.filter((h) => h.t > this.time - BUDGET_WINDOW)
      ledger.hits.push({ victim: victim.id, t: this.time, amount: take })
    }
    if (thing) thing.lately.set(victim.id, this.time)
    return this.take(victim, take, src)
  }

  /** Takes credibility as it is, past every rule (what harm leaves of a blow, or a fall out), shown over the victim's head; at none left they are out. */
  private take(victim: Doctor, amount: number, src: Source): number {
    victim.cred = Math.max(0, Math.round((victim.cred - amount) * 10) / 10)
    victim.hurtAt = this.time
    this.emit({ type: 'hit', victim: victim.id, amount, at: rv(add(victim.pos, [0, (EYE + 0.35) * victim.size, 0])), by: src.attacker, what: src.what })
    if (victim.cred <= 0) this.out(victim, src)
    return amount
  }

  /** A thing (or bare hands) has nothing left to take from a doctor: says so, at most every SPENT_EVERY seconds, with when it may take again. */
  private spent(victim: Doctor, src: Source, ledger: Ledger): void {
    if (this.time - (ledger.shown.get(victim.id) ?? -SPENT_EVERY) < SPENT_EVERY) return
    ledger.shown.set(victim.id, this.time)
    const oldest = Math.min(...ledger.hits.filter((h) => h.victim === victim.id && h.t > this.time - BUDGET_WINDOW).map((h) => h.t))
    this.emit({ type: 'spent', victim: victim.id, by: src.attacker, thing: src.thing ? src.thing.kind.name : BARE_HANDS, back: Math.ceil((oldest + BUDGET_WINDOW - this.time) * 10) / 10 })
  }

  /** What a thing (or a doctor's bare hands) has taken from one doctor in the last BUDGET_WINDOW seconds, against its budget. */
  dealt(ledger: Ledger, victim: string): number {
    let sum = 0
    for (const h of ledger.hits) if (h.victim === victim && h.t > this.time - BUDGET_WINDOW) sum += h.amount
    return sum
  }

  /**
   * Another doctor hurt this one, or moved them through made code (a push, a topple, a blast, a
   * field, a tie, a body that struck them, a teleport): a hard landing soon after is charged to
   * it, and a fall out of the arena credited to its doer. What one does to oneself, the arena and
   * the committee do, puts nothing down to anyone.
   */
  blame(d: Doctor, src: Source): void {
    if (src.attacker === null || src.attacker === d.id || !this.doctors.has(src.attacker)) return
    d.lastBlow = { src, t: this.time }
  }

  /** The last blow on a doctor, when it came within `secs`. */
  private blowWithin(d: Doctor, secs: number): Source | null {
    return d.lastBlow && this.time - d.lastBlow.t <= secs ? d.lastBlow.src : null
  }

  private out(d: Doctor, src: Source): void {
    d.alive = false
    d.cred = 0
    this.dropHeld(d)
    d.effects = []
    d.collider.setEnabled(false)
    // The body falls as a ragdoll, away from whoever did it (else backwards), and lies a while.
    const by = src.attacker ? this.doctors.get(src.attacker) : undefined
    const away = by && by !== d ? norm([d.pos[0] - by.pos[0], 0, d.pos[2] - by.pos[2]]) : forwardOf(d.yaw + Math.PI)
    if (d.rag) d.rag.push(add(scale(away, 2), [0, 1.5, 0]))
    else this.flop(d, add(scale(away, 3.5), [0, 2.5, 0]))
    d.ragSince = this.time
    this.emit({ type: 'out', victim: d.id, by: src.attacker, what: src.what })
    this.emit({ type: 'burst', at: add(d.pos, [0, 1, 0]), color: '#f4ecd8', size: 1.2, count: 30, glow: false })
  }

  /** Knocks a doctor flat: what they held drops, and their body becomes a ragdoll moving as they were, plus v, toppling with it. */
  private flop(d: Doctor, v: Vec3): void {
    this.dropHeld(d)
    const vel = add([d.walk[0] + d.push[0] + d.carry[0], d.vy, d.walk[2] + d.push[2] + d.carry[2]], v)
    const h = norm([v[0], 0, v[2]])
    const tip = 3 + len(v) * 0.2
    d.rag = new Ragdoll(this.world, d.pos, d.yaw, d.size, vel, [h[2] * tip, (this.random() - 0.5) * 2, -h[0] * tip], groups(G.DOCTOR, G.ARENA | G.BODY | G.THING | G.CRATE | G.DOCTOR), (c) =>
      this.own(c, { kind: 'doctor', id: d.id }),
    )
    d.ragSince = this.time
    d.ragStill = 0
    // Lying counts for the control rule on its own; what pulled them standing no longer does.
    d.pinned = false
    d.collider.setEnabled(false)
    d.walk = [0, 0, 0]
    d.push = [0, 0, 0]
    d.vy = 0
    d.grounded = false
  }

  /** A ragdolled doctor: follows the body; gets up when it has settled (or after a while); the dismissed sink away. */
  private stepRag(d: Doctor, dt: number): void {
    const rag = d.rag!
    const p = rag.pelvis()
    const v = rag.velocity()
    d.ragSpeedBefore = d.ragSpeed
    d.ragSpeed = len(v)
    d.pos = [p[0], p[1] - PELVIS_Y * d.size, p[2]]
    d.push = [v[0], 0, v[2]]
    d.vy = v[1]
    if (this.arena && p[1] < this.arena.floor && !rag.sunk) {
      if (d.alive) return this.fallOut(d)
      return this.endRag(d)
    }
    const age = this.time - d.ragSince
    rag.step(age, dt, d.alive)
    if (!d.alive) {
      if (age > DEAD_LIES && !rag.sunk) rag.sink()
      if (age > DEAD_GONE) this.endRag(d)
      return
    }
    // Lying knocked flat counts as held, but not once they have shaken free.
    if (this.time >= d.freeUntil) {
      d.heldFor += dt
      if (d.heldFor >= HOLD_MAX) this.shakeFree(d)
    }
    d.ragStill = len(v) < 1.2 ? d.ragStill + dt : 0
    if ((age > 0.8 && d.ragStill > 0.35) || age > 3.5) this.standUp(d)
  }

  /** Up again where the body lies, on the floor under it (or out, when there is none). */
  private standUp(d: Doctor): void {
    const p = d.rag!.pelvis()
    const ground = this.groundBelow([p[0], p[1] + 0.8, p[2]], 12)
    this.endRag(d)
    d.collider.setEnabled(true)
    // Shaken free while lying: free for the whole of it from now.
    if (this.time < d.freeUntil) d.freeUntil = this.time + HOLD_MAX
    d.flopFree = Math.max(d.flopFree, d.freeUntil, this.time + FLOP_REST)
    if (!ground) return this.fallOut(d)
    d.pos = [p[0], ground.y, p[2]]
    d.lastPos = [...d.pos]
    d.walk = [0, 0, 0]
    d.push = [0, 0, 0]
    d.vy = 0
    d.grounded = false
    d.body.setTranslation({ x: d.pos[0], y: d.pos[1] + CENTER * d.size, z: d.pos[2] }, true)
  }

  private endRag(d: Doctor): void {
    if (!d.rag) return
    for (const h of d.rag.remove()) this.owners.delete(h)
    d.rag = null
  }

  /** Changes a doctor for a while. A hold on a doctor who has just shaken one off does not take. */
  affect(d: Doctor, e: Partial<Omit<Effect, 'until'>>, secs: number): void {
    if (!d.alive) return
    const num = (v: unknown, lo: number, hi: number, def: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : def)
    const effect: Effect = {
      until: this.time + num(secs, 0.1, 15, 3),
      speed: num(e.speed, 0, 2.5, 1),
      jump: num(e.jump, 0, 2.8, 1),
      gravity: num(e.gravity, 0.15, 2.5, 1),
      size: num(e.size, 0.35, 2.2, 1),
      slip: num(e.slip, 0, 1, 0),
      reverse: e.reverse === true,
      hands: e.hands !== false,
      shake: num(e.shake, 0, 1, 0),
      glow: typeof e.glow === 'string' ? e.glow : null,
      wear: typeof e.wear === 'string' ? e.wear : null,
      blind: num(e.blind, 0, 1, 0),
      tint: typeof e.tint === 'string' ? e.tint : null,
    }
    if (holds(effect) && this.time < d.freeUntil) return
    d.effects.push(effect)
    if (d.effects.length > 12) d.effects.shift()
  }

  /** Whether a doctor is held now, in any way the control rule counts (a hold, a rope or a field they cannot walk against, or lying knocked flat), for code that asks. */
  held(d: Doctor): boolean {
    return d.alive && (d.rag !== null || holds(this.fx(d)) || d.pinned)
  }

  /** Knocks a doctor flat, thrown at v (only pushed, within FLOP_REST of getting up). */
  topple(d: Doctor, v: Vec3): void {
    const k = Math.min(1, 28 / Math.max(1e-6, len(v)))
    if (d.rag) return d.rag.push(scale(v, k))
    if (!d.alive) return
    if (this.time < d.flopFree) return this.knock(d, v)
    this.flop(d, scale(v, k))
  }

  teleport(d: Doctor, p: Vec3): void {
    if (!d.alive || !p.every(Number.isFinite)) return
    if (d.rag) {
      this.endRag(d)
      d.collider.setEnabled(true)
      // Up, as from getting up: not knocked flat again at once (else a topple and a teleport together would floor them at every use).
      d.flopFree = Math.max(d.flopFree, this.time + FLOP_REST)
    }
    d.pos = [...p]
    d.lastPos = [...p]
    d.vy = 0
    d.body.setTranslation({ x: p[0], y: p[1] + CENTER * d.size, z: p[2] }, true)
  }

  /** Lays a curse on a doctor's next request(s), by a player (null: the arena). */
  curse(d: Doctor, text: string, uses: number, by: string | null): void {
    const t = String(text).trim().slice(0, 240)
    if (!t || !d.alive) return
    d.curse = { text: t, uses: clamp(Math.round(uses) || 1, 1, 3), by }
    this.emit({ type: 'curse', victim: d.id, text: t, by })
  }

  /** The curse that goes with this player's next request, one use spent. */
  takeCurse(id: string): string | null {
    const d = this.doctors.get(id)
    if (!d?.curse) return null
    const text = d.curse.text
    if (--d.curse.uses <= 0) d.curse = null
    return text
  }

  // ---------------------------------------------------------------------------- things

  /** A thing kind joins this world: its models go out to the players. */
  useKind(kind: ThingKind): void {
    if (this.kinds.has(kind.id)) return
    this.kinds.set(kind.id, kind)
    this.addModel(`thing:${kind.id}`, kind.recipe)
  }

  /** A new instance of a kind, in a doctor's hand or loose at a point. */
  newThing(kind: ThingKind, holder: Doctor | null, at: Vec3): Thing {
    this.useKind(kind)
    const t: Thing = {
      id: this.nextId('t'),
      kind,
      holder: null,
      body: null,
      collider: null,
      thrownBy: null,
      thrownAt: -10,
      handlers: {},
      errors: 0,
      dead: false,
      hits: [],
      shown: new Map(),
      lately: new Map(),
      poses: {},
      scale: 1,
      me: null,
      w: null,
      speed: 0,
      speedBefore: 0,
      hand: 0,
      disguise: null,
      origin: null,
      left: kind.uses,
      press: null,
      spent: null,
    }
    this.things.set(t.id, t)
    const api = this.apiFor!(this, t)
    t.me = api.me
    t.w = api.w
    const made = call<unknown>(kind.factory, null, t.me, t.w)
    if (!made.ok) this.thingError(t, made.error)
    else if (made.value !== null && typeof made.value === 'object') t.handlers = made.value as Handlers
    if (holder) this.give(holder, t)
    else this.loosen(t, at, [0, 0, 0])
    return t
  }

  private thingError(t: Thing, error: string): void {
    t.errors++
    this.madeError(`thing ${t.kind.id}`, error)
    if (t.errors >= MAX_ERRORS && !t.dead) {
      this.emit({ type: 'fizzle', thing: t.kind.name, holder: t.holder })
      this.emit({ type: 'burst', at: this.thingPos(t), color: '#888888', size: 0.6, count: 12, glow: false })
      this.removeThing(t)
    }
  }

  callThing(t: Thing, name: keyof Handlers, ...args: unknown[]): void {
    if (t.dead) return
    const r = call(t.handlers[name], t.handlers, ...args)
    if (!r.ok) this.thingError(t, `${name}: ${r.error}`)
  }

  /**
   * Its holder works a thing: a press, holding it down, letting go, or its other use. What does
   * something costs uses: a press, with what follows until it is let go, one (paid when anything
   * in it first does something, so a press that does nothing while the thing reloads costs none),
   * and one more for each further second held in which holding it did something; the other use
   * one. With none left it is spent.
   */
  private work(t: Thing, name: 'use' | 'hold' | 'release' | 'alt', dt: number): void {
    const before = this.stirs
    if (name === 'hold') this.callThing(t, 'hold', dt)
    else this.callThing(t, name)
    if (t.dead || t.spent) return
    const did = this.stirs > before
    let cost = 0
    if (name === 'alt') cost = did ? 1 : 0
    else {
      // A hold with no press before it: the button was down as the thing came into the hand.
      if (name === 'use' || !t.press) t.press = { paid: false, held: 0, busy: false }
      const p = t.press
      if (did && !p.paid) {
        p.paid = true
        cost = 1
      } else if (name === 'hold' && p.paid) {
        p.held += dt
        p.busy ||= did
        if (p.held >= 1) {
          p.held -= 1
          if (p.busy) cost = 1
          p.busy = false
        }
      }
      if (name === 'release') t.press = null
    }
    t.left -= cost
    if (t.left <= 0) this.exhaust(t)
  }

  /**
   * A thing's last use is spent (or its code spent it): it leaves the hand, or the floor, and is
   * seen no more, while what it set going plays out; then it is gone (SPENT_MIN, SPENT_MAX).
   */
  exhaust(t: Thing): void {
    if (t.dead || t.spent) return
    const at = this.thingPos(t)
    const d = t.holder ? this.doctors.get(t.holder) : undefined
    if (d) this.letGo(d, t)
    if (t.body) {
      this.owners.delete(t.collider!.handle)
      this.world.removeRigidBody(t.body)
      t.body = null
      t.collider = null
    }
    t.spent = { at, t: this.time, by: d?.id ?? t.thrownBy }
    t.holder = null
    t.press = null
    this.emit({ type: 'burst', at, color: '#bbbbbb', size: 0.4, count: 8, glow: false })
    this.emit({ type: 'sound', at, sound: 'click', pitch: 0.8 })
    this.emit({ type: 'usedUp', who: d?.id ?? null, thing: t.kind.name })
  }

  /** Whether anything a thing set going is still about: its bodies, sights, zones, fields or ropes. */
  private playing(t: Thing): boolean {
    for (const b of this.bodies.values()) if (b.owner === t.id) return true
    for (const x of this.sights.values()) if (x.owner === t.id) return true
    return this.zones.some((z) => z.owner === t.id && !z.dead) || this.fields.some((f) => f.owner === t.id && !f.dead) || this.ties.some((x) => x.owner === t.id && !x.dead)
  }

  thingPos(t: Thing): Vec3 {
    if (t.holder) {
      const d = this.doctors.get(t.holder)!
      return d.riding === t.id ? [...d.pos] : this.handOf(d, t.hand)
    }
    if (t.body) return v3(t.body.translation())
    if (t.spent) return [...t.spent.at]
    return [0, 0, 0]
  }

  /** The hand a new thing goes into: the left when it is empty, else the right; with both full, the left, what was in it dropped. */
  private freeHand(d: Doctor): Hand {
    return d.hands[0] === null ? 0 : d.hands[1] === null ? 1 : 0
  }

  private give(d: Doctor, t: Thing, hand: Hand = this.freeHand(d)): void {
    if (d.hands[hand]) this.dropHeld(d, hand)
    if (t.body) {
      this.owners.delete(t.collider!.handle)
      this.world.removeRigidBody(t.body)
      t.body = null
      t.collider = null
    }
    t.holder = d.id
    t.hand = hand
    t.thrownBy = null
    d.hands[hand] = t.id
    this.emit({ type: 'act', who: d.id, act: 'pick', hand })
    this.callThing(t, 'picked', this.view(d))
    this.emit({ type: 'sound', at: this.handOf(d, hand), sound: 'squeak', pitch: 1.4 })
  }

  /** Makes a thing a loose body at a point, moving at v. */
  private loosen(t: Thing, at: Vec3, v: Vec3): void {
    const b = t.kind.recipe.bounds
    const half: Vec3 = [0, 1, 2].map((i) => clamp((b.max[i]! - b.min[i]!) / 2, 0.06, 1.6)) as Vec3
    const mid: Vec3 = [0, 1, 2].map((i) => (b.max[i]! + b.min[i]!) / 2) as Vec3
    const rb = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(at[0], at[1], at[2]).setLinvel(v[0], v[1], v[2]).setCcdEnabled(true).setAngularDamping(0.8))
    const volume = 8 * half[0] * half[1] * half[2]
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(half[0], half[1], half[2])
        .setTranslation(mid[0], mid[1], mid[2])
        .setDensity(clamp(2 / Math.max(volume, 1e-3), 1, 2000))
        .setFriction(0.8)
        .setRestitution(0.2)
        .setCollisionGroups(groups(G.THING, G.ARENA | G.BODY | G.CRATE | G.DOCTOR | G.THING))
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      rb,
    )
    t.body = rb
    t.collider = collider
    t.holder = null
    this.own(collider, { kind: 'thing', id: t.id })
  }

  /** Lets go of what is in a hand (both hands, given none). */
  dropHeld(d: Doctor, hand?: Hand): void {
    for (const h of hand === undefined ? HANDS : [hand]) {
      const t = this.inHand(d, h)
      if (!t) continue
      this.letGo(d, t)
      const at = d.alive ? this.handOf(d, h) : add(d.pos, [0, 1, 0])
      this.loosen(t, at, [d.walk[0] * 0.5, 1, d.walk[2] * 0.5])
      this.callThing(t, 'dropped')
    }
  }

  /** The hand that held a thing is empty again. */
  private letGo(d: Doctor, t: Thing): void {
    if (d.hands[t.hand] === t.id) d.hands[t.hand] = null
    if (d.riding === t.id) d.riding = null
  }

  private throwHeld(d: Doctor, hand: Hand): void {
    const t = this.inHand(d, hand)
    if (!t) return
    const aim = aimOf(d.yaw, d.pitch)
    const from = this.handOf(d, hand)
    this.letGo(d, t)
    this.loosen(t, from, add(add(scale(aim, THROW_SPEED), [0, 2.5, 0]), d.walk))
    t.thrownBy = d.id
    t.thrownAt = this.time
    t.body!.setAngvel({ x: 6 + this.random() * 4, y: this.random() * 4, z: 0 }, true)
    this.emit({ type: 'sound', at: from, sound: 'whoosh', pitch: 0.8 })
    this.callThing(t, 'thrown')
  }

  removeThing(t: Thing): void {
    if (t.dead) return
    t.dead = true
    if (t.holder) {
      const d = this.doctors.get(t.holder)
      if (d) this.letGo(d, t)
    }
    if (t.body) {
      this.owners.delete(t.collider!.handle)
      this.world.removeRigidBody(t.body)
    }
    for (const z of this.zones) if (z.owner === t.id) z.dead = true
    for (const f of this.fields) if (f.owner === t.id) f.dead = true
    for (const x of this.ties) if (x.owner === t.id) x.dead = true
    for (const b of this.bodies.values()) if (b.owner === t.id && b.until > this.time + 3) b.until = this.time + 3
    this.things.delete(t.id)
  }

  private pick(d: Doctor): void {
    let crate: Crate | null = null
    let best = CRATE_REACH
    for (const c of this.crates.values()) {
      const dist = len(sub(c.p, add(d.pos, [0, 0.5, 0])))
      if (this.mayOpen(c, d) && dist < best) {
        best = dist
        crate = c
      }
    }
    if (crate) return this.openCrate(crate, d)
    let thing: Thing | null = null
    best = PICK_REACH
    for (const t of this.things.values()) {
      if (t.holder || !t.body) continue
      const dist = len(sub(v3(t.body.translation()), add(d.pos, [0, 0.6, 0])))
      if (dist < best) {
        best = dist
        thing = t
      }
    }
    if (thing) return this.give(d, thing)
    // A crate in reach still only its asker's: they are told whose, and for how long.
    const shut = [...this.crates.values()].find((c) => c.state === 'ready' && c.readyAt !== null && !this.mayOpen(c, d) && len(sub(c.p, add(d.pos, [0, 0.5, 0]))) < CRATE_REACH)
    if (shut) this.emit({ type: 'notYet', who: d.id, owner: shut.owner, secs: Math.ceil(shut.readyAt! + CRATE_OWNER_ONLY - this.time) })
  }

  /**
   * A doctor touching down at a speed: a hard landing costs credibility, put down to the last blow
   * of the last few seconds and charged to its thing's budget (a fall they were knocked into is
   * the knock's). A made thing that makes them jump higher makes landings from its own jumps safe.
   */
  private landed(d: Doctor, speed: number, jump: number): void {
    const safe = FALL_SAFE * Math.sqrt(Math.max(1, jump))
    if (speed <= safe) return
    const blow = this.blowWithin(d, LANDING_BLAME) ?? { attacker: null, thing: null, fists: null }
    this.harm(d, (speed - safe) * FALL_HURT, { ...blow, what: 'a fall' })
  }

  // ---------------------------------------------------------------------------- crates

  /**
   * A crate for a player and the words they asked in (null: the random button), coming in a few
   * metres from them where they can walk to it (`crateSpot`): where they look if it can, else all
   * round them, nearer if nothing farther will do, and failing that where they stand (they are put
   * aside when it arrives). Until it has come in it is only a sight: nothing touches it. Null when
   * the player is not in the round.
   */
  dropCrate(ownerId: string, ask: string | null): Crate | null {
    const d = this.doctors.get(ownerId)
    if (!d || !d.alive) return null
    let at: Vec3 | null = null
    for (let k = 0; k < 32 && !at; k++) {
      // crateSpot's angle runs from +x toward +z; yaw from +z toward +x.
      const angle = k < 8 ? Math.PI / 2 - d.yaw + (this.random() - 0.5) * 2 * CRATE_FRONT : this.random() * Math.PI * 2
      at = this.crateSpot(d, angle, k < 24 ? 2.5 + this.random() * 2.5 : 1.3 + this.random() * 1.2)
    }
    at ??= [d.pos[0], (this.groundBelow([d.pos[0], d.pos[1] + 1, d.pos[2]], 1 + CRATE_DROP)?.y ?? d.pos[1]) + CRATE_HALF + 0.02, d.pos[2]]
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(at[0], at[1], at[2]))
    const collider = this.world.createCollider(RAPIER.ColliderDesc.cuboid(CRATE_HALF, CRATE_HALF, CRATE_HALF).setCollisionGroups(groups(G.CRATE, ALL)), body)
    collider.setEnabled(false)
    // Cut by characters, not UTF-16 units, so no emoji is split in half.
    const words = ask === null ? null : [...ask.trim()]
    const c: Crate = {
      id: this.nextId('c'),
      owner: ownerId,
      body,
      p: at,
      state: 'arriving',
      arrived: 0,
      kind: null,
      ask: words === null ? null : words.length <= ASK_SHOWN ? words.join('') : `${words.slice(0, ASK_SHOWN - 1).join('')}…`,
      made: null,
      readyAt: null,
    }
    this.own(collider, { kind: 'crate', id: c.id })
    this.crates.set(c.id, c)
    this.emit({ type: 'sound', at: [...at], sound: 'hum', pitch: 0.7, volume: 0.7 })
    return c
  }

  /**
   * Where a crate can come in for a doctor, r metres off at an angle, so that they can walk to it:
   * nothing of the arena across the way at chest height (nor just past it), a floor there flat
   * enough to stand on, at most a jump above their feet and a short drop below, and room for the
   * crate, clear of the arena, of doctors and of other crates. Its middle, or null.
   */
  private crateSpot(d: Doctor, angle: number, r: number): Vec3 | null {
    const chest = d.pos[1] + 1.2 * d.size
    const dir: Vec3 = [Math.cos(angle), 0, Math.sin(angle)]
    const x = d.pos[0] + dir[0] * r
    const z = d.pos[2] + dir[2] * r
    if (!this.clear([d.pos[0], chest, d.pos[2]], [x + dir[0] * (CRATE_HALF + 0.1), chest, z + dir[2] * (CRATE_HALF + 0.1)])) return null
    const floor = this.groundBelow([x, chest, z], chest - d.pos[1] + CRATE_DROP)
    if (!floor?.flat || floor.y > d.pos[1] + CRATE_RISE) return null
    const mid: Vec3 = [x, floor.y + CRATE_HALF + 0.02, z]
    for (const o of this.crates.values()) if (Math.abs(o.p[0] - x) < 2 * CRATE_HALF + 0.2 && Math.abs(o.p[2] - z) < 2 * CRATE_HALF + 0.2 && Math.abs(o.p[1] - mid[1]) < 2 * CRATE_HALF) return null
    const box = new RAPIER.Cuboid(CRATE_HALF - 0.01, CRATE_HALF - 0.01, CRATE_HALF - 0.01)
    const hit = this.world.intersectionWithShape({ x: mid[0], y: mid[1], z: mid[2] }, { x: 0, y: 0, z: 0, w: 1 }, box, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(ALL, G.ARENA | G.DOCTOR | G.CRATE))
    return hit ? null : mid
  }

  /** A crate's thing has come, and how (designed from the words, or from the archive): one that has come in turns ready. */
  fillCrate(id: string, kind: ThingKind, made: Made): void {
    const c = this.crates.get(id)
    if (!c) return
    c.kind = kind
    c.made = made
    this.useKind(kind)
    if (c.state === 'waiting') {
      c.state = 'ready'
      c.readyAt = this.live ? this.time : null
      this.emit({ type: 'sound', at: [...c.p], sound: 'ring', pitch: 1.5 })
    }
  }

  /** Whether a doctor may open a crate now: it is ready, and theirs or ready for CRATE_OWNER_ONLY seconds of a live round. */
  mayOpen(c: Crate, d: Doctor): boolean {
    return c.state === 'ready' && (c.owner === d.id || (c.readyAt !== null && this.time >= c.readyAt + CRATE_OWNER_ONLY))
  }

  /** The round goes live: a crate that turned ready in the countdown, when nobody could open it, is its asker's alone from now. */
  goLive(): void {
    this.live = true
    for (const c of this.crates.values()) if (c.state === 'ready') c.readyAt ??= this.time
  }

  private openCrate(c: Crate, d: Doctor): void {
    this.crates.delete(c.id)
    this.owners.delete(c.body.collider(0).handle)
    this.world.removeRigidBody(c.body)
    this.emit({ type: 'burst', at: [...c.p], color: '#c8a26a', size: 1, count: 18, glow: false })
    this.emit({ type: 'sound', at: [...c.p], sound: 'crunch', pitch: 1 })
    const t = this.newThing(c.kind!, d, c.p)
    const made = c.made!
    const genie = !made.archive && made.genie
    const again = made.archive ? null : made.again
    t.origin = { by: c.owner, ask: c.ask, genie, again, archive: made.archive }
    this.emit({
      type: 'opened',
      crate: c.id,
      by: d.id,
      owner: c.owner,
      thing: t.kind.name,
      ask: c.ask,
      genie,
      again,
      archive: made.archive,
      curse: made.archive ? null : made.curse,
    })
  }

  /** The floor straight below a point: its height, whether it is flat enough to stand on, and the breakable piece it is part of (or null). */
  groundBelow(from: Vec3, max: number): { y: number; flat: boolean; piece: string | null } | null {
    const hit = this.world.castRayAndGetNormal(new RAPIER.Ray({ x: from[0], y: from[1], z: from[2] }, { x: 0, y: -1, z: 0 }), max, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(ALL, G.ARENA))
    if (!hit) return null
    const o = this.owners.get(hit.collider.handle)
    return { y: from[1] - hit.timeOfImpact, flat: hit.normal.y > 0.75, piece: o?.kind === 'arena' ? o.piece : null }
  }

  /** Whether nothing of the arena lies on the straight line between two points. */
  clear(from: Vec3, to: Vec3): boolean {
    const dir = sub(to, from)
    const dist = len(dir)
    if (dist < 1e-6) return true
    const d = scale(dir, 1 / dist)
    return !this.world.castRay(new RAPIER.Ray({ x: from[0], y: from[1], z: from[2] }, { x: d[0], y: d[1], z: d[2] }), dist, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(ALL, G.ARENA))
  }

  /** The doctor a ray from a point first meets (walls in the way stop it), leaving one doctor out. */
  rayToDoctor(from: Vec3, dir: Vec3, max: number, leaveOut: Doctor): string | null {
    const d = norm(dir)
    const hit = this.world.castRay(new RAPIER.Ray({ x: from[0], y: from[1], z: from[2] }, { x: d[0], y: d[1], z: d[2] }), max, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(ALL, G.ARENA | G.DOCTOR | G.CRATE), leaveOut.collider)
    if (!hit) return null
    const o = this.owners.get(hit.collider.handle)
    return o?.kind === 'doctor' ? o.id : null
  }

  private stepCrate(c: Crate, dt: number): void {
    if (c.state !== 'arriving') return
    c.arrived = Math.min(1, c.arrived + dt / CRATE_WARP)
    if (c.arrived < 1) return
    c.state = c.kind ? 'ready' : 'waiting'
    if (c.kind && this.live) c.readyAt = this.time
    // Whoever stands where it comes in is put aside, the shortest way out, or onto it when a wall is that way.
    for (const d of this.doctors.values()) {
      if (!d.alive || d.rag) continue
      const r = RADIUS * d.size
      const dx = d.pos[0] - c.p[0]
      const dz = d.pos[2] - c.p[2]
      const reach = CRATE_HALF + r + 0.05
      if (Math.abs(dx) >= reach || Math.abs(dz) >= reach || d.pos[1] >= c.p[1] + CRATE_HALF || d.pos[1] + 2 * CENTER * d.size <= c.p[1] - CRATE_HALF) continue
      const alongX = reach - Math.abs(dx) < reach - Math.abs(dz)
      const to: Vec3 = alongX ? [c.p[0] + Math.sign(dx || 1) * reach, d.pos[1], d.pos[2]] : [d.pos[0], d.pos[1], c.p[2] + Math.sign(dz || 1) * reach]
      const chest: Vec3 = [0, CENTER * d.size, 0]
      this.teleport(d, this.clear(add(d.pos, chest), add(to, chest)) ? to : [d.pos[0], c.p[1] + CRATE_HALF + 0.02, d.pos[2]])
    }
    c.body.collider(0).setEnabled(true)
    this.emit({ type: 'sound', at: [...c.p], sound: 'teleport', pitch: 0.8 })
    this.emit({ type: 'burst', at: [...c.p], color: '#7fc8ff', size: 0.5, count: 24, glow: true, speed: 3, secs: 0.6 })
  }

  // ---------------------------------------------------------------------------- bodies and zones

  bodiesOf(owner: string): number {
    let n = 0
    for (const b of this.bodies.values()) if (b.owner === owner) n++
    return n
  }

  removeBody(b: Body): void {
    if (!this.bodies.has(b.id)) return
    b.gone = v3(b.rb.translation())
    this.bodies.delete(b.id)
    this.owners.delete(b.collider.handle)
    this.world.removeRigidBody(b.rb)
    for (const z of this.zones) if (z.follow?.kind === 'body' && z.follow.id === b.id) z.dead = true
  }

  /** The made-code view of what a collider is. */
  private target(o: Owner | undefined, point: Vec3, vel: Vec3): HitTarget {
    const t: HitTarget = { doctor: null, body: null, arena: false, thing: false, crate: false, point: rv(point), speed: r3(len(vel)), vel: rv(vel) }
    if (!o) return t
    if (o.kind === 'doctor') {
      const d = this.doctors.get(o.id)
      if (d) t.doctor = this.view(d)
    } else if (o.kind === 'body') t.body = this.bodies.get(o.id)?.handle ?? null
    else if (o.kind === 'arena') t.arena = true
    else if (o.kind === 'thing') t.thing = true
    else t.crate = true
    return t
  }

  private collide(h1: number, h2: number): void {
    const a = this.owners.get(h1)
    const b = this.owners.get(h2)
    this.touch(a, b)
    this.touch(b, a)
    this.impact(a, b)
    strike(this, a, b)
    strike(this, b, a)
  }

  /** When something struck last, so a bouncing body is not heard every step. */
  private readonly struck = new Map<string, number>()

  /** A body or a loose thing striking something hard enough to be heard: an impact for the pages to sound by what it struck. */
  private impact(a: Owner | undefined, b: Owner | undefined): void {
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      let at: Vec3
      let speed: number
      let mass: number
      let id: string
      if (x?.kind === 'body') {
        const body = this.bodies.get(x.id)
        if (!body || !body.solid || body.stuck) continue
        speed = Math.max(len(body.vel), len(body.velBefore))
        mass = body.rb.mass()
        at = v3(body.rb.translation())
        id = body.id
      } else if (x?.kind === 'thing') {
        const t = this.things.get(x.id)
        if (!t?.body) continue
        speed = Math.max(t.speed, t.speedBefore)
        mass = t.body.mass()
        at = v3(t.body.translation())
        id = t.id
      } else continue
      if (speed < 2.5 || this.time - (this.struck.get(id) ?? -1) < 0.12) continue
      this.struck.set(id, this.time)
      if (this.struck.size > 500) this.struck.clear()
      const on = y?.kind === 'arena' ? y.material : y?.kind === 'doctor' ? 'flesh' : 'object'
      this.emit({ type: 'impact', at: rv(at), speed: r3(speed), mass: r3(mass), on })
      return
    }
  }

  private touch(a: Owner | undefined, b: Owner | undefined): void {
    if (!a) return
    if (a.kind === 'body') {
      const body = this.bodies.get(a.id)
      if (!body) return
      if (b?.kind === 'doctor' && b.id === body.spares && this.time - body.born < 0.25) return
      if (b?.kind === 'doctor' && body.stuck?.kind === 'doctor' && body.stuck.id === b.id) return
      // How it came in: the fastest of its velocities over the last steps (the contact may already have turned it).
      const now = v3(body.rb.linvel())
      const came = [body.vel, body.velBefore, now].reduce((a, b) => (len(b) > len(a) ? b : a))
      if (b?.kind === 'doctor') {
        const d = this.doctors.get(b.id)
        if (d) momentum(this, body, d, came)
      }
      if (typeof body.hit !== 'function') return
      const r = call(body.hit, null, this.target(b, v3(body.rb.translation()), came), body.handle)
      if (!r.ok) {
        this.madeError(`body of ${body.source.what}`, r.error)
        this.removeBody(body)
      }
    } else if (a.kind === 'thing' && b?.kind === 'doctor') {
      const t = this.things.get(a.id)
      const d = this.doctors.get(b.id)
      if (!t?.body || !d || !t.thrownBy || this.time - t.thrownAt > 2) return
      if (d.id === t.thrownBy && this.time - t.thrownAt < 0.4) return
      const v = v3(t.body.linvel())
      if (Math.max(t.speed, t.speedBefore, len(v)) < 4) return
      this.harm(d, THROWN_DAMAGE, { attacker: t.thrownBy, thing: t, fists: null, what: t.kind.name })
      this.knock(d, add(scale(norm([v[0], 0, v[2]]), 6), [0, 3, 0]))
      this.emit({ type: 'sound', at: [...d.pos], sound: 'thud', pitch: 1.3 })
      t.thrownBy = null
    }
  }

  private zoneCenter(z: Zone): Vec3 | null {
    const f = z.follow
    if (!f) return z.at
    if (f.kind === 'body') {
      const b = this.bodies.get(f.id)
      return b ? add(v3(b.rb.translation()), z.at) : null
    }
    if (f.kind === 'mover') {
      const m = this.arena?.movers.get(f.id)
      return m ? add(v3(m.rb.translation()), z.at) : null
    }
    const t = f.thing
    if (t.dead) return null
    if (t.holder) {
      const d = this.doctors.get(t.holder)!
      const fwd = forwardOf(d.yaw)
      const right = rightOf(d.yaw)
      // Offsets are in the holder's frame: x to its right, y up from its feet, z ahead.
      return [d.pos[0] + right[0] * z.at[0] + fwd[0] * z.at[2], d.pos[1] + z.at[1], d.pos[2] + right[2] * z.at[0] + fwd[2] * z.at[2]]
    }
    return t.body ? add(v3(t.body.translation()), z.at) : null
  }

  private stepZones(dt: number): void {
    for (const z of this.zones) {
      if (z.dead) continue
      if (z.until < this.time) {
        z.dead = true
        continue
      }
      const c = this.zoneCenter(z)
      if (!c) {
        z.dead = true
        continue
      }
      for (const d of this.doctors.values()) {
        const mid: Vec3 = [d.pos[0], d.pos[1] + CENTER * d.size, d.pos[2]]
        const rel = sub(mid, c)
        const reach = (RADIUS + HALF * 0.5) * d.size
        const inside =
          d.alive &&
          !(z.follow?.kind === 'holder' && z.follow.thing.holder === d.id) &&
          (z.shape.kind === 'ball' ? len(rel) < z.shape.radius + reach * 0.5 : Math.abs(rel[0]) < z.shape.half[0] + RADIUS && Math.abs(rel[1]) < z.shape.half[1] + reach && Math.abs(rel[2]) < z.shape.half[2] + RADIUS)
        const was = z.inside.has(d.id)
        const fn = inside ? (was ? z.stay : z.enter) : was ? z.exit : null
        if (inside) z.inside.add(d.id)
        else z.inside.delete(d.id)
        if (fn === null || z.dead) continue
        const r = call(fn, null, this.view(d), dt)
        if (!r.ok) {
          this.madeError(`zone of ${z.source.what}`, r.error)
          z.dead = true
        }
      }
    }
    if (this.zones.some((z) => z.dead)) this.zones.splice(0, this.zones.length, ...this.zones.filter((z) => !z.dead))
  }

  // ---------------------------------------------------------------------------- the step

  step(): void {
    const dt = DT
    this.time += dt
    const arena = this.arena
    if (arena) {
      for (const m of arena.movers.values()) {
        if (typeof m.move !== 'function') continue
        const r = call<{ at?: unknown; rot?: unknown } | undefined>(m.move, null, this.time)
        if (!r.ok) {
          this.arenaError(r.error)
          m.move = null
          m.lastAt = m.at
          m.lastRot = m.rot
          continue
        }
        const pose = r.value
        const at = finiteVec(pose?.at) ?? m.at
        const rot = finiteVec(pose?.rot) ?? m.rot
        m.lastAt = m.at
        m.lastRot = m.rot
        // A mover that jumps (a teleporting platform) carries nobody along.
        if (len(sub(at, m.at)) > 40 * dt) m.lastAt = at
        m.at = at
        m.rot = rot
        m.rb.setNextKinematicTranslation({ x: at[0], y: at[1], z: at[2] })
        m.rb.setNextKinematicRotation(eulerQuat(rot))
      }
    }
    this.shown = 0
    stepTies(this, dt)
    stepFields(this, dt)
    if (this.ties.some((t) => t.dead)) this.ties.splice(0, this.ties.length, ...this.ties.filter((t) => !t.dead))
    if (this.fields.some((f) => f.dead)) this.fields.splice(0, this.fields.length, ...this.fields.filter((f) => !f.dead))
    for (const d of this.doctors.values()) this.stepDoctor(d, dt)
    for (const t of [...this.things.values()]) {
      if (t.dead) continue
      this.callThing(t, 'tick', dt)
      if (t.body && t.body.translation().y < (arena?.floor ?? -30) - 20) this.removeThing(t)
      else if (t.spent && this.time - t.spent.t > SPENT_MIN && (this.time - t.spent.t > SPENT_MAX || !this.playing(t))) this.removeThing(t)
    }
    for (const b of [...this.bodies.values()]) {
      if (this.time > b.until || b.rb.translation().y < (arena?.floor ?? -30) - 20) {
        this.removeBody(b)
        continue
      }
      if (b.spares && this.time - b.born > 0.25) {
        b.spares = null
      }
      if (typeof b.tick === 'function') {
        const r = call(b.tick, null, b.handle, dt)
        if (!r.ok) {
          this.madeError(`body of ${b.source.what}`, r.error)
          this.removeBody(b)
        }
      }
    }
    stepRubble(this)
    for (const s of [...this.sights.values()]) {
      if (this.time > s.until) {
        // The page lets it go by its own clock.
        this.sights.delete(s.id)
        continue
      }
      if (typeof s.tick === 'function') {
        const r = call(s.tick, null, s.handle, dt)
        if (!r.ok) {
          this.madeError('a sight', r.error)
          s.tick = null
        }
      }
    }
    for (const c of this.crates.values()) this.stepCrate(c, dt)
    for (const b of this.bodies.values()) {
      const v = b.rb.linvel()
      b.velBefore = b.vel
      b.vel = [v.x, v.y, v.z]
    }
    for (const t of this.things.values()) {
      if (!t.body) continue
      const v = t.body.linvel()
      t.speedBefore = t.speed
      t.speed = Math.hypot(v.x, v.y, v.z)
    }
    if (arena) {
      for (let i = 0; i < arena.every.length; i++) {
        const fn = arena.every[i]
        if (typeof fn !== 'function') continue
        const r = call(fn, null, dt)
        if (!r.ok) {
          this.arenaError(r.error)
          arena.every[i] = null
        }
      }
    }
    stepStuck(this)
    this.world.step(this.queue)
    // Bodies that face where they fly turn with their flight.
    for (const b of this.bodies.values()) {
      if (!b.face || b.stuck) continue
      const v = v3(b.rb.linvel())
      const l = len(v)
      if (l > 0.3) b.rb.setRotation(quatOf(Math.atan2(v[0], v[2]), Math.asin(clamp(v[1] / l, -1, 1))), false)
    }
    this.queue.drainCollisionEvents((h1, h2, started) => {
      if (started) this.collide(h1, h2)
    })
    this.sweep(dt)
    this.stepZones(dt)
    for (const e of this.reshows.values()) this.events.push(e)
    this.reshows.clear()
  }

  /** A mover that moves into a doctor pushes them out along its own motion at that point. */
  private sweep(dt: number): void {
    const arena = this.arena
    if (!arena || arena.movers.size === 0) return
    for (const d of this.doctors.values()) {
      if (!d.alive || d.rag) continue
      const center = { x: d.pos[0], y: d.pos[1] + CENTER * d.size, z: d.pos[2] }
      const hit = new Set<string>()
      this.world.intersectionsWithShape(
        center,
        { x: 0, y: 0, z: 0, w: 1 },
        new RAPIER.Capsule(HALF * d.size, RADIUS * d.size * 0.9),
        (c) => {
          const o = this.owners.get(c.handle)
          if (o?.kind === 'arena' && o.mover) hit.add(o.mover)
          return true
        },
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        groups(ALL, G.ARENA),
        d.collider,
      )
      for (const id of hit) {
        if (id === d.on) continue
        const v = moverVelocity(arena.movers.get(id)!, [center.x, center.y, center.z], dt)
        const speed = len(v)
        if (speed < 0.05) continue
        // Out of its way at once, and a knock as hard as it was going.
        this.teleport(d, add(d.pos, scale(v, dt * 1.5)))
        this.knock(d, [v[0], Math.max(v[1], speed > 3 ? 2.5 : 0), v[2]])
      }
    }
  }

  arenaError(error: string): void {
    this.madeError('arena', error)
    if (this.arena) this.arena.errors++
  }

  // ---------------------------------------------------------------------------- what goes out

  snapshot(): Snap {
    const doctors: DoctorSnap[] = [...this.doctors.values()].map((d) => ({
      id: d.id,
      p: rv(d.pos),
      yaw: r3(d.yaw),
      pitch: r3(d.pitch),
      cred: d.cred,
      alive: d.alive,
      hands: [d.hands[0], d.hands[1]],
      writing: d.writing,
      riding: d.riding,
      disguise: this.inHand(d, 0)?.disguise ?? this.inHand(d, 1)?.disguise ?? null,
      size: r3(d.size),
      hurt: r3(this.time - d.hurtAt),
      grounded: d.grounded,
      floor: d.rag ? null : d.floor,
      rag: d.rag ? d.rag.snap() : null,
      fx: this.fxSnap(d),
    }))
    const things: ThingSnap[] = [...this.things.values()].filter((t) => !t.spent).map((t) => {
      let p: Vec3
      let q: Quat
      if (t.holder) {
        const d = this.doctors.get(t.holder)!
        p = rv(d.riding === t.id ? d.pos : this.handOf(d, t.hand))
        q = rq(quatOf(d.yaw, d.riding === t.id ? 0 : d.pitch))
      } else {
        p = rv(v3(t.body!.translation()))
        q = rq(t.body!.rotation())
      }
      return { id: t.id, kind: t.kind.id, holder: t.holder, p, q, poses: Object.keys(t.poses).length ? t.poses : null, scale: t.scale }
    })
    const bodies: BodySnap[] = [...this.bodies.values()].map((b) => ({
      id: b.id,
      model: b.model,
      prim: b.prim,
      p: rv(v3(b.rb.translation())),
      q: rq(b.rb.rotation()),
      scale: r3(b.scale * b.k),
      poses: Object.keys(b.poses).length ? b.poses : null,
      trail: b.trail,
    }))
    const crates: CrateSnap[] = [...this.crates.values()].map((c) => ({
      id: c.id,
      p: rv(c.p),
      owner: c.owner,
      state: c.state,
      arrived: Math.round(c.arrived * 100) / 100,
      ask: c.ask,
      archive: c.made !== null && c.made.archive,
      ownerUntil: c.readyAt === null ? null : r3(c.readyAt + CRATE_OWNER_ONLY),
    }))
    const movers: MoverSnap[] = this.arena ? [...this.arena.movers.values()].map((m) => ({ id: m.id, p: rv(v3(m.rb.translation())), q: rq(m.rb.rotation()) })) : []
    const end = (r: TieRef): TieEnd => (r.kind === 'point' ? { kind: 'point', p: rv(r.p) } : { kind: r.kind, id: r.id })
    const ties: TieSnap[] = this.ties.filter((t) => !t.dead).map((t) => ({ id: t.id, a: end(t.a), b: end(t.b), length: r3(t.length), spring: t.spring > 0, color: t.color, width: t.width }))
    const events = this.events
    this.events = []
    return { t: r3(this.time), doctors, things, bodies, crates, movers, ties, events }
  }

  private fxSnap(d: Doctor): DoctorFx | null {
    if (!d.alive || (d.effects.length === 0 && !d.pinned)) return null
    const f = this.fx(d)
    const held = holds(f) || d.pinned
    return f.shake > 0 || f.glow || f.wear.length || f.blind > 0 || held ? { shake: r3(f.shake), glow: f.glow, wear: f.wear, blind: r3(f.blind), tint: f.tint, held } : null
  }

  /** Sizes a body's collider as its resize says. */
  shapeBody(b: Body): void {
    const [x, y, z] = b.size.map((v) => clamp(v * b.k, 0.02, 16)) as Vec3
    const c = b.collider
    if (b.shape === 'box') c.setHalfExtents({ x: x / 2, y: y / 2, z: z / 2 })
    else if (b.shape === 'capsule') {
      c.setHalfHeight(Math.max(0.01, y / 2 - x / 2))
      c.setRadius(x / 2)
    } else if (b.shape === 'cylinder') {
      c.setHalfHeight(y / 2)
      c.setRadius(x / 2)
    } else c.setRadius(x / 2)
    c.setTranslationWrtParent({ x: b.mid[0] * b.k, y: b.mid[1] * b.k, z: b.mid[2] * b.k })
  }

  /** What only this player sees, from the sim's side. */
  me(id: string): Pick<Me, 'curse' | 'hands'> {
    const d = this.doctors.get(id)
    if (!d) return { curse: null, hands: [null, null] }
    const info = (t: Thing | null): HeldInfo | null => (t ? { name: t.kind.name, description: t.kind.description, budget: t.kind.budget, left: t.left, origin: t.origin } : null)
    return {
      curse: d.curse ? { text: d.curse.text, by: d.curse.by } : null,
      hands: [info(this.inHand(d, 0)), info(this.inHand(d, 1))],
    }
  }

  alive(): Doctor[] {
    return [...this.doctors.values()].filter((d) => d.alive)
  }

  free(): void {
    this.world.free()
    this.queue.free()
  }
}

/** A list of three finite numbers, or null. */
export function finiteVec(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || v.length < 3) return null
  const out = [Number(v[0]), Number(v[1]), Number(v[2])]
  return out.every(Number.isFinite) ? (out.map((x) => clamp(x, -500, 500)) as Vec3) : null
}

/** A vector turned by Euler angles (XYZ, the order three.js and the arena use), or back again. */
function turn(v: Vec3, rot: Vec3, back: boolean): Vec3 {
  const q = eulerQuat(rot)
  const [x, y, z] = back ? [-q.x, -q.y, -q.z] : [q.x, q.y, q.z]
  const w = q.w
  // v + 2 * cross(q, cross(q, v) + w v)
  const cx = y * v[2] - z * v[1] + w * v[0]
  const cy = z * v[0] - x * v[2] + w * v[1]
  const cz = x * v[1] - y * v[0] + w * v[2]
  return [v[0] + 2 * (y * cz - z * cy), v[1] + 2 * (z * cx - x * cz), v[2] + 2 * (x * cy - y * cx)]
}

/** How fast a point riding on a mover moves now, turning included. */
export function moverVelocity(m: Mover, p: Vec3, dt: number): Vec3 {
  const local = turn(sub(p, m.lastAt), m.lastRot, true)
  const now = add(turn(local, m.rot, false), m.at)
  return scale(sub(now, p), 1 / dt)
}

/** Euler angles (XYZ, radians) as Rapier's quaternion. */
export function eulerQuat(rot: Vec3): { x: number; y: number; z: number; w: number } {
  const [x, y, z] = rot
  const c1 = Math.cos(x / 2)
  const c2 = Math.cos(y / 2)
  const c3 = Math.cos(z / 2)
  const s1 = Math.sin(x / 2)
  const s2 = Math.sin(y / 2)
  const s3 = Math.sin(z / 2)
  return { x: s1 * c2 * c3 + c1 * s2 * s3, y: c1 * s2 * c3 - s1 * c2 * s3, z: c1 * c2 * s3 + s1 * s2 * c3, w: c1 * c2 * c3 - s1 * s2 * s3 }
}
