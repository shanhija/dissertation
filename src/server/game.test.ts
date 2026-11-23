import fs from 'node:fs'
import path from 'node:path'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { COUNTDOWN, DESIGN_LIMIT, REQUEST_COOLDOWN } from '../protocol'
import { initPhysics } from '../sim/sim'
import { REJOIN } from './game'
import { FakeDesigners, FakeVoice, flush, heardAs, setup } from './fakes'

// Rounds are played for seconds, and each design is tried in the hall: slow beside the other test files.
vi.setConfig({ testTimeout: 30_000 })

beforeAll(async () => {
  await initPhysics()
})

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
      sim.harm(bob, 10, { attacker: null, thing: null, fists: null, what: 'test' })
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
    a.send({ type: 'settings', settings: { bots: 2, arena: 'academic', wins: null } })
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
    a.send({ type: 'input', input: { move: [0, 1], yaw: 0, pitch: 0, jump: false, hands: [false, false], withdraw: false, presses: { use: [0, 0], other: [0, 0], throw: [0, 0], pick: 0, jump: 0 } } })
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
    advance(COUNTDOWN + REQUEST_COOLDOWN + 0.5)
    a.send({ type: 'request', text: 'a very long spoon' })
    await flush()
    advance(8)
    const snap = a.conn.last('snap')!
    // Beside the two brought to the doctors' defence, the one asked for (and the committee's own, anyone's).
    expect(snap.snap.crates.filter((c) => c.owner !== null)).toHaveLength(3)
    expect(snap.snap.crates.find((c) => c.ask === 'a very long spoon')!.state).toBe('ready')
    expect([...game.kinds.keys()]).toContain([...store.things.values()].find((t) => t.ask === 'a very long spoon')!.id)
    // A second request waits for the cooldown.
    a.send({ type: 'request', text: 'another' })
    advance(0.1)
    expect(a.conn.last('snap')!.me.note).toMatch(/still coming|Wait/)
  })

  it('says a thing was had already only when the designer names one that was', async () => {
    const designers = new FakeDesigners()
    const { join, advance, store } = setup(designers)
    await flush()
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    advance(COUNTDOWN + REQUEST_COOLDOWN + 0.5)
    // Once the designer gave as again only `">` (a recorded match, 2026-11-23).
    designers.nextAgain = '">'
    a.send({ type: 'request', text: 'a leaf blower' })
    await designers.settled()
    advance(0.1)
    expect(a.conn.last('snap')!.me.note).toMatch(/^Ready: Made Thing \d+\.$/)
    expect(fs.readFileSync(path.join(store.dir, 'log.jsonl'), 'utf8')).toContain('"againSaid":"\\">"')
  })

  it('a step the physics breaks in ends the round, not the server, and the next round plays in a new world', async () => {
    const { join, advance, game, logs } = setup()
    await flush()
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    advance(COUNTDOWN + 1)
    expect(game.phase).toBe('round')
    const broken = game.sim!
    broken.step = () => {
      throw new WebAssembly.RuntimeError('unreachable')
    }
    advance(0.1)
    expect(game.phase).toBe('roundEnd')
    expect(game.sim).toBeNull()
    expect(a.conn.last('note')!.text).toMatch(/physics broke/)
    expect(logs.some((l) => l.includes('the physics broke'))).toBe(true)
    advance(6)
    expect(game.phase).toBe('dressing')
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    advance(COUNTDOWN + 1)
    expect(game.phase).toBe('round')
    expect(game.sim).not.toBe(broken)
    advance(1)
    expect(a.conn.last('snap')!.snap.doctors).toHaveLength(2)
  })

  it('a design that takes too long leaves the crate to the archive, and is kept when it comes', async () => {
    const designers = new FakeDesigners()
    const { join, advance, store } = setup(designers)
    await flush()
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    advance(COUNTDOWN + REQUEST_COOLDOWN + 0.5)
    designers.delay = 50
    a.send({ type: 'request', text: 'something slow' })
    advance(DESIGN_LIMIT + 0.5)
    expect(a.conn.last('snap')!.snap.crates.find((c) => c.ask === 'something slow')!.state).toBe('ready')
    const slow = () => [...store.things.values()].filter((t) => t.ask === 'something slow').length
    expect(slow()).toBe(0)
    await new Promise((r) => setTimeout(r, 80))
    await flush()
    expect(slow()).toBe(1)
  })

  it('a curse travels with the next request', async () => {
    const designers = new FakeDesigners()
    const { join, advance, game } = setup(designers)
    await flush()
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    advance(COUNTDOWN + REQUEST_COOLDOWN + 0.5)
    const alice = [...game.sim!.doctors.values()].find((d) => d.name === 'Alice')!
    game.sim!.curse(alice, 'Every noun becomes the word duck.', 1, null)
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

  it('dresses a doctor in clothing in place of their lab coat (and, as it says, their shirt and trousers), and tells the designer what is worn in place of which next time', async () => {
    const designers = new FakeDesigners()
    const { join, advance, store, game, logs } = setup(designers)
    const a = join('Alice')
    // The lab coat off is a choice in the wardrobe, from the start.
    expect(logs.filter((l) => /wardrobe part/.test(l))).toEqual([])
    expect(game.wardrobe.get('shirt-sleeves')).toMatchObject({ slot: 'clothes', covers: [] })
    designers.nextWear = {
      name: 'A red gown and a sash',
      parts: [
        { slot: 'clothes', name: 'Red gown', covers: ['shirt', 'trousers', 'socks'], form: 'A long fitted gown.', code: 'm.cylinder(0.25, 0.3, 1.3, { at: [0, 0.7, 0], color: "#c8102e" })' },
        { slot: 'body', name: 'Sash', covers: ['shirt'], form: 'A sash across the chest.', code: 'm.box(0.05, 0.6, 0.02, { at: [0, 1.2, 0.16], color: "#ffd27a" })' },
      ],
      remove: [],
    }
    a.send({ type: 'dress', text: 'a red evening gown with a sash' })
    await flush()
    advance(0.1)
    expect(a.conn.last('profile')!.profile.look.worn).toMatchObject({ clothes: 'red-gown', body: 'sash' })
    expect(store.wear.get('red-gown')!.covers).toEqual(['shirt', 'trousers'])
    // Only clothing takes the place of the doctor's own clothes.
    expect(game.wardrobe.get('sash')!.covers).toEqual([])
    a.send({ type: 'dress', text: 'my lab coat back, please' })
    await flush()
    advance(0.1)
    expect(designers.asked.at(-1)!.message).toMatch(/wearing clothes: Red gown \(in place of their own lab coat, shirt, trousers\), body: Sash\./)
    const b = join('Bob')
    b.send({ type: 'dress', text: 'a hat' })
    await flush()
    expect(designers.asked.at(-1)!.message).toMatch(/wearing their own lab coat\./)
  })

  it('never says the same taunt twice, and an empty title is written for the player', async () => {
    const { join, advance, store } = setup()
    await flush()
    const a = join('Alice')
    const said: string[] = []
    for (let i = 0; i < 6; i++) {
      a.send({ type: 'taunt' })
      await flush()
      advance(4.1)
    }
    for (const m of a.conn.got) if (m.type === 'taunt') said.push(m.text)
    expect(said.length).toBeGreaterThanOrEqual(5)
    expect(new Set(said).size).toBe(said.length)
    expect(store.lines.taunts.used).toEqual(expect.arrayContaining(said))
    for (const m of a.conn.got) if (m.type === 'taunt') expect(heardAs(m.voice)).toBe(`key-Alice-123456: ${m.text}`)
    const b = join('Bob')
    b.send({ type: 'profile', profile: { name: 'Bob', title: '', look: a.conn.last('profile')!.profile.look, voice: null } })
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
    a.send({ type: 'settings', settings: { bots: 3, arena: 'academic', wins: null } })
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
      if (alice?.alive && game.phase === 'round' && s % 8 === 0) game.sim!.harm(alice, 10, { attacker: null, thing: null, fists: null, what: 'test' })
      if (game.phase === 'dressing' && was !== 'dressing') {
        rounds++
        a.send({ type: 'ready', ready: true })
      }
      was = game.phase
    }
    expect(rounds).toBe(2)
  }, 60_000)

  it('a bot goes for a doctor in its second round as in its first', async () => {
    let seed = 11
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const { join, advance, game } = setup(null, null, random)
    const a = join('Alice')
    a.send({ type: 'settings', settings: { bots: 1, arena: 'academic', wins: null } })
    advance(0.1)
    const bot = a.conn.last('lobby')!.lobby.players.find((p) => p.bot)!.id
    const alice = a.conn.last('welcome')!.you
    /** Seconds into the live round until the bot first hurts Alice, standing where she was put (null: not within `secs`). */
    const firstHit = (secs: number): number | null => {
      a.conn.got.length = 0
      a.send({ type: 'ready', ready: true })
      advance(0.1)
      advance(COUNTDOWN)
      expect(game.phase).toBe('round')
      for (let s = 0; s < secs * 10; s++) {
        advance(0.1)
        if (a.conn.got.some((m) => m.type === 'snap' && m.snap.events.some((e) => e.type === 'hit' && e.by === bot && e.victim === alice))) return s / 10
      }
      return null
    }
    expect(firstHit(30)).not.toBeNull()
    // A long first round (Alice's credibility kept up): the chair ends it.
    for (let s = 0; s < 90; s++) {
      game.sim!.doctors.get(alice)!.cred = 100
      advance(1)
    }
    expect(game.phase).toBe('round')
    a.send({ type: 'endRound' })
    advance(10)
    expect(game.phase).toBe('dressing')
    expect(firstHit(30)).not.toBeNull()
  }, 60_000)

  it('without the models, the game plays its own hall and its own things', async () => {
    const { join, advance, game } = setup(null)
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    advance(COUNTDOWN + REQUEST_COOLDOWN + 0.5)
    expect(a.conn.last('arena')!.arena!.name).toBe('The Old Lecture Hall')
    a.send({ type: 'random' })
    advance(8)
    // The two at the doctors' spawns and the one asked for, all from the archive (the committee's too, left out).
    expect(a.conn.last('snap')!.snap.crates.filter((c) => c.owner !== null).map((c) => [c.state, c.archive])).toEqual([
      ['ready', true],
      ['ready', true],
      ['ready', true],
    ])
    void game
  })
})
