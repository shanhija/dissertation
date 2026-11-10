/**
 * Things: a design as the library keeps it, compiled into a kind the sim plays, and the trial a
 * new design goes through before it goes into a crate. The game's own four things are written
 * in the same code the designer writes, so they go the same way (and serve when the library is
 * empty and no design is ready in time).
 */

import { BUDGETS, type Budget, type Vec3 } from '../protocol'
import { recipeOf, thingApi } from './api'
import { buildArena } from './arena'
import { LECTURE_HALL } from './hall'
import { compile } from './sandbox'
import { Sim, type Doctor, type ThingKind } from './sim'

export interface ThingDesign {
  id: string
  name: string
  /** One line the holder reads. */
  description: string
  budget: Budget
  /** Model code: the body of function (m). */
  look: string
  /** Thing code: the body of function (me, w), returning its handlers. */
  code: string
  /** The words asked, after any curse was laid on them; empty for a random one. */
  ask: string
  by: string
  random: boolean
  /** Which model designed it, and how long it took. */
  model: string
  ms: number
  made: string
}

/** Compiles a design. Throws a line naming what is wrong. */
export function compileThing(d: ThingDesign): ThingKind {
  if (!BUDGETS.includes(d.budget)) throw new Error(`budget ${String(d.budget)} is not 10 or 20`)
  const look = compile('look', d.look)
  const factory = compile('thing', d.code)
  const { recipe } = recipeOf(look)
  return { id: d.id, name: d.name, description: d.description, budget: d.budget, recipe, factory, models: new Map() }
}

/**
 * Plays a kind in the game's own hall for a few seconds: one doctor holds it and uses it at two
 * others (press, hold, let go, the second use), walks, throws it, and it lies there. Returns the
 * errors its code threw; none means it may go into a crate.
 */
export function trialThing(kind: ThingKind): string[] {
  const sim = new Sim()
  sim.apiFor = thingApi
  buildArena(sim, LECTURE_HALL)
  sim.live = true
  const a = sim.addDoctor('trial-a', 'Trial A', true)
  const b = sim.addDoctor('trial-b', 'Trial B', true)
  const c = sim.addDoctor('trial-c', 'Trial C', true)
  sim.teleport(a, [0, 0.05, 0])
  sim.teleport(b, [0, 0.05, 4])
  sim.teleport(c, [1.5, 0.05, 8])
  const press = (d: Doctor, k: 'use' | 'other' | 'throw') => {
    const n: [number, number] = [...d.input.presses[k]]
    n[0]++
    d.input = { ...d.input, presses: { ...d.input.presses, [k]: n } }
  }
  const steps = (n: number) => {
    for (let i = 0; i < n; i++) sim.step()
  }
  a.input = { ...a.input, yaw: 0, pitch: 0 }
  sim.newThing(kind, a, a.pos)
  try {
    steps(5)
    press(a, 'use')
    steps(20)
    a.input = { ...a.input, hands: [true, false] }
    press(a, 'use')
    steps(60)
    a.input = { ...a.input, hands: [false, false] }
    steps(10)
    press(a, 'other')
    steps(40)
    a.input = { ...a.input, move: [0.3, 1] }
    steps(40)
    a.input = { ...a.input, move: [0, 0], yaw: 0.4, pitch: 0.2 }
    press(a, 'use')
    steps(90)
    press(a, 'throw')
    steps(120)
  } finally {
    sim.free()
  }
  return sim.errors.map((e) => e.error)
}

const design = (id: string, name: string, description: string, budget: Budget, look: string, code: string): ThingDesign => ({ id, name, description, budget, look, code, ask: '', by: '', random: false, model: 'the game', ms: 0, made: '2026-11-09T00:00:00.000Z' })

/** The game's own things. */
export const STARTERS: ThingDesign[] = [
  design(
    'red-pen',
    'Red Pen of Peer Review',
    'Click to strike a line through someone.',
    10,
    `m.cylinder(0.03, 0.03, 0.5, { at: [0, 0, 0.12], rot: [Math.PI / 2, 0, 0], color: '#c0202a' })
m.cone(0.03, 0.08, { at: [0, 0, 0.41], rot: [Math.PI / 2, 0, 0], color: '#f4e9d0' })
m.cylinder(0.035, 0.035, 0.1, { at: [0, 0, -0.14], rot: [Math.PI / 2, 0, 0], color: '#26252b' })`,
    `let last = -10
return {
  use() {
    if (w.time - last < 0.35) return
    last = w.time
    const a = me.aim()
    const hit = w.ray(a.eye, a.dir, 60)
    const end = hit ? hit.point : [a.eye[0] + a.dir[0] * 60, a.eye[1] + a.dir[1] * 60, a.eye[2] + a.dir[2] * 60]
    w.beam(a.from, end, { color: '#e0202a', width: 0.03, secs: 0.15 })
    w.sound(a.from, 'zap', 1.6)
    if (hit && hit.doctor) {
      w.hurt(hit.doctor, 5, { push: 3 })
      w.text(hit.point, 'Citation needed', '#ff6060')
    }
  }
}`,
  ),
  design(
    'thesis-launcher',
    'Bound Thesis Launcher',
    'Lobs a full bound thesis. Heavy, slow and hard to aim; it really hurts.',
    20,
    `m.box(0.16, 0.18, 0.7, { at: [0, 0, 0.15], color: '#5a4632' })
m.cylinder(0.11, 0.11, 0.3, { at: [0, 0.02, 0.5], rot: [Math.PI / 2, 0, 0], color: '#b08a3c' })
m.box(0.06, 0.2, 0.1, { at: [0, -0.15, -0.05], color: '#3a2a20' })`,
    `const book = w.model('book', (m) => {
  m.box(0.4, 0.1, 0.3, { color: '#2a4a7a' })
  m.box(0.38, 0.08, 0.28, { at: [0.012, 0, 0], color: '#f2ead6' })
})
let last = -10
return {
  use() {
    if (w.time - last < 0.9) return
    last = w.time
    const a = me.aim()
    w.sound(a.from, 'whoosh', 0.7)
    w.spawn({ model: book, at: a.from, vel: [a.dir[0] * 22, a.dir[1] * 22 + 3, a.dir[2] * 22], spin: [8, 0, 3], life: 6, bounce: 0.2,
      hit(t) {
        if (t.doctor && t.speed > 6) {
          w.hurt(t.doctor, 10, { push: 8 })
          w.burst(t.point, { color: '#f2ead6', size: 0.6, count: 14 })
          w.sound(t.point, 'thud', 1)
        }
      } })
  }
}`,
  ),
  design(
    'sabbatical-scooter',
    'Sabbatical Scooter',
    'Stand on it and go fast. Its front bumper bites whoever it meets.',
    10,
    `m.box(0.22, 0.06, 0.9, { at: [0, 0.12, 0], color: '#d8402c' })
m.part('wheelFront', { at: [0, 0.08, 0.4] }, () => m.torus(0.07, 0.03, { rot: [0, Math.PI / 2, 0], color: '#26252b' }))
m.part('wheelBack', { at: [0, 0.08, -0.4] }, () => m.torus(0.07, 0.03, { rot: [0, Math.PI / 2, 0], color: '#26252b' }))
m.cylinder(0.03, 0.03, 0.95, { at: [0, 0.6, 0.42], rot: [-0.15, 0, 0], color: '#c4c9d1' })
m.capsule(0.035, 0.45, { at: [0, 1.08, 0.5], rot: [0, 0, Math.PI / 2], color: '#26252b' })
m.box(0.3, 0.12, 0.08, { at: [0, 0.14, 0.5], color: '#f2cf3a' })`,
    `const bitten = {}
let spin = 0
let next = 0
w.zone({ follow: 'holder', at: [0, 0.5, 0.9], radius: 0.7 }, {
  enter(d) {
    if (bitten[d.id] && w.time - bitten[d.id] < 1) return
    bitten[d.id] = w.time
    w.hurt(d, 5, { push: 9 })
    w.sound(d.pos, 'crunch', 1.2)
  }
})
return {
  picked() { me.ride(true) },
  tick(dt) {
    const h = me.holder()
    if (!h) return
    if (w.time > next) {
      w.affect(h, { speed: 1.7, jump: 1.2 }, 1.1)
      next = w.time + 1
    }
    spin += Math.hypot(h.vel[0], h.vel[2]) * dt / 0.07
    me.pose('wheelFront', [spin, 0, 0])
    me.pose('wheelBack', [spin, 0, 0])
  }
}`,
  ),
  design(
    'footnote-grenade',
    'Footnote Grenade',
    'Click to lob one; the next is ready 2 s later. Each goes off a moment after it lands, with a long footnote.',
    20,
    `m.sphere(0.12, { color: '#3a3a3a' })
m.cylinder(0.04, 0.04, 0.06, { at: [0, 0.13, 0], color: '#b08a3c' })
m.torus(0.04, 0.01, { at: [0.05, 0.17, 0], color: '#c4c9d1' })`,
    `let ready = 0
let pending = []
return {
  use() {
    if (w.time < ready) return
    ready = w.time + 2
    const a = me.aim()
    const ball = w.spawn({ shape: 'ball', size: 0.25, color: '#3a3a3a', at: a.from, vel: [a.dir[0] * 14, a.dir[1] * 14 + 4, a.dir[2] * 14], life: 3, bounce: 0.4, trail: '#9a9590' })
    pending.push({ ball, at: w.time + 1.5 })
    w.sound(a.from, 'whoosh', 1.1)
  },
  tick() {
    for (const p of pending) {
      if (w.time < p.at) continue
      p.done = true
      const c = p.ball.pos()
      w.puff(c, { color: '#ff9a30', size: 3, secs: 0.5, glow: true })
      w.puff(c, { color: '#6a6560', size: 4, secs: 2, rise: 1 })
      w.burst(c, { color: '#ffd080', size: 2.5, count: 40, glow: true })
      w.shake(c, 0.6)
      w.sound(c, 'boom', 1.1)
      w.text(c, 'See footnote 1', '#ffd080')
      for (const d of w.near(c, 3.5).doctors) w.hurt(d, 8, { push: 10, from: c })
      p.ball.remove()
    }
    pending = pending.filter((p) => !p.done)
  }
}`,
  ),
]

/** A point for a thing to lie at, for tests. */
export const ORIGIN: Vec3 = [0, 1, 0]
