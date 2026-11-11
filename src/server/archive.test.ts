import { beforeAll, expect, it } from 'vitest'

import { initPhysics, type ThingKind } from '../sim/sim'
import { STARTERS } from '../sim/things'
import { tempDir } from './fakes'
import { Game } from './game'
import { Store } from './store'

beforeAll(async () => {
  await initPhysics()
})

it('compiles a kept thing when it is first drawn from the archive, leaves out one that will not compile, and draws none twice in a match while it has others', () => {
  const store = new Store(tempDir(), () => {})
  store.saveThing({ ...STARTERS[0]!, id: 'broken-spoon', name: 'Broken Spoon', code: 'return {' })
  const logs: string[] = []
  const game = new Game({ designers: null, voice: null, store, log: (m) => logs.push(m), join: [], random: () => 0.999, clock: () => 0 }, false)
  // Nothing is compiled as the game starts.
  expect(game.kinds.size).toBe(0)
  const draw = () => (game as unknown as { fallbackKind(): ThingKind }).fallbackKind()
  // The last kept is drawn first: it will not compile, so the starter before it comes instead, and the broken one never again.
  expect(draw().id).toBe(STARTERS.at(-1)!.id)
  // Nothing comes twice in a match while the archive has something it has not had.
  expect(draw().id).toBe(STARTERS.at(-2)!.id)
  expect(logs.filter((l) => l.includes('would not compile'))).toEqual([expect.stringContaining('thing broken-spoon would not compile')])
  expect([...game.kinds.keys()]).toEqual([STARTERS.at(-1)!.id, STARTERS.at(-2)!.id])
  draw()
  draw()
  // All had: any of them again.
  expect(draw().id).toBe(STARTERS.at(-1)!.id)
  game.close()
})
