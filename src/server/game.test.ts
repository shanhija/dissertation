import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { COUNTDOWN, DESIGN_LIMIT, type ClientMsg, type Profile, type ServerMsg } from '../protocol'
import { initPhysics } from '../sim/sim'
import { STARTERS } from '../sim/things'
import { Game, REJOIN, type Conn } from './game'
import type { Answered, Designers, ModelName } from './opus'
import type { ArenaAnswer, ThingAnswer, WearAnswer } from './prompts'
import { Store } from './store'
import type { Speech, Voice } from './voice'

beforeAll(async () => {
  await initPhysics()
})

const ARENA_CODE = `a.sky({ color: '#223344' })
a.box([40, 1, 40], { at: [0, -0.5, 0], color: '#888888' })
a.box([6, 2, 6], { at: [8, 1, 8], color: '#aa7744' })
a.ramp([3, 2, 5], { at: [8, 1, 2.5], color: '#775533' })
a.mover(() => a.box([3, 0.4, 3]), (t) => ({ at: [-8, 1 + Math.sin(t), -8] }))
for (let i = 0; i < 8; i++) a.spawn([Math.sin(i * 0.785) * 16, 0, Math.cos(i * 0.785) * 16])`

/** Designers that answer at once (or after `delay` ms) with designs that work. */
class FakeDesigners implements Designers {
  delay = 0
  asked: { kind: string; message: string }[] = []
  private n = 0
  private wait<T>(data: T): Promise<Answered<T>> {
    return new Promise((resolve) => setTimeout(() => resolve({ data, model: 'opus', ms: this.delay }), this.delay))
  }
  thing(message: string): Promise<Answered<ThingAnswer>> {
    this.asked.push({ kind: 'thing', message })
    const s = STARTERS[0]!
    return this.wait({ name: `Made Thing ${++this.n}`, description: s.description, budget: 10, look: s.look, code: s.code })
  }
  wear(message: string): Promise<Answered<WearAnswer>> {
    this.asked.push({ kind: 'wear', message })
    return this.wait({ name: 'A tall hat', colors: { coat: '#ff0000' }, parts: [{ slot: 'head', name: 'Tall hat', code: 'm.cylinder(0.12, 0.12, 0.4, { at: [0, 0.3, 0], color: "black" })' }], remove: [] })
  }
  arena(_: unknown, message: string): Promise<Answered<ArenaAnswer>> {
    this.asked.push({ kind: 'arena', message })
    return this.wait({ name: `Test Hall ${++this.n}`, code: ARENA_CODE })
  }
  async lines(kind: 'taunt' | 'title'): Promise<string[]> {
    return Array.from({ length: 12 }, () => `${kind} number ${++this.n}, most silly`)
  }
  next(): ModelName {
    return 'opus'
  }
  close(): void {}
}

/** A voice that says a line at once as "<key>: <line>", holds them while `hold` is set until `release()`, or fails while `fail` is. */
class FakeVoice implements Voice {
  said: { text: string; key: string }[] = []
  hold = false
  fail = false
  private held: (() => void)[] = []
  say(text: string, key: string): Promise<Speech> {
    this.said.push({ text, key })
    if (this.fail) return Promise.reject(new Error('the voice is hoarse'))
    const speech: Speech = { mp3: Buffer.from(`${key}: ${text}`).toString('base64'), tone: 'plain', secs: 2, ms: 1 }
    if (!this.hold) return Promise.resolve(speech)
    return new Promise((resolve) => this.held.push(() => resolve(speech)))
  }
  release(): void {
    for (const r of this.held.splice(0)) r()
  }
  close(): void {}
}

const heardAs = (voice: string | null) => (voice === null ? null : Buffer.from(voice, 'base64').toString())

class FakeConn implements Conn {
  got: ServerMsg[] = []
  closed = false
  send(text: string) {
    this.got.push(JSON.parse(text) as ServerMsg)
  }
  close() {
    this.closed = true
  }
  last<T extends ServerMsg['type']>(type: T): Extract<ServerMsg, { type: T }> | undefined {
    return this.got.filter((m) => m.type === type).at(-1) as Extract<ServerMsg, { type: T }> | undefined
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function setup(designers: Designers | null = new FakeDesigners(), voice: Voice | null = new FakeVoice()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dissertation-test-'))
  dirs.push(dir)
  let t = 0
  const store = new Store(dir, () => {})
  const logs: string[] = []
  const game = new Game({ designers, voice, store, log: (m) => logs.push(m), join: [], random: Math.random, clock: () => t }, false)
  const advance = (secs: number) => {
    for (let i = 0; i < Math.round(secs * 60); i++) {
      t += 1 / 60
      game.tick()
    }
  }
  const join = (name: string) => {
    const conn = new FakeConn()
    const h = game.connect(conn)
    const send = (m: ClientMsg) => h.message(JSON.stringify(m))
    const profile: Profile | null = name ? { name, title: 'On Ducks', look: { height: 1.8, build: 1, skin: '#e8b892', eyes: '#333333', coat: '#ffffff', shirt: '#334455', trousers: '#222222', shoes: '#111111', gait: 'steady', worn: {} } } : null
    send({ type: 'hello', key: `key-${name || 'nameless'}-123456`, profile })
    return { conn, send, close: h.close }
  }
  return { game, store, advance, join, dir, logs }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('the game', () => {
  it('welcomes a player, and a nameless one cannot be ready', async () => {
    const { join, advance } = setup()
    const a = join('')
    expect(a.conn.last('welcome')).toBeDefined()
    expect(a.conn.last('wardrobe')!.parts.length).toBeGreaterThan(5)
    a.send({ type: 'ready', ready: true })
    advance(0.1)
    expect(a.conn.last('lobby')!.lobby.players[0]!.ready).toBe(false)
    expect(a.conn.last('note')!.text).toMatch(/name/)
  })

  it('plays a round once everyone is ready and the arena is built, and the last one standing wins it', async () => {
    const { join, advance, game, store } = setup()
    await flush()
    const a = join('Alice')
    const b = join('Bob')
    advance(0.1)
    expect(a.conn.last('lobby')!.lobby.arena.state).toBe('ready')
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    advance(0.1)
    expect(game.phase).toBe('countdown')
    expect(a.conn.last('arena')!.arena!.name).toMatch(/Test Hall/)
    expect(store.arenas.size).toBe(1)
    // The countdown counts down on every page.
    expect(a.conn.last('lobby')!.lobby.timer).toBe(COUNTDOWN)
    advance(1.1)
    expect(a.conn.last('lobby')!.lobby.timer).toBe(COUNTDOWN - 1)
    advance(COUNTDOWN - 1.4)
    expect(game.phase).toBe('countdown')
    advance(0.5)
    expect(game.phase).toBe('round')
    const snap = a.conn.last('snap')!
    expect(snap.snap.doctors).toHaveLength(2)
    // Bob is knocked out by the rules of harm, one hit a second.
    const sim = game.sim!
    const bob = [...sim.doctors.values()].find((d) => d.name === 'Bob')!
    for (let i = 0; i < 10; i++) {
      sim.harm(bob, 10, { attacker: null, thing: null, what: 'test' })
      advance(1.05)
    }
    expect(['roundEnd', 'dressing']).toContain(game.phase)
    advance(5)
    expect(game.phase).toBe('dressing')
    expect(a.conn.last('lobby')!.lobby.players.find((p) => p.name === 'Alice')!.wins).toBe(1)
  })

  it('everyone ready starts the round in 5 s without waiting for the arena being built; the new one comes next', async () => {
    const designers = new FakeDesigners()
    designers.delay = 150
    const { join, advance, game, store } = setup(designers)
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'settings', settings: { bots: 2, arena: 'academic' } })
    advance(0.1)
    expect(a.conn.last('lobby')!.lobby.arena.state).toBe('building')
    expect(a.conn.last('lobby')!.lobby.players.filter((p) => p.bot).every((p) => p.ready)).toBe(true)
    a.send({ type: 'ready', ready: true })
    advance(0.1)
    expect(game.phase).toBe('dressing')
    b.send({ type: 'ready', ready: true })
    advance(0.1)
    expect(game.phase).toBe('countdown')
    // Nothing kept yet: the game's own hall.
    expect(a.conn.last('arena')!.arena!.name).toBe('The Old Lecture Hall')
    advance(COUNTDOWN)
    expect(game.phase).toBe('round')
    await new Promise((r) => setTimeout(r, 200))
    await flush()
    advance(0.1)
    expect(store.arenas.size).toBe(1)
    expect(a.conn.last('lobby')!.lobby.arena).toMatchObject({ state: 'ready', name: expect.stringMatching(/Test Hall/) })
  })

  it('a player whose page reloads in a round comes back to their own doctor; one who stays away loses it', async () => {
    const { join, advance, game } = setup()
    await flush()
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    advance(COUNTDOWN + 0.5)
    const you = a.conn.last('welcome')!.you
    a.send({ type: 'input', input: { move: [0, 1], yaw: 0, pitch: 0, jump: false, hands: [false, false], presses: { use: [0, 0], other: [0, 0], throw: [0, 0], pick: 0, jump: 0 } } })
    advance(0.5)
    a.close()
    advance(3)
    expect(game.phase).toBe('round')
    const standing = [...game.sim!.doctors.values()].find((d) => d.id === you)!
    const at = [...standing.pos]
    advance(1)
    expect(Math.hypot(standing.pos[0] - at[0]!, standing.pos[2] - at[2]!)).toBeLessThan(0.01)
    const again = join('Alice')
    advance(0.2)
    expect(again.conn.last('welcome')!.you).toBe(you)
    expect(game.sim!.doctors.get(you)!.alive).toBe(true)
    // Bob leaves for good: his doctor goes after REJOIN seconds, and the round goes on.
    b.close()
    advance(REJOIN + 1)
    expect([...game.sim!.doctors.values()].some((d) => d.name === 'Bob')).toBe(false)
  })

  it('a request drops a crate that opens with what the designer made, and the design is kept', async () => {
    const { join, advance, game, store } = setup()
    await flush()
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    advance(COUNTDOWN + 0.5)
    a.send({ type: 'request', text: 'a very long spoon' })
    await flush()
    advance(8)
    const snap = a.conn.last('snap')!
    expect(snap.snap.crates).toHaveLength(1)
    expect(snap.snap.crates[0]!.state).toBe('ready')
    expect(store.things.size).toBe(1)
    expect([...game.kinds.keys()]).toContain([...store.things.keys()][0])
    // A second request waits for the cooldown.
    a.send({ type: 'request', text: 'another' })
    advance(0.1)
    expect(a.conn.last('snap')!.me.note).toMatch(/still coming|Wait/)
  })

  it('a design that takes too long leaves the crate to the archive, and is kept when it comes', async () => {
    const designers = new FakeDesigners()
    const { join, advance, store } = setup(designers)
    await flush()
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    advance(COUNTDOWN + 0.5)
    designers.delay = 50
    a.send({ type: 'request', text: 'something slow' })
    advance(DESIGN_LIMIT + 0.5)
    expect(a.conn.last('snap')!.snap.crates[0]!.state).toBe('ready')
    expect(store.things.size).toBe(0)
    await new Promise((r) => setTimeout(r, 80))
    await flush()
    expect(store.things.size).toBe(1)
  })

  it('a curse travels with the next request', async () => {
    const designers = new FakeDesigners()
    const { join, advance, game } = setup(designers)
    await flush()
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    advance(COUNTDOWN + 0.5)
    const alice = [...game.sim!.doctors.values()].find((d) => d.name === 'Alice')!
    game.sim!.curse(alice, 'Every noun becomes the word duck.', 1)
    a.send({ type: 'request', text: 'a sword' })
    await flush()
    expect(designers.asked.filter((q) => q.kind === 'thing').at(-1)!.message).toMatch(/duck/)
  })

  it('dresses a doctor from words: a new part in the wardrobe, worn, and colours changed', async () => {
    const { join, advance, store } = setup()
    const a = join('Alice')
    a.send({ type: 'dress', text: 'a tall black hat and a red coat' })
    await flush()
    advance(0.1)
    const look = a.conn.last('profile')!.profile.look
    expect(look.coat).toBe('#ff0000')
    expect(look.worn.head).toBe('tall-hat')
    expect(store.wear.has('tall-hat')).toBe(true)
    expect(a.conn.got.some((m) => m.type === 'wardrobe' && m.parts.some((p) => p.id === 'tall-hat'))).toBe(true)
  })

  it('never says the same taunt twice, and an empty title is written for the player', async () => {
    const { join, advance, store } = setup()
    await flush()
    const a = join('Alice')
    const said: string[] = []
    for (let i = 0; i < 6; i++) {
      a.send({ type: 'taunt' })
      advance(4.1)
      await flush()
    }
    for (const m of a.conn.got) if (m.type === 'taunt') said.push(m.text)
    expect(said.length).toBeGreaterThanOrEqual(5)
    expect(new Set(said).size).toBe(said.length)
    expect(store.lines.taunts.used).toEqual(expect.arrayContaining(said))
    for (const m of a.conn.got) if (m.type === 'taunt') expect(heardAs(m.voice)).toBe(`key-Alice-123456: ${m.text}`)
    const b = join('Bob')
    b.send({ type: 'profile', profile: { name: 'Bob', title: '', look: a.conn.last('profile')!.profile.look } })
    await flush()
    expect(b.conn.last('profile')!.profile.title).toMatch(/title number/)
  })

  it("says each player's next taunt in their voice before V is pressed, and a voice that fails still sends the words", async () => {
    const voice = new FakeVoice()
    const { join, advance, logs } = setup(new FakeDesigners(), voice)
    await flush()
    voice.hold = true
    const a = join('Alice')
    const b = join('Bob')
    await flush()
    // Each has a line being said in their own voice already.
    expect(voice.said.map((s) => s.key)).toEqual(['key-Alice-123456', 'key-Bob-123456'])
    a.send({ type: 'taunt' })
    a.send({ type: 'taunt' })
    await flush()
    expect(b.conn.got.filter((m) => m.type === 'taunt')).toHaveLength(0)
    voice.hold = false
    voice.release()
    await flush()
    // One taunt, heard by everyone, in Alice's voice, and her next is being said.
    const heard = b.conn.got.filter((m) => m.type === 'taunt')
    expect(heard).toHaveLength(1)
    expect(heard[0]!.text).toBe(voice.said[0]!.text)
    expect(heardAs(heard[0]!.voice)).toBe(`key-Alice-123456: ${heard[0]!.text}`)
    expect(voice.said.at(-1)!.key).toBe('key-Alice-123456')
    // Her next is ready; the one after fails: it goes out as words, and the log says why.
    voice.fail = true
    advance(4.1)
    a.send({ type: 'taunt' })
    await flush()
    advance(4.1)
    a.send({ type: 'taunt' })
    await flush()
    const later = b.conn.got.filter((m) => m.type === 'taunt').slice(1)
    expect(later.map((m) => m.voice === null)).toEqual([false, true])
    expect(later[1]!.text.length).toBeGreaterThan(5)
    expect(logs.some((l) => /was not said: the voice is hoarse/.test(l))).toBe(true)
  })

  it('without a voice, taunts are only read', async () => {
    const { join, advance } = setup(new FakeDesigners(), null)
    await flush()
    const a = join('Alice')
    advance(0.1)
    a.send({ type: 'taunt' })
    await flush()
    const t = a.conn.last('taunt')!
    expect(t.text.length).toBeGreaterThan(5)
    expect(t.voice).toBeNull()
  })

  it('bots fill the room on the chair\'s word and play a whole match with a player', async () => {
    const { join, advance, game } = setup()
    await flush()
    const a = join('Alice')
    a.send({ type: 'settings', settings: { bots: 3, arena: 'academic' } })
    advance(0.1)
    expect(a.conn.last('lobby')!.lobby.players.filter((p) => p.bot)).toHaveLength(3)
    a.send({ type: 'ready', ready: true })
    let rounds = 0
    let was = game.phase
    for (let s = 0; s < 900 && rounds < 2; s++) {
      advance(1)
      await flush()
      // Alice stands about and loses a little now and then; the bots do the rest.
      const alice = game.sim ? [...game.sim.doctors.values()].find((d) => d.name === 'Alice') : undefined
      if (alice?.alive && game.phase === 'round' && s % 8 === 0) game.sim!.harm(alice, 10, { attacker: null, thing: null, what: 'test' })
      if (game.phase === 'dressing' && was !== 'dressing') {
        rounds++
        a.send({ type: 'ready', ready: true })
      }
      was = game.phase
    }
    expect(rounds).toBe(2)
  }, 60_000)

  it('without the models, the game plays its own hall and its own things', async () => {
    const { join, advance, game } = setup(null)
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    advance(COUNTDOWN + 0.5)
    expect(a.conn.last('arena')!.arena!.name).toBe('The Old Lecture Hall')
    a.send({ type: 'random' })
    advance(8)
    expect(a.conn.last('snap')!.snap.crates[0]!.state).toBe('ready')
    void game
  })
})
