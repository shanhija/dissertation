import { beforeAll, describe, expect, it, vi } from 'vitest'

import { START_CRED } from '../protocol'
import { initPhysics } from './sim'
import { hall, pair, press } from './testkit'
import { STARTERS, compileThing, trialThing, type ThingDesign } from './things'

// Each thing is tried in the hall, as a design is: seconds on a busy machine.
vi.setConfig({ testTimeout: 30_000 })

beforeAll(async () => {
  await initPhysics()
})

const thing = (id: string, code: string): ThingDesign => ({ ...STARTERS[0]!, id, code })

/** What the API reference in the designer's prompt (server/prompts.ts) says, held to. */
describe('the API reference', () => {
  it('a body, me, w, a sight, a zone, a field and a rope are frozen: code cannot keep its state on them', () => {
    for (const [what, line] of [
      ['a body', 'w.spawn({ at: me.pos(), shape: "ball", size: 0.1 }).hit = 1'],
      ['me', 'me.hit = 1'],
      ['w', 'w.hit = 1'],
      ['a sight', 'w.model("dot", (m) => m.sphere(0.1)); w.show("dot", { at: me.pos() }).hit = 1'],
      ['a zone', 'w.zone({ at: me.pos(), radius: 1 }, {}).hit = 1'],
      ['a field', 'w.field({ at: me.pos(), radius: 1 }).hit = 1'],
      ['a rope', 'w.tie(me, [0, 0, 0]).hit = 1'],
    ]) {
      expect(trialThing(compileThing(thing('frozen', `return { use() { ${line} } }`))).join(' '), what).toMatch(/Cannot add property hit, object is not extensible/)
    }
  })

  it('w.hurt with 0 or less takes nothing and gives nothing back', () => {
    const sim = hall()
    const [a, b] = pair(sim)
    sim.newThing(compileThing(thing('salve', 'return { use() { const o = w.others()[0]; w.hurt(o, 6); w.text([0, 0, 0], "took " + w.hurt(o, -5)) } }')), a, a.pos)
    press(a, 'use')
    const said: string[] = []
    for (let i = 0; i < 10; i++) {
      sim.step()
      for (const e of sim.snapshot().events) if (e.type === 'text') said.push(e.text)
    }
    expect(said).toContain('took 0')
    expect(b.cred).toBe(START_CRED - 6)
  })
})
