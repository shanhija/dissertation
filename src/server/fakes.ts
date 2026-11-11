/**
 * What the game server's tests play against: designers that answer at once (or after a delay)
 * with designs that work, a voice, sockets that keep what they are sent, and a game on a clock
 * the test moves.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach } from 'vitest'

import type { ClientMsg, Profile, ServerMsg, VoiceName } from '../protocol'
import { STARTERS } from '../sim/things'
import { Game, type Conn } from './game'
import type { Answered, Designers, ModelName } from './opus'
import type { ArenaAnswer, ThingAnswer, WearAnswer } from './prompts'
import { Store } from './store'
import type { Phrase, Speech, Voice } from './voice'

const ARENA_CODE = `a.sky({ color: '#223344' })
a.box([40, 1, 40], { at: [0, -0.5, 0], color: '#888888' })
a.box([6, 2, 6], { at: [8, 1, 8], color: '#aa7744' })
a.ramp([3, 2, 5], { at: [8, 1, 2.5], color: '#775533' })
a.mover(() => a.box([3, 0.4, 3]), (t) => ({ at: [-8, 1 + Math.sin(t), -8] }))
for (let i = 0; i < 8; i++) a.spawn([Math.sin(i * 0.785) * 16, 0, Math.cos(i * 0.785) * 16])`

/** Designers that answer at once (or after `delay` ms) with designs that work, unless told to send `broken` designs first or to fail. */
export class FakeDesigners implements Designers {
  delay = 0
  /** The next this many things fail their trial. */
  broken = 0
  /** Things fail to come at all. */
  failing = false
  /** What was asked, and for a thing how long its crate waited for it (null: none waited). */
  asked: { kind: string; message: string; crateMs: number | null }[] = []
  private n = 0
  /** Answers asked for and not yet given. */
  private pending = 0
  private wait<T>(data: T): Promise<Answered<T>> {
    this.pending++
    return new Promise((resolve) =>
      setTimeout(() => {
        this.pending--
        resolve({ data, model: 'opus', ms: this.delay })
      }, this.delay),
    )
  }
  /** Until every answer asked for so far has come back, and what the game does with it has run (a thing's trial takes real time). */
  async settled(): Promise<void> {
    while (this.pending > 0) await new Promise((r) => setTimeout(r, 5))
    await flush()
  }
  thing(message: string, _timeoutMs: number, crateMs: number | null): Promise<Answered<ThingAnswer>> {
    this.asked.push({ kind: 'thing', message, crateMs })
    if (this.failing) {
      this.pending++
      return new Promise((_, reject) =>
        setTimeout(() => {
          this.pending--
          reject(new Error('the designer is out'))
        }, this.delay),
      )
    }
    const s = STARTERS[0]!
    const broken = this.broken > 0
    if (broken) this.broken--
    // As the designer would: words asked for already this match, in the very same words, name what they asked for again.
    const words = /asks for: (".*")/.exec(message)?.[1]
    const had = /^Had already in this match: (.*)\.$/m.exec(message)?.[1] ?? ''
    const again = words ? (had.split('; ').find((h) => h.endsWith(`(asked as ${words})`))?.replace(/ \(asked as .*\)$/, '') ?? '') : ''
    return this.wait({ again, name: `Made Thing ${++this.n}`, description: s.description, budget: 10, uses: 10, form: 'A plain test form.', look: s.look, code: broken ? 'return { use() { me.nothing.at.all() } }' : s.code })
  }
  wear(message: string): Promise<Answered<WearAnswer>> {
    this.asked.push({ kind: 'wear', message, crateMs: null })
    return this.wait({ name: 'A tall hat', colors: { coat: '#ff0000' }, parts: [{ slot: 'head', name: 'Tall hat', form: 'A tall round crown with a flat brim.', code: 'm.cylinder(0.12, 0.12, 0.4, { at: [0, 0.3, 0], color: "black" })' }], remove: [] })
  }
  arena(_: unknown, message: string): Promise<Answered<ArenaAnswer>> {
    this.asked.push({ kind: 'arena', message, crateMs: null })
    return this.wait({ name: `Test Hall ${++this.n}`, code: ARENA_CODE })
  }
  async taunts(message: string): Promise<Phrase[][]> {
    this.asked.push({ kind: 'taunt', message, crateMs: null })
    return Array.from({ length: 12 }, () => [
      { text: `taunt number ${++this.n},`, tone: 'plain' },
      { text: 'most silly', tone: 'booming' },
    ])
  }
  async titles(): Promise<string[]> {
    return Array.from({ length: 12 }, () => `title number ${++this.n}, most silly`)
  }
  next(): ModelName {
    return 'opus'
  }
  close(): void {}
}

/**
 * A voice that says a line at once as "<key>: <line>" (in a chosen voice "<key> as <voice>: <line>"),
 * holds them while `hold` is set until `release()`, or fails while `fail` is.
 */
export class FakeVoice implements Voice {
  said: { text: string; key: string; voice: VoiceName | null }[] = []
  hold = false
  fail = false
  private held: (() => void)[] = []
  say(phrases: Phrase[], key: string, voice: VoiceName | null): Promise<Speech> {
    const text = phrases.map((p) => p.text).join(' ')
    this.said.push({ text, key, voice })
    if (this.fail) return Promise.reject(new Error('the voice is hoarse'))
    const speech: Speech = { mp3: Buffer.from(`${key}${voice ? ` as ${voice}` : ''}: ${text}`).toString('base64'), tones: phrases.map((p) => p.tone), secs: 2, ms: 1 }
    if (!this.hold) return Promise.resolve(speech)
    return new Promise((resolve) => this.held.push(() => resolve(speech)))
  }
  release(): void {
    for (const r of this.held.splice(0)) r()
  }
  close(): void {}
}

export const heardAs = (voice: string | null) => (voice === null ? null : Buffer.from(voice, 'base64').toString())

export class FakeConn implements Conn {
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

/** A folder of its own for one test's library, removed after the test. */
export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dissertation-test-'))
  dirs.push(dir)
  return dir
}

export function setup(designers: Designers | null = new FakeDesigners(), voice: Voice | null = new FakeVoice(), random: () => number = Math.random) {
  const dir = tempDir()
  let t = 0
  const store = new Store(dir, () => {})
  const logs: string[] = []
  const game = new Game({ designers, voice, store, log: (m) => logs.push(m), join: [], random, clock: () => t }, false)
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
    const profile: Profile | null = name ? { name, title: 'On Ducks', look: { height: 1.8, build: 1, skin: '#e8b892', eyes: '#333333', coat: '#ffffff', shirt: '#334455', trousers: '#222222', shoes: '#111111', gait: 'steady', worn: {} }, voice: null } : null
    send({ type: 'hello', key: `key-${name || 'nameless'}-123456`, profile })
    return { conn, send, close: h.close }
  }
  return { game, store, advance, join, dir, logs }
}

export const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}
