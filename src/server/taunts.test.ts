import fs from 'node:fs'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { initPhysics } from '../sim/sim'
import { flush, setup, tempDir } from './fakes'
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

  it('lines.json from before phrases: the taunts not handed out are dropped, the used kept', () => {
    const dir = tempDir()
    const old = { taunts: { used: ['Thy footnotes are damp, sirrah!'], ready: ['Thy index is a ladder.', 'Begone, thou quarto!'] }, titles: { used: ['On Ducks'], ready: ['On Geese'] } }
    fs.writeFileSync(path.join(dir, 'lines.json'), JSON.stringify(old))
    const logs: string[] = []
    const store = new Store(dir, (m) => logs.push(m))
    expect(store.lines.taunts).toEqual({ used: old.taunts.used, ready: [] })
    expect(store.lines.titles).toEqual(old.titles)
    expect(logs.join('\n')).toMatch(/2 taunts/)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'lines.json'), 'utf8'))).toEqual({ ...old, taunts: { used: old.taunts.used, ready: [] } })
    // Once moved on, nothing more is dropped.
    const line: Phrase[] = [{ text: 'Sirrah!', tone: 'indignant' }]
    store.lines.taunts.ready.push(line)
    store.saveLines()
    const again: string[] = []
    expect(new Store(dir, (m) => again.push(m)).lines.taunts.ready).toEqual([line])
    expect(again).toEqual([])
  })
})
