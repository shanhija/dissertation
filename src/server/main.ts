/**
 * The game as the dev server starts it: physics loaded, the library opened
 * (`DISSERTATION_LIBRARY` or library/), the models found, the voice woken (what `npm install`
 * fetched into node_modules/.cache/voice), the game running.
 */

import path from 'node:path'

import { initPhysics } from '../sim/sim'
import { Game } from './game'
import { designersFromEnv } from './opus'
import { Store } from './store'
import { voiceFromDisk } from './voice'

export async function startGame(root: string, log: (message: string) => void, join: string[]): Promise<Game> {
  await initPhysics()
  const store = new Store(process.env.DISSERTATION_LIBRARY ?? path.join(root, 'library'), log)
  log(`library: ${store.things.size} things, ${store.wear.size} worn parts, ${store.arenas.size} arenas`)
  if (join.length) log(`friends join at ${join.join(' or ')}`)
  const t0 = performance.now()
  const voice = voiceFromDisk(path.join(root, 'node_modules', '.cache', 'voice'), log)
  return new Game({ designers: designersFromEnv(log), voice, store, log, join, random: Math.random, clock: () => (performance.now() - t0) / 1000 })
}
