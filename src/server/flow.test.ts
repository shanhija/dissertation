/**
 * The game's flow around the fight: what a doctor brings to their defence, asking in the
 * countdown, a design that comes late or goes back to be fixed, the dismissed reviewing those
 * still in, the random button's aside, the rounds a match needs, and a whole evening of it.
 */

import fs from 'node:fs'
import path from 'node:path'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { COUNTDOWN, CRATE_OWNER_ONLY, DESIGN_LIMIT, FIX_GRACE, READY_WAIT, REQUEST_COOLDOWN, type GameEvent, type ServerMsg, type Vec3 } from '../protocol'
import { initPhysics } from '../sim/sim'
import type { Game } from './game'
import { FakeConn, FakeDesigners, FakeVoice, flush, heardAs, setup } from './fakes'

// Each plays seconds of rounds, and each design is tried in the hall: slow beside the other test files.
vi.setConfig({ testTimeout: 60_000 })

beforeAll(async () => {
  await initPhysics()
})

const wait = async (ms: number) => {
  await new Promise((r) => setTimeout(r, ms))
  await flush()
}

/** A random source whose next numbers can be set (the genie's and the aside's rolls), else random. */
function rolls(): { random: () => number; next: number[] } {
  const next: number[] = []
  return { random: () => next.shift() ?? Math.random(), next }
}

type Player = ReturnType<ReturnType<typeof setup>['join']>

const idOf = (p: Player) => p.conn.last('welcome')!.you
const doctorOf = (game: Game, p: Player) => game.sim!.doctors.get(idOf(p))!
const events = <T extends GameEvent['type']>(p: Player, type: T) =>
  p.conn.got.flatMap((m) => (m.type === 'snap' ? m.snap.events : [])).filter((e): e is Extract<GameEvent, { type: T }> => e.type === type)
const snapOf = (p: Player) => p.conn.last('snap')!
const lobbyOf = (p: Player) => p.conn.last('lobby')!.lobby
const notes = (p: Player) => p.conn.got.filter((m): m is Extract<ServerMsg, { type: 'note' }> => m.type === 'note').map((m) => m.text)
const things = (designers: FakeDesigners) => designers.asked.filter((q) => q.kind === 'thing').map((q) => q.message)
const far = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2])

/** E pressed: the n-th pick of this page. */
const pick = (p: Player, n: number) =>
  p.send({ type: 'input', input: { move: [0, 0], yaw: 0, pitch: 0, jump: false, hands: [false, false], presses: { use: [0, 0], other: [0, 0], throw: [0, 0], pick: n, jump: 0 } } })

/** A doctor put beside a crate, in reach of it, on its side away from the nearest other crate (which may have come in close by), so E opens this one. */
function beside(game: Game, p: Player, crate: string): void {
  const c = game.sim!.crates.get(crate)!
  const other = [...game.sim!.crates.values()].filter((o) => o !== c).sort((a, b) => far(a.p, c.p) - far(b.p, c.p))[0]
  const away = other ? Math.atan2(c.p[2] - other.p[2], c.p[0] - other.p[0]) : 0
  game.sim!.teleport(doctorOf(game, p), [c.p[0] + 0.8 * Math.cos(away), c.p[1] - 0.45, c.p[2] + 0.8 * Math.sin(away)])
}

/** A doctor out of the round, one hit a second. */
function dismiss(game: Game, p: Player, advance: (s: number) => void): void {
  const d = doctorOf(game, p)
  while (d.alive) {
    game.sim!.harm(d, 10, { attacker: null, thing: null, fists: null, what: 'test' })
    advance(1.05)
  }
}

describe('bringing a thing to one’s defence', () => {
  it('is made once a break when the player is Ready, two at a time, from the last words written while it waits, and waits beside them as the round begins', async () => {
    const designers = new FakeDesigners()
    designers.delay = 30
    const { random, next } = rolls()
    const { join, advance, game } = setup(designers, null, random)
    const a = join('Alice')
    const b = join('Bob')
    const c = join('Carol')
    const d = join('Dave')
    advance(0.1)
    expect(lobbyOf(a).players.map((p) => p.bringing)).toEqual(['none', 'none', 'none', 'none'])
    next.push(0.9, 0.9, 0.9)
    a.send({ type: 'bring', text: 'a brass ear trumpet' })
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    c.send({ type: 'bring', text: 'a kite' })
    c.send({ type: 'ready', ready: true })
    advance(0.1)
    expect(things(designers)).toHaveLength(2)
    expect(things(designers)[0]).toMatch(/Alice asks for: "a brass ear trumpet"/)
    expect(things(designers)[1]).toMatch(/Bob pressed the button/)
    const bringing = (name: string) => lobbyOf(a).players.find((p) => p.name === name)!.bringing
    expect([bringing('Alice'), bringing('Bob'), bringing('Carol'), bringing('Dave')]).toEqual(['making', 'making', 'queued', 'none'])
    // While Carol's waits its turn, her last words win; Ready again starts nothing more.
    c.send({ type: 'bring', text: 'a box kite' })
    a.send({ type: 'ready', ready: false })
    a.send({ type: 'ready', ready: true })
    await wait(50)
    advance(0.1)
    expect(things(designers)).toHaveLength(3)
    expect(things(designers)[2]).toMatch(/Carol asks for: "a box kite"/)
    expect([bringing('Alice'), bringing('Bob')]).toEqual(['ready', 'ready'])
    expect(notes(a).at(-1)).toMatch(/waits beside you when the round begins/)
    // Dave is ready last: the round begins.
    d.send({ type: 'bring', text: 'an umbrella' })
    d.send({ type: 'ready', ready: true })
    advance(0.1)
    expect(game.phase).toBe('countdown')
    await wait(50)
    advance(CRATE_WARP_SECS)
    const crates = snapOf(a).snap.crates
    expect(crates).toHaveLength(4)
    for (const [p, ask] of [
      [a, 'a brass ear trumpet'],
      [b, null],
      [c, 'a box kite'],
      [d, 'an umbrella'],
    ] as const) {
      const crate = crates.find((x) => x.owner === idOf(p))!
      expect(crate.ask).toBe(ask)
      expect(crate.state).toBe('ready')
      // Nobody opens a crate in the countdown: its asker's seconds have not begun.
      expect(crate.ownerUntil).toBe(null)
      expect(far(crate.p, doctorOf(game, p).pos)).toBeLessThan(5.5)
    }
    // Ready in the countdown: their askers' alone for the first seconds of the round.
    advance(COUNTDOWN)
    expect(game.phase).toBe('round')
    for (const crate of snapOf(a).snap.crates) expect(crate.ownerUntil).toBeCloseTo(COUNTDOWN + CRATE_OWNER_ONLY, 0)
    expect(lobbyOf(a).players.map((p) => p.bringing)).toEqual(['none', 'none', 'none', 'none'])
  })

  it('a bot brings a thing from the archive; a player never Ready brings what they last wrote; a design not done 30 s into the round leaves the archive’s thing until it comes', async () => {
    const designers = new FakeDesigners()
    designers.delay = 30
    const { join, advance, game, logs } = setup(designers, null)
    await wait(50)
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'settings', settings: { bots: 1, arena: 'academic', wins: null } })
    advance(0.1)
    a.send({ type: 'bring', text: 'a lantern' })
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'bring', text: 'a teapot' })
    // Bob never presses Ready; the break ends anyway.
    advance(READY_WAIT + 0.1)
    expect(game.phase).toBe('countdown')
    expect(things(designers).at(-1)).toMatch(/Bob asks for: "a teapot"/)
    advance(CRATE_WARP_SECS)
    const bot = lobbyOf(a).players.find((p) => p.bot)!
    const crateOf = (id: string) => snapOf(a).snap.crates.find((x) => x.owner === id)!
    expect(crateOf(bot.id)).toMatchObject({ state: 'ready', archive: true, ask: null })
    expect(crateOf(idOf(a))).toMatchObject({ state: 'waiting', ask: 'a lantern' })
    expect(crateOf(idOf(b))).toMatchObject({ state: 'waiting', ask: 'a teapot' })
    // The bot leaves, so nobody else is hurt or opens a crate meanwhile.
    game.sim!.removeDoctor(bot.id)
    // 30 s into the round, still not done: the archive's things.
    advance(COUNTDOWN + DESIGN_LIMIT - CRATE_WARP_SECS + 0.2)
    expect(game.phase).toBe('round')
    expect(crateOf(idOf(a))).toMatchObject({ state: 'ready', archive: true })
    expect(notes(a).at(-1)).toMatch(/took too long/)
    // The designs come, and nobody has opened the crates: they go in place of the archive's.
    await wait(50)
    advance(0.1)
    expect(crateOf(idOf(a))).toMatchObject({ state: 'ready', archive: false })
    expect(crateOf(idOf(b))).toMatchObject({ state: 'ready', archive: false })
    expect(notes(a).at(-1)).toMatch(/^It made it after all: Made Thing/)
    expect(logs).toEqual([])
  })

  it('without the models every doctor brings a thing from the archive at once', async () => {
    const { join, advance } = setup(null, null)
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    advance(0.1)
    expect(lobbyOf(a).players.map((p) => p.bringing)).toEqual(['none', 'none'])
    advance(CRATE_WARP_SECS)
    expect(snapOf(a).snap.crates.map((x) => [x.state, x.archive])).toEqual([
      ['ready', true],
      ['ready', true],
    ])
  })

  it('that fails its design says so in the dossier, and a thing from the archive waits in its place', async () => {
    const designers = new FakeDesigners()
    designers.failing = true
    const { join, advance, game, logs } = setup(designers, null)
    await flush()
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'bring', text: 'a lantern' })
    a.send({ type: 'ready', ready: true })
    await flush()
    advance(0.1)
    expect(lobbyOf(a).players.find((p) => p.name === 'Alice')!.bringing).toBe('failed')
    expect(notes(a).at(-1)).toBe('What you bring failed its design: a thing from the archive waits for you instead.')
    expect(logs).toEqual(['brought by Alice: the designer is out'])
    b.send({ type: 'ready', ready: true })
    advance(0.1)
    expect(game.phase).toBe('countdown')
    await flush()
    advance(CRATE_WARP_SECS)
    expect(snapOf(a).snap.crates.find((x) => x.owner === idOf(a))).toMatchObject({ state: 'ready', archive: true, ask: 'a lantern' })
  })

  it('waiting its turn is never started once the game has closed', async () => {
    const designers = new FakeDesigners()
    designers.delay = 30
    const { join, advance, game } = setup(designers, null)
    await flush()
    // Dave is not Ready, so the break goes on with Carol's waiting its turn.
    const players = ['Alice', 'Bob', 'Carol', 'Dave'].map(join)
    for (const p of players.slice(0, 3)) p.send({ type: 'ready', ready: true })
    advance(0.1)
    expect(game.phase).toBe('dressing')
    expect(things(designers)).toHaveLength(2)
    game.close()
    await wait(50)
    expect(things(designers)).toHaveLength(2)
  })

  it('tells the picker how long its crate waits (none in the break, the countdown and 30 s from the round’s start), as a request’s and its fix’s; a player who left starts none', async () => {
    const designers = new FakeDesigners()
    designers.delay = 30
    const { join, advance, game } = setup(designers, null)
    await flush()
    const [a, b, c, d] = ['Alice', 'Bob', 'Carol', 'Dave'].map(join)
    const asked = () => designers.asked.filter((q) => q.kind === 'thing').map((q) => ({ by: q.message.split(' ')[0], crateMs: q.crateMs }))
    a!.send({ type: 'ready', ready: true })
    b!.send({ type: 'ready', ready: true })
    c!.send({ type: 'bring', text: 'a kite' })
    c!.send({ type: 'ready', ready: true })
    advance(0.1)
    // Carol's waits its turn and she leaves: it is not made when a turn comes, nor when the round begins without her.
    c!.close()
    await designers.settled()
    advance(0.1)
    expect(asked()).toEqual([
      { by: 'Alice', crateMs: null },
      { by: 'Bob', crateMs: null },
    ])
    // Dave is never Ready: his is made from the round's start, its crate waiting through the countdown and 30 s.
    d!.send({ type: 'bring', text: 'an umbrella' })
    advance(READY_WAIT + 0.1)
    expect(game.phase).toBe('countdown')
    expect(asked().map((q) => q.by)).toEqual(['Alice', 'Bob', 'Dave'])
    expect(asked()[2]!.crateMs).toBeCloseTo((COUNTDOWN + DESIGN_LIMIT) * 1000, -1)
    await designers.settled()
    advance(COUNTDOWN + REQUEST_COOLDOWN + 0.5)
    designers.broken = 1
    a!.send({ type: 'request', text: 'a lamp' })
    expect(asked().at(-1)!.by).toBe('Alice')
    expect(asked().at(-1)!.crateMs).toBeCloseTo(DESIGN_LIMIT * 1000, -1)
    // Sent back to be fixed 10 s on: the crate's 20 s left and the fix's grace.
    advance(10)
    await designers.settled()
    expect(asked()).toHaveLength(5)
    expect(asked().at(-1)!.crateMs).toBeCloseTo((DESIGN_LIMIT - 10 + FIX_GRACE) * 1000, -1)
  })

  it('waiting its turn while its player reloads the page is made once they are Ready again', async () => {
    const designers = new FakeDesigners()
    designers.delay = 30
    const { join, advance } = setup(designers, null)
    await flush()
    // Dave is not Ready, so the break goes on.
    const [a, b, c] = ['Alice', 'Bob', 'Carol', 'Dave'].map(join)
    for (const p of [a, b, c]) p!.send({ type: 'ready', ready: true })
    advance(0.1)
    c!.close()
    await designers.settled()
    advance(0.1)
    expect(things(designers)).toHaveLength(2)
    join('Carol').send({ type: 'ready', ready: true })
    advance(0.1)
    expect(things(designers)).toHaveLength(3)
    expect(things(designers)[2]).toMatch(/^Carol pressed the button/)
  })

  it('comes in beside each doctor, bots too, not on them: nobody is put aside as the crates arrive', () => {
    const { join, advance, game } = setup(null, null)
    const players = ['Alice', 'Bob', 'Carol', 'Dave'].map(join)
    players[0]!.send({ type: 'settings', settings: { bots: 3, arena: 'academic', wins: null } })
    advance(0.1)
    for (const p of players) p.send({ type: 'ready', ready: true })
    advance(0.1)
    expect(game.phase).toBe('countdown')
    const sim = game.sim!
    const stood = new Map([...sim.doctors.values()].map((d) => [d.id, [...d.pos] as Vec3]))
    advance(CRATE_WARP_SECS)
    expect(sim.crates.size).toBe(7)
    for (const c of sim.crates.values()) {
      expect(c.state).toBe('ready')
      expect(far(c.p, stood.get(c.owner)!)).toBeGreaterThan(1.2)
      expect(far(c.p, stood.get(c.owner)!)).toBeLessThan(5.5)
      expect(far(sim.doctors.get(c.owner)!.pos, stood.get(c.owner)!)).toBeLessThan(0.05)
    }
  })

  it('is written in the dressing room only: words that come during a round are not brought to the next', async () => {
    const designers = new FakeDesigners()
    const { join, advance, game } = setup(designers, null)
    await flush()
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    await flush()
    advance(COUNTDOWN + 0.5)
    expect(game.phase).toBe('round')
    b.send({ type: 'bring', text: 'a stale teapot' })
    a.send({ type: 'endRound' })
    advance(5)
    expect(game.phase).toBe('dressing')
    // Bob is never Ready this break: he brings what he wrote in it, which is nothing.
    a.send({ type: 'ready', ready: true })
    advance(READY_WAIT + 0.1)
    expect(game.phase).toBe('countdown')
    const bobs = things(designers).filter((m) => m.includes('Bob'))
    expect(bobs.at(-1)).toMatch(/Bob pressed the button/)
    expect(bobs.some((m) => m.includes('stale teapot'))).toBe(false)
  })
})

/** Seconds for a crate to come in, and a little. */
const CRATE_WARP_SECS = 3.3

describe('asking', () => {
  it('works in the countdown; the crate brought to a defence holds no request back; the next is a cooldown after the round goes live, for everyone', async () => {
    const { join, advance, game } = setup()
    await flush()
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    await flush()
    advance(1)
    expect(game.phase).toBe('countdown')
    a.send({ type: 'random' })
    await flush()
    advance(0.1)
    expect(snapOf(a).me.crate).toBe(true)
    expect(snapOf(a).snap.crates.filter((x) => x.owner === idOf(a))).toHaveLength(2)
    advance(COUNTDOWN)
    expect(game.phase).toBe('round')
    // Alice asked in the countdown, Bob did not: the same wait for both.
    expect(snapOf(b).me.cooldown).toBeGreaterThan(REQUEST_COOLDOWN - 1.5)
    expect(snapOf(a).me.cooldown).toBe(snapOf(b).me.cooldown)
    expect(snapOf(b).me.crate).toBe(false)
    b.send({ type: 'request', text: 'a hat' })
    advance(0.1)
    expect(snapOf(b).me.note).toMatch(/^Wait 1[45] s\.$/)
    advance(REQUEST_COOLDOWN)
    // Bob's crate from the break stands unopened, and his request goes.
    b.send({ type: 'request', text: 'a hat' })
    await flush()
    advance(0.1)
    expect(snapOf(b).snap.crates.filter((x) => x.owner === idOf(b))).toHaveLength(2)
    expect(snapOf(b).me.crate).toBe(true)
  })

  it('a design that fails its trial goes back to be fixed, and its crate waits FIX_GRACE seconds more for it', async () => {
    const designers = new FakeDesigners()
    const { join, advance } = setup(designers)
    await flush()
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    await flush()
    advance(COUNTDOWN + REQUEST_COOLDOWN + 0.5)
    designers.delay = 30
    designers.broken = 1
    a.send({ type: 'request', text: 'a lamp' })
    advance(DESIGN_LIMIT - 5)
    await wait(50)
    expect(notes(a).at(-1)).toBe(`It failed its trial and went back to be fixed: ${FIX_GRACE} s more.`)
    advance(10)
    const asked = () => snapOf(a).snap.crates.find((x) => x.ask === 'a lamp')!
    expect(asked().state).toBe('waiting')
    await wait(50)
    advance(0.1)
    expect(asked()).toMatchObject({ state: 'ready', archive: false })
    expect(notes(a).at(-1)).toMatch(/^Ready: Made Thing/)
  })
})

describe('the dismissed review those still in', () => {
  it('once a round, the doctor they watch: laid on that doctor’s next request, shown to them, and told when their crate opens', async () => {
    const designers = new FakeDesigners()
    const { random, next } = rolls()
    const { join, advance, game } = setup(designers, null, random)
    await flush()
    const alice = join('Alice')
    const bob = join('Bob')
    const carol = join('Carol')
    const dave = join('Dave')
    for (const p of [alice, bob, carol, dave]) p.send({ type: 'ready', ready: true })
    await flush()
    advance(COUNTDOWN + 0.5)
    carol.send({ type: 'review', target: idOf(alice), text: 'Too soon.' })
    advance(0.1)
    expect(notes(carol).at(-1)).toBe('Only the dismissed write reviews.')
    expect(snapOf(carol).me.review).toBe(false)
    dismiss(game, carol, advance)
    dismiss(game, dave, advance)
    expect(game.phase).toBe('round')
    expect(snapOf(carol).me.review).toBe(true)
    carol.send({ type: 'review', target: idOf(alice), text: 'Every noun in it becomes the word duck.' })
    advance(0.1)
    expect(notes(carol).at(-1)).toBe('Your review of Alice is lodged.')
    expect(events(bob, 'curse')).toEqual([{ type: 'curse', victim: idOf(alice), text: 'Every noun in it becomes the word duck.', by: idOf(carol) }])
    expect(snapOf(alice).me.curse).toEqual({ text: 'Every noun in it becomes the word duck.', by: idOf(carol) })
    expect(snapOf(carol).me.review).toBe(false)
    carol.send({ type: 'review', target: idOf(bob), text: 'Again.' })
    dave.send({ type: 'review', target: idOf(alice), text: 'Also ducks.' })
    advance(0.1)
    expect(notes(carol).at(-1)).toBe('One review a round.')
    expect(notes(dave).at(-1)).toBe('Alice is already under review.')
    // Alice's next request carries it to the designer; her crate tells it when it opens.
    advance(REQUEST_COOLDOWN)
    next.push(0.9)
    alice.send({ type: 'request', text: 'a sword' })
    await flush()
    expect(things(designers).at(-1)).toMatch(/A curse lies on Alice's words, to be followed first: "Every noun in it becomes the word duck."/)
    advance(3.5)
    expect(snapOf(alice).me.curse).toBe(null)
    const crate = snapOf(alice).snap.crates.find((x) => x.ask === 'a sword')!
    expect(crate.state).toBe('ready')
    beside(game, alice, crate.id)
    advance(0.1)
    pick(alice, 1)
    advance(0.1)
    expect(events(bob, 'opened').at(-1)).toMatchObject({ by: idOf(alice), owner: idOf(alice), ask: 'a sword', genie: false, archive: false, curse: 'Every noun in it becomes the word duck.' })
    expect(snapOf(alice).me.hands[0]!.origin).toEqual({ by: idOf(alice), ask: 'a sword', genie: false, archive: false })
  })
  it('is refused for a bot, which asks for nothing, and not written by a page without a name', () => {
    const { join, advance, game } = setup(null, null)
    const alice = join('Alice')
    const bob = join('Bob')
    alice.send({ type: 'settings', settings: { bots: 1, arena: 'academic', wins: null } })
    advance(0.1)
    alice.send({ type: 'ready', ready: true })
    bob.send({ type: 'ready', ready: true })
    advance(COUNTDOWN + 0.5)
    expect(game.phase).toBe('round')
    dismiss(game, bob, advance)
    const bot = lobbyOf(bob).players.find((p) => p.bot)!
    bob.send({ type: 'review', target: bot.id, text: 'Beep.' })
    advance(0.1)
    expect(notes(bob).at(-1)).toBe(`${bot.name} is a bot and asks for nothing: review a doctor who asks.`)
    expect(game.sim!.doctors.get(bot.id)!.curse).toBe(null)
    expect(snapOf(bob).me.review).toBe(true)
    // A page with no name comes in to watch.
    const conn = new FakeConn()
    const page = game.connect(conn)
    page.message(JSON.stringify({ type: 'hello', key: 'key-watcher-123456', profile: null }))
    advance(0.1)
    expect(conn.last('snap')!.me.review).toBe(false)
    page.message(JSON.stringify({ type: 'review', target: idOf(alice), text: 'Who is this?' }))
    advance(0.1)
    expect(conn.last('note')!.text).toBe('Give your doctor a name first.')
    expect(game.sim!.doctors.get(idOf(alice))!.curse).toBe(null)
  })
})

describe('the random button’s aside, and the genie', () => {
  it('rolled with each request and logged: one in three random things takes no credibility by itself, one in four typed ones is twisted', async () => {
    const designers = new FakeDesigners()
    const { random, next } = rolls()
    const { join, advance, dir } = setup(designers, null, random)
    await flush()
    const a = join('Alice')
    const b = join('Bob')
    const c = join('Carol')
    advance(0.1)
    next.push(0.2)
    a.send({ type: 'ready', ready: true })
    next.push(0.5)
    b.send({ type: 'ready', ready: true })
    await flush()
    next.push(0.1)
    c.send({ type: 'bring', text: 'a hat' })
    c.send({ type: 'ready', ready: true })
    await flush()
    const [alice, bob, carol] = things(designers)
    expect(alice).toMatch(/takes no credibility from anyone by itself/)
    expect(bob).not.toMatch(/takes no credibility/)
    expect(carol).toMatch(/This time be a genie/)
    expect(carol).not.toMatch(/takes no credibility/)
    const log = fs
      .readFileSync(path.join(dir, 'log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { kind: string; by: string; aside: boolean; genie: boolean })
      .filter((e) => e.kind === 'thing')
    expect(log.map((e) => [e.by, e.aside, e.genie])).toEqual([
      ['Alice', true, false],
      ['Bob', false, false],
      ['Carol', false, true],
    ])
  })
})

describe('the match', () => {
  it('needs fewer wins in a bigger room, fixed at its first round, unless the chair sets them', async () => {
    const { join, advance, game } = setup()
    await flush()
    const a = join('Alice')
    a.send({ type: 'settings', settings: { bots: 1, arena: 'academic', wins: null } })
    advance(0.1)
    expect(lobbyOf(a).wins).toBe(5)
    a.send({ type: 'settings', settings: { bots: 3, arena: 'academic', wins: null } })
    advance(0.1)
    expect(lobbyOf(a).wins).toBe(4)
    a.send({ type: 'settings', settings: { bots: 5, arena: 'academic', wins: null } })
    advance(0.1)
    expect(lobbyOf(a).wins).toBe(3)
    a.send({ type: 'ready', ready: true })
    advance(0.1)
    expect(game.phase).toBe('countdown')
    // Fixed for this match: fewer bots now change nothing.
    a.send({ type: 'settings', settings: { bots: 1, arena: 'academic', wins: null } })
    advance(0.1)
    expect(lobbyOf(a).wins).toBe(3)
    a.send({ type: 'settings', settings: { bots: 1, arena: 'academic', wins: 7 } })
    advance(0.1)
    expect(lobbyOf(a).wins).toBe(7)
    expect(lobbyOf(a).settings.wins).toBe(7)
    // Only the chair's numbers are taken.
    a.send({ type: 'settings', settings: { bots: 1, arena: 'academic', wins: 6 as never } })
    advance(0.1)
    expect(lobbyOf(a).settings.wins).toBe(null)
    expect(lobbyOf(a).wins).toBe(3)
  })

  it('ends when a doctor has won the rounds it needs, and the next follows the room again', async () => {
    const { join, advance, game } = setup()
    await flush()
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'settings', settings: { bots: 0, arena: 'academic', wins: 3 } })
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    advance(COUNTDOWN + 0.5)
    game.players.get(idOf(a))!.wins = 2
    dismiss(game, b, advance)
    advance(5)
    expect(game.phase).toBe('matchEnd')
    expect(lobbyOf(a).winner).toBe('Alice')
    a.send({ type: 'settings', settings: { bots: 0, arena: 'academic', wins: null } })
    advance(10)
    expect(game.phase).toBe('dressing')
    expect(lobbyOf(a).players.map((p) => p.wins)).toEqual([0, 0])
    expect(lobbyOf(a).wins).toBe(5)
  })

  it('counts only the doctors who play: pages without a name watch, and neither end a round at once nor shorten the match', () => {
    const { join, advance, game } = setup(null, null)
    const a = join('Alice')
    for (let n = 0; n < 5; n++) game.connect(new FakeConn()).message(JSON.stringify({ type: 'hello', key: `key-watcher-${n}-123456`, profile: null }))
    advance(0.1)
    expect(lobbyOf(a).wins).toBe(5)
    a.send({ type: 'ready', ready: true })
    advance(READY_WAIT + 0.1)
    expect(game.phase).toBe('countdown')
    expect(game.sim!.doctors.size).toBe(6)
    advance(COUNTDOWN + 1)
    expect(game.phase).toBe('round')
    expect(lobbyOf(a).wins).toBe(5)
    expect(lobbyOf(a).players.find((p) => p.name === 'Alice')!.wins).toBe(0)
  })

  it('goes to the most wins when the chair sets fewer than two doctors have', () => {
    const { join, advance, game } = setup(null, null)
    const b = join('Bob')
    const a = join('Alice')
    b.send({ type: 'ready', ready: true })
    a.send({ type: 'ready', ready: true })
    advance(COUNTDOWN + 0.5)
    game.players.get(idOf(a))!.wins = 4
    game.players.get(idOf(b))!.wins = 2
    b.send({ type: 'settings', settings: { bots: 0, arena: 'academic', wins: 3 } })
    dismiss(game, a, advance)
    advance(5)
    expect(game.phase).toBe('matchEnd')
    expect(lobbyOf(a).winner).toBe('Alice')
  })
})

describe('an evening', () => {
  it('goes from the dressing room through a match and back: what is brought, a request in the countdown, the asker’s 3 s, a reload mid-round, a review, the round’s end and the match’s', async () => {
    const designers = new FakeDesigners()
    designers.delay = 20
    const { join, advance, game, logs } = setup(designers, new FakeVoice())
    await flush()
    const alice = join('Alice')
    const bob = join('Bob')
    const carol = join('Carol')
    alice.send({ type: 'settings', settings: { bots: 0, arena: 'academic', wins: 3 } })
    advance(0.1)
    alice.send({ type: 'bring', text: 'a brass ear trumpet' })
    for (const p of [alice, bob, carol]) p.send({ type: 'ready', ready: true })
    advance(0.1)
    expect(game.phase).toBe('countdown')
    // A taunt in the countdown, said in her voice where she stands; a request too.
    alice.send({ type: 'taunt' })
    await flush()
    const taunt = bob.conn.last('taunt')!
    expect(taunt.at).not.toBe(null)
    expect(heardAs(taunt.voice)).toMatch(/^key-Alice-123456: /)
    alice.send({ type: 'request', text: 'a lamp' })
    await designers.settled()
    advance(COUNTDOWN)
    expect(game.phase).toBe('round')
    const crates = () => snapOf(bob).snap.crates
    const defence = crates().find((c) => c.owner === idOf(alice) && c.ask === 'a brass ear trumpet')!
    expect(defence.state).toBe('ready')
    expect(defence.ownerUntil).toBeCloseTo(COUNTDOWN + CRATE_OWNER_ONLY, 0)
    // Bob at Alice's crate in its first seconds: not his yet, and told so; then anyone's.
    beside(game, bob, defence.id)
    advance(0.1)
    pick(bob, 1)
    advance(0.1)
    expect(events(bob, 'notYet').at(-1)).toMatchObject({ who: idOf(bob), owner: idOf(alice) })
    expect(game.sim!.crates.has(defence.id)).toBe(true)
    advance(CRATE_OWNER_ONLY)
    pick(bob, 2)
    advance(0.1)
    expect(events(alice, 'opened').at(-1)).toMatchObject({ by: idOf(bob), owner: idOf(alice), ask: 'a brass ear trumpet' })
    expect(snapOf(bob).me.hands.find((h) => h)!.origin).toMatchObject({ by: idOf(alice), ask: 'a brass ear trumpet' })
    // Alice reloads the page mid-round: the same doctor, still in, and her countdown crate still hers to open.
    alice.close()
    advance(2)
    const again = join('Alice')
    advance(0.1)
    expect(idOf(again)).toBe(idOf(alice))
    expect(again.conn.last('arena')!.arena).not.toBe(null)
    expect(snapOf(again).me.crate).toBe(true)
    const lamp = crates().find((c) => c.ask === 'a lamp')!
    expect(lamp.state).toBe('ready')
    beside(game, again, lamp.id)
    advance(0.1)
    pick(again, 1)
    advance(0.1)
    expect(events(bob, 'opened').at(-1)).toMatchObject({ by: idOf(alice), owner: idOf(alice), ask: 'a lamp' })
    expect(snapOf(again).me.crate).toBe(false)
    // Carol is dismissed and reviews her; Alice's next request carries it.
    dismiss(game, carol, advance)
    expect(snapOf(carol).me.review).toBe(true)
    carol.send({ type: 'review', target: idOf(alice), text: 'Every noun becomes a duck.' })
    advance(0.1)
    expect(snapOf(again).me.curse).toEqual({ text: 'Every noun becomes a duck.', by: idOf(carol) })
    advance(REQUEST_COOLDOWN)
    again.send({ type: 'request', text: 'a hat' })
    await flush()
    expect(designers.asked.at(-1)).toMatchObject({ kind: 'thing', crateMs: DESIGN_LIMIT * 1000 })
    expect(designers.asked.at(-1)!.message).toMatch(/A curse lies on Alice's words/)
    // Bob goes: the round is Alice's, then two more and the match.
    dismiss(game, bob, advance)
    expect(game.phase).toBe('roundEnd')
    expect(lobbyOf(again).winner).toBe('Alice')
    await designers.settled()
    advance(5)
    expect(game.phase).toBe('dressing')
    for (let round = 2; round <= 3; round++) {
      for (const p of [again, bob, carol]) p.send({ type: 'ready', ready: true })
      advance(0.1)
      expect(game.phase).toBe('countdown')
      await designers.settled()
      advance(COUNTDOWN + 0.5)
      dismiss(game, bob, advance)
      dismiss(game, carol, advance)
      await designers.settled()
      advance(5)
    }
    expect(game.phase).toBe('matchEnd')
    expect(lobbyOf(again).winner).toBe('Alice')
    advance(10)
    expect(game.phase).toBe('dressing')
    expect(lobbyOf(again).players.map((p) => p.wins)).toEqual([0, 0, 0])
    expect(logs).toEqual([])
    expect(notes(again).filter((n) => /failed|took too long/.test(n))).toEqual([])
  })
})
