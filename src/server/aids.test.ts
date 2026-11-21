/**
 * What the first party asked for (2026-11-14), on the game's side: a crate left unopened no longer
 * holding its asker back, the committee's crates, the tally of who did what and the record over
 * matches, the leader, and the last round's winner choosing the next arena.
 */

import fs from 'node:fs'
import path from 'node:path'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { ARCHIVE_DROP, COUNTDOWN, CRATE_CLAIM, FALL_DAMAGE, REQUEST_COOLDOWN, type GameEvent, type ServerMsg } from '../protocol'
import { initPhysics } from '../sim/sim'
import type { Game } from './game'
import { ARENA_CODE, FakeDesigners, flush, setup } from './fakes'

vi.setConfig({ testTimeout: 60_000 })

beforeAll(async () => {
  await initPhysics()
})

type Player = ReturnType<ReturnType<typeof setup>['join']>

const idOf = (p: Player) => p.conn.last('welcome')!.you
const doctorOf = (game: Game, p: Player) => game.sim!.doctors.get(idOf(p))!
const lobbyOf = (p: Player) => p.conn.last('lobby')!.lobby
const notes = (p: Player) => p.conn.got.filter((m): m is Extract<ServerMsg, { type: 'note' }> => m.type === 'note').map((m) => m.text)
const events = <T extends GameEvent['type']>(p: Player, type: T) =>
  p.conn.got.flatMap((m) => (m.type === 'snap' ? m.snap.events : [])).filter((e): e is Extract<GameEvent, { type: T }> => e.type === type)

/** E pressed beside a crate: the doctor put next to it, the n-th pick of this page. */
function open(game: Game, p: Player, crate: string, n: number): void {
  const c = game.sim!.crates.get(crate)!
  game.sim!.teleport(doctorOf(game, p), [c.p[0] + 0.8, c.p[1] - 0.45, c.p[2]])
  p.send({ type: 'input', input: { move: [0, 0], yaw: 0, pitch: 0, jump: false, hands: [false, false], withdraw: false, presses: { use: [0, 0], other: [0, 0], throw: [0, 0], pick: n, jump: 0 } } })
}

describe('a crate asked for and left unopened', () => {
  it('holds its asker’s next request back only CRATE_CLAIM s after it was ready; they are told, and it stays, anyone’s', async () => {
    const { join, advance, game } = setup()
    await flush()
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    advance(COUNTDOWN + REQUEST_COOLDOWN + 0.5)
    a.send({ type: 'request', text: 'a lantern' })
    await flush()
    advance(REQUEST_COOLDOWN + 1)
    a.send({ type: 'request', text: 'a second lantern' })
    expect(notes(a).at(-1)).toBe('Your crate is still coming.')
    advance(CRATE_CLAIM - REQUEST_COOLDOWN + 5)
    expect(notes(a).at(-1)).toMatch(/anyone's now, and you may ask again/)
    expect([...game.sim!.crates.values()].some((c) => c.ask === 'a lantern')).toBe(true)
    a.send({ type: 'request', text: 'a second lantern' })
    await flush()
    advance(0.1)
    expect([...game.sim!.crates.values()].some((c) => c.ask === 'a second lantern')).toBe(true)
  })
})

describe('K held', () => {
  it('comes from the page as input and withdraws its doctor to a spawn point, for FALL_DAMAGE', () => {
    const { join, advance, game } = setup(null, null)
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    advance(COUNTDOWN + 1)
    const d = doctorOf(game, a)
    game.sim!.teleport(d, [5, 0.05, 5])
    a.send({ type: 'input', input: { move: [0, 0], yaw: 0, pitch: 0, jump: false, hands: [false, false], withdraw: true, presses: { use: [0, 0], other: [0, 0], throw: [0, 0], pick: 0, jump: 0 } } })
    advance(1.5)
    expect(a.conn.last('snap')!.me.withdraw).toBeGreaterThan(0.4)
    advance(2)
    expect(events(a, 'hit')).toEqual([expect.objectContaining({ victim: d.id, amount: FALL_DAMAGE, what: 'withdrawing' })])
    expect(game.sim!.arena!.spawns.some((s) => Math.hypot(s.p[0] - d.pos[0], s.p[2] - d.pos[2]) < 0.5)).toBe(true)
  })
})

describe('the committee’s crates', () => {
  it('come in during a live round, from the archive, about ARCHIVE_DROP s shared by the doctors still in, never piling up', () => {
    const { join, advance, game } = setup(null, null)
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    advance(COUNTDOWN + 1)
    const committee = () => [...game.sim!.crates.values()].filter((c) => c.owner === null)
    expect(committee()).toHaveLength(0)
    // Two doctors: one every ARCHIVE_DROP / 2 s, give or take 30%; with one doctor each, one may wait at a time.
    advance((ARCHIVE_DROP / 2) * 1.3 + 4)
    expect(committee()).toHaveLength(1)
    expect(committee()[0]).toMatchObject({ state: 'ready', made: { archive: true } })
    advance(ARCHIVE_DROP * 2)
    expect(committee()).toHaveLength(1)
    // Opened by either, the next comes.
    open(game, b, committee()[0]!.id, 1)
    advance(0.2)
    expect(events(a, 'opened').filter((e) => e.owner === null)).toHaveLength(1)
    expect(committee()).toHaveLength(0)
    advance((ARCHIVE_DROP / 2) * 1.3 + 4)
    expect(committee()).toHaveLength(1)
  })
})

describe('the tally and the record', () => {
  it('count who took how much from whom, who dismissed whom and each one’s best thing, for the round and the match; the record keeps rounds, dismissals of the leader and doctorates by key', async () => {
    const { join, advance, game, dir } = setup(null, null)
    const a = join('Alice')
    const b = join('Bob')
    const c = join('Carol')
    a.send({ type: 'settings', settings: { bots: 0, arena: 'academic', wins: 3 } })
    for (const p of [a, b, c]) p.send({ type: 'ready', ready: true })
    advance(COUNTDOWN + 0.5)
    const sim = game.sim!
    const [da, db, dc] = [a, b, c].map((p) => doctorOf(game, p))
    // Bob is made the leader: Alice dismisses him with a shove's worth at a time.
    game.players.get(db!.id)!.wins = 2
    // (the lobby goes out again when anything in it changes)
    a.send({ type: 'settings', settings: { bots: 0, arena: 'academic', wins: 3 } })
    advance(0.1)
    expect(lobbyOf(a).leader).toBe(db!.id)
    for (let i = 0; i < 12 && db!.alive; i++) {
      sim.harm(db!, 10, { attacker: da!.id, thing: null, fists: null, what: 'a test pen' })
      advance(1.05)
    }
    sim.harm(dc!, 30, { attacker: null, thing: null, fists: null, what: 'the arena' })
    for (let i = 0; i < 12 && dc!.alive; i++) {
      sim.harm(dc!, 10, { attacker: null, thing: null, fists: null, what: 'the arena' })
      advance(1.05)
    }
    advance(1.5)
    const stats = a.conn.last('stats')!.stats
    expect(stats.round.dealt[da!.id]).toBe(100)
    expect(stats.round.taken[db!.id]).toBe(100)
    expect(stats.round.taken[dc!.id]).toBe(100)
    expect(stats.round.best[da!.id]).toEqual({ thing: 'a test pen', amount: 100 })
    expect(stats.round.dismissals).toEqual(
      expect.arrayContaining([
        { by: da!.id, victim: db!.id, n: 1 },
        { by: null, victim: dc!.id, n: 1 },
      ]),
    )
    expect(stats.match).toEqual(stats.round)
    expect(stats.names[db!.id]).toBe('Bob')
    // Alice won the round: in the record, a round, a dismissal of the leader.
    expect(game.phase).toBe('roundEnd')
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'record.json'), 'utf8'))
    expect(Object.values(record)).toEqual(expect.arrayContaining([{ name: 'Alice', matches: 0, doctorates: 0, rounds: 1, dismissals: 1, leaders: 1 }]))
    expect(Object.keys(record).every((k) => !JSON.stringify(lobbyOf(a)).includes(k))).toBe(true)
    // The next round's tally starts afresh; the match's goes on. Alice takes the match.
    advance(10)
    for (const p of [a, b, c]) p.send({ type: 'ready', ready: true })
    advance(COUNTDOWN + 0.5)
    expect(a.conn.last('stats')!.stats.round.dismissals).toEqual([])
    expect(a.conn.last('stats')!.stats.match.dismissals).toHaveLength(2)
    game.players.get(da!.id)!.wins = 2
    for (const p of [b, c]) {
      const d = doctorOf(game, p)
      while (d.alive) {
        game.sim!.harm(d, 10, { attacker: null, thing: null, fists: null, what: 'test' })
        advance(1.05)
      }
    }
    advance(5)
    expect(game.phase).toBe('matchEnd')
    const after = lobbyOf(a).record
    expect(after[0]).toMatchObject({ name: 'Alice', matches: 1, doctorates: 1, rounds: 2, here: true })
    expect(after.find((r) => r.name === 'Bob')).toMatchObject({ matches: 1, doctorates: 0 })
  })
})

describe('the last round’s winner', () => {
  it('chooses the next arena from Opus’s new one and kept ones; a kept one chosen leaves the new one for the round after', async () => {
    const designers = new FakeDesigners()
    const { join, advance, game, store } = setup(designers)
    for (const name of ['Kept Hall One', 'Kept Hall Two', 'Kept Hall Three']) store.saveArena({ id: name.toLowerCase().replace(/ /g, '-'), name, setting: 'academic', code: ARENA_CODE, model: 'opus', ms: 1000, made: '2026-11-14T00:00:00.000Z' })
    await flush()
    const a = join('Alice')
    const b = join('Bob')
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    advance(COUNTDOWN + 0.5)
    const db = doctorOf(game, b)
    while (db.alive) {
      game.sim!.harm(db, 10, { attacker: idOf(a), thing: null, fists: null, what: 'test' })
      advance(1.05)
    }
    advance(10)
    await flush()
    advance(0.1)
    expect(game.phase).toBe('dressing')
    const choice = lobbyOf(a).choice!
    expect(choice.by).toBe(idOf(a))
    expect(choice.options).toHaveLength(3)
    expect(choice.options[0]!.id).toBe('new')
    // Only the winner chooses.
    const kept = choice.options[2]!
    b.send({ type: 'chooseArena', id: kept.id })
    advance(0.1)
    expect(lobbyOf(a).choice!.chosen).toBe(null)
    a.send({ type: 'chooseArena', id: kept.id })
    advance(0.1)
    expect(lobbyOf(a).choice!.chosen).toBe(kept.id)
    const fresh = lobbyOf(a).arena
    a.send({ type: 'ready', ready: true })
    b.send({ type: 'ready', ready: true })
    advance(0.1)
    expect(a.conn.last('arena')!.arena!.name).toBe(kept.name)
    expect(lobbyOf(a).choice).toBe(null)
    // Opus's new one waits for the next round.
    if (fresh.state === 'ready') expect(lobbyOf(a).arena).toEqual(fresh)
  })
})
