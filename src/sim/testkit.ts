/** What the sim's tests share: the lecture hall with things' code, stepping, pressing, and two doctors facing each other. */

import type { Hand } from '../protocol'
import { thingApi } from './api'
import { buildArena } from './arena'
import { LECTURE_HALL } from './hall'
import { Sim, type Doctor } from './sim'

export function hall(): Sim {
  const sim = new Sim(() => 0.5)
  sim.apiFor = thingApi
  buildArena(sim, LECTURE_HALL)
  sim.live = true
  return sim
}

export const steps = (sim: Sim, n: number) => {
  for (let i = 0; i < n; i++) sim.step()
}

/** One press: of a hand's button ('use'), its other use ('alt', shift-click) or its throw; or picking up or jumping. */
export const press = (d: Doctor, k: 'use' | 'alt' | 'throw' | 'pick' | 'jump', hand: Hand = 0) => {
  const p = d.input.presses
  if (k === 'pick' || k === 'jump') {
    d.input = { ...d.input, presses: { ...p, [k]: p[k] + 1 } }
    return
  }
  const key = k === 'alt' ? 'other' : k
  const n: [number, number] = [...p[key]]
  n[hand]++
  d.input = { ...d.input, presses: { ...p, [key]: n } }
}

/** A hand's button held down or let go. */
export const holdDown = (d: Doctor, down: boolean, hand: Hand = 0) => {
  const hands: [boolean, boolean] = [...d.input.hands]
  hands[hand] = down
  d.input = { ...d.input, hands }
}

/** Two doctors on the hall's floor, b `gap` metres ahead of a, a facing b. */
export function pair(sim: Sim, gap = 4): [Doctor, Doctor] {
  const a = sim.addDoctor('a', 'A', false)
  const b = sim.addDoctor('b', 'B', false)
  sim.teleport(a, [0, 0.05, 0])
  sim.teleport(b, [0, 0.05, gap])
  a.input = { ...a.input, yaw: 0, pitch: 0 }
  b.input = { ...b.input, yaw: Math.PI, pitch: 0 }
  steps(sim, 20)
  return [a, b]
}
