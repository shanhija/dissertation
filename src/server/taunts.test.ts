import fs from 'node:fs'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { initPhysics } from '../sim/sim'
import { FakeDesigners, flush, setup, tempDir } from './fakes'
import { Game } from './game'
import { linesMessage, TAUNT_STYLE } from './prompts'
import { Store } from './store'
import type { Phrase, Speech, Voice } from './voice'

beforeAll(async () => {
  await initPhysics()
})

/** A voice that says every line in `secs` seconds and keeps what it was asked. */
class TimedVoice implements Voice {
  asked: Phrase[][] = []
  constructor(private readonly secs: number) {}
  async say(phrases: Phrase[]): Promise<Speech> {
    this.asked.push(phrases)
    return { mp3: '', tones: phrases.map((p) => p.tone), secs: this.secs, ms: 1 }
  }
  close(): void {}
}

/** A game with no models (taunts come from the game's own) and one player, Alice, pressing V at the given times. */
async function pressAt(voice: Voice | null, times: number[]): Promise<{ heard: number[]; store: Store }> {
  const { game, store, advance, join } = setup(null, voice)
  const alice = join('Alice')
  await flush()
  const heard: number[] = []
  let now = 0
  for (const at of times) {
    advance(at - now)
    now = at
    const before = alice.conn.got.filter((m) => m.type === 'taunt').length
    alice.send({ type: 'taunt' })
    await flush()
    if (alice.conn.got.filter((m) => m.type === 'taunt').length > before) heard.push(at)
  }
  game.close()
  return { heard, store }
}

describe('taunts', () => {
  it('a doctor cannot taunt again until their line has been said and a moment more', async () => {
    expect((await pressAt(new TimedVoice(3), [0, 1, 3.5, 3.9, 5, 7.8])).heard).toEqual([0, 3.9, 7.8])
    // Only read, a line lasts 0.5 s a word.
    const { heard, store } = await pressAt(null, [0, 0.5, 10])
    expect(heard).toEqual([0, 10])
    // The two heard and the next, taken ahead.
    expect(store.lines.taunts.used).toHaveLength(3)
  })

  it("the game's own lines are said in phrases with tones", async () => {
    const voice = new TimedVoice(1)
    await pressAt(voice, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18])
    expect(voice.asked.length).toBeGreaterThanOrEqual(10)
    for (const line of voice.asked) for (const p of line) expect(p.text).toMatch(/\p{L}/u)
    // Those with a comma come in two phrases, in different tones.
    const two = voice.asked.filter((l) => l.length === 2)
    expect(two.length).toBeGreaterThan(0)
    for (const [a, b] of two) expect(a!.tone).not.toBe(b!.tone)
  })

  it('taunts in lines.json in another style are dropped once, ready and handed out alike, and never listed to Haiku; the titles stay', async () => {
    const dir = tempDir()
    // As the library was before modern English: no style, and a taunt from before phrases still one string.
    const old = {
      taunts: {
        used: ['Thy footnotes are damp, sirrah!', 'Begone, thou quarto!'],
        ready: [[{ text: 'Mind the dean, sirrah,', tone: 'hushed' }, { text: 'thy theorem is damp.', tone: 'booming' }], 'Thy index is a ladder.'],
      },
      titles: { used: ['On Ducks'], ready: ['On Geese'] },
    }
    fs.writeFileSync(path.join(dir, 'lines.json'), JSON.stringify(old))
    const logs: string[] = []
    const store = new Store(dir, (m) => logs.push(m))
    const fresh = { taunts: { style: TAUNT_STYLE, used: [], ready: [] }, titles: old.titles }
    expect(store.lines).toEqual(fresh)
    expect(logs.join('\n')).toMatch(/2 ready and 2 handed out dropped/)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'lines.json'), 'utf8'))).toEqual(fresh)
    // The game's first batch is asked for with nothing listed.
    const designers = new FakeDesigners()
    const game = new Game({ designers, voice: null, store, log: () => {}, join: [], random: Math.random, clock: () => 0 }, false)
    await designers.settled()
    game.close()
    expect(designers.asked.filter((a) => a.kind === 'taunt').map((a) => a.message)).toEqual([linesMessage(12, [])])
    expect(store.lines.taunts.ready).toHaveLength(12)
    // In the style of now, a second load changes nothing.
    const saved = fs.readFileSync(path.join(dir, 'lines.json'), 'utf8')
    const again: string[] = []
    expect(new Store(dir, (m) => again.push(m)).lines).toEqual(store.lines)
    expect(again).toEqual([])
    expect(fs.readFileSync(path.join(dir, 'lines.json'), 'utf8')).toBe(saved)
  })
})
