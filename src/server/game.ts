/**
 * The game on the host's computer: one room of up to eight players (and bots when asked for), the
 * phases (the dressing room, a countdown, the round, its end, the match's end), the sim of the
 * round being played, and everything that goes to the models: things for crates, looks for the
 * dressing room, the next arena, taunts and thesis titles. Players' browsers only send input and
 * draw what comes back. Nothing here throws at a player: a bad message is ignored, a failed
 * design falls back to the library.
 */

import { PLAYER_COLORS, STARTER_WEAR, botName, cleanLook, randomLook } from '../doctor'
import {
  DESIGN_LIMIT,
  MAX_PLAYERS,
  NO_INPUT,
  COUNTDOWN,
  PATIENCE,
  PATIENCE_DRAIN,
  READY_WAIT,
  REQUEST_COOLDOWN,
  SLOTS,
  WINS_TO_MATCH,
  type ArenaStatus,
  type ClientMsg,
  type Input,
  type Lobby,
  type Look,
  type Me,
  type Phase,
  type PlayerInfo,
  type Profile,
  type ServerMsg,
  type Settings,
  type Slot,
  type WardrobePart,
} from '../protocol'
import { recipeOf, thingApi } from '../sim/api'
import { buildArena, checkArena, type ArenaSource } from '../sim/arena'
import { LECTURE_HALL } from '../sim/hall'
import { Bot } from '../sim/bots'
import { compile } from '../sim/sandbox'
import { DT, Sim, type ThingKind } from '../sim/sim'
import { STARTERS, compileThing, trialThing, type ThingDesign } from '../sim/things'
import type { Designers } from './opus'
import { arenaMessage, linesMessage, thingMessage, wearMessage, type ThingAnswer, type WearAnswer } from './prompts'
import { Store, lineKey, type ArenaDesign } from './store'
import type { Speech, Voice } from './voice'

/** A socket as the game uses it. */
export interface Conn {
  send(text: string): void
  close(): void
}

export interface Deps {
  designers: Designers | null
  /** Who says the taunts aloud (null: they are only read). */
  voice: Voice | null
  store: Store
  log: (message: string) => void
  /** Addresses friends open, shown in the dressing room. */
  join: string[]
  random: () => number
  /** Seconds, rising. */
  clock: () => number
}

interface Player {
  id: string
  key: string
  name: string
  title: string
  look: Look
  color: string
  bot: Bot | null
  ready: boolean
  dressing: boolean
  wins: number
  conn: Conn | null
  joined: number
  left: number
  input: Input
  cooldownUntil: number
  note: { text: string; until: number } | null
  tauntAt: number
  /** Their next taunt, taken and being said in their voice ahead of V (null: none taken yet). */
  nextTaunt: Promise<Taunt | null> | null
  /** V was pressed and the taunt is still being said. */
  tauntWaiting: boolean
  botCrateAt: number
}

interface Taunt {
  text: string
  /** Null when there is no voice or it failed (logged): the taunt is only read. */
  speech: Speech | null
}

interface CrateJob {
  crate: string
  sim: Sim
  deadline: number
  filled: boolean
  player: string
}

/** Seconds a player who dropped out (a page reloaded, the network blinked) keeps their doctor in the round, to come back to. */
export const REJOIN = 20
const ROUND_END = 4.5
const MATCH_END = 9
const TAUNT_EVERY = 4
const WEAR_TIMEOUT = 70_000
const THING_TIMEOUT = 100_000
/**
 * The share of typed requests the designer twists like a genie ("sometimes ... twist the
 * players words as much as possible"). Decided here: asked to twist "now and then", the model
 * twisted nearly every clear request.
 */
const GENIE = 0.25
const ARENA_TIMEOUT = 480_000
/** Seconds an arena is expected to take while fewer than five are kept to measure by. */
const ARENA_EXPECT = 180
/** Players gone this long are forgotten (their wins with them). */
const FORGET_AFTER = 180

/** Taunts the game has of its own, said only when Haiku has none ready; each only once, ever. */
const OWN_TAUNTS = [
  'You smell like a flying duck.',
  'Your arguments are weak like the bottom of an elder.',
  'Thy footnotes are lighter than a goose in a fog.',
  'I have seen sturdier reasoning in a damp almanac.',
  'Your bibliography was clearly assembled by a startled heron.',
  'Sir or madam, your hypothesis wears borrowed trousers.',
  'Your methodology dances like a pickled turnip.',
  'I would cite you, but my quill refuses.',
  'Your appendix is longer than your argument and twice as damp.',
  'Even the library mice have dismissed your thesis.',
]

export class Game {
  readonly players = new Map<string, Player>()
  phase: Phase = 'dressing'
  private phaseUntil = 0
  round = 0
  sim: Sim | null = null
  settings: Settings = { bots: 0, arena: 'academic' }
  readonly kinds = new Map<string, ThingKind>()
  readonly wardrobe = new Map<string, WardrobePart>()
  private nextArena: ArenaSource | null = null
  private arenaJob: { since: number; expect: number; model: string } | null = null
  private lastArena: string | null = null
  private waitSince: number | null = null
  private winner: string | null = null
  private startedWith = 0
  private jobs: CrateJob[] = []
  private lobbyDirty = true
  /** The lobby's timer as last sent, to send it again whenever it counts down. */
  private sentTimer: number | null = null
  private seq = 0
  private acc = 0
  private last: number
  private readonly timer: ReturnType<typeof setInterval> | null
  private refilling = { taunt: false, title: false }
  private closed = false

  constructor(
    private readonly deps: Deps,
    /** False in tests: they call tick() themselves. */
    run = true,
  ) {
    for (const w of STARTER_WEAR) this.addWear({ ...w, ask: '', by: '' })
    for (const w of deps.store.wear.values()) this.addWear(w)
    for (const d of [...STARTERS, ...deps.store.things.values()]) {
      try {
        this.kinds.set(d.id, compileThing(d))
      } catch (err) {
        deps.log(`thing ${d.id} would not compile: ${(err as Error).message}`)
      }
    }
    this.last = deps.clock()
    this.buildNextArena()
    this.refill('taunt')
    this.refill('title')
    this.timer = run ? setInterval(() => this.tick(), 1000 / 60) : null
  }

  close(): void {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    for (const p of this.players.values()) p.conn?.close()
    this.sim?.free()
    this.sim = null
    this.deps.designers?.close()
    this.deps.voice?.close()
  }

  private now(): number {
    return this.deps.clock()
  }

  private addWear(w: { id: string; name: string; slot: Slot; code: string; ask: string; by: string }): WardrobePart | null {
    try {
      const { recipe } = recipeOf(compile('look', w.code))
      const part: WardrobePart = { id: w.id, name: w.name, slot: w.slot, recipe, by: w.by, ask: w.ask }
      this.wardrobe.set(w.id, part)
      return part
    } catch (err) {
      this.deps.log(`wardrobe part ${w.id} would not build: ${(err as Error).message}`)
      return null
    }
  }

  // ---------------------------------------------------------------------------- talking

  private send(p: Player, msg: ServerMsg): void {
    p.conn?.send(JSON.stringify(msg))
  }

  private broadcast(msg: ServerMsg): void {
    const text = JSON.stringify(msg)
    for (const p of this.players.values()) p.conn?.send(text)
  }

  private note(p: Player, text: string): void {
    p.note = { text, until: this.now() + 5 }
    this.send(p, { type: 'note', text })
  }

  /** A new socket. Returns what the plugin calls with each message and on close. */
  connect(conn: Conn): { message: (text: string) => void; close: () => void } {
    let player: Player | null = null
    return {
      message: (text) => {
        let msg: ClientMsg
        try {
          msg = JSON.parse(text) as ClientMsg
        } catch {
          return
        }
        if (msg === null || typeof msg !== 'object') return
        if (msg.type === 'hello') {
          player = this.hello(conn, msg.key, msg.profile)
          return
        }
        if (player) this.handle(player, msg)
      },
      close: () => {
        if (player && player.conn === conn) this.leave(player)
      },
    }
  }

  private hello(conn: Conn, key: unknown, profile: Profile | null): Player | null {
    if (typeof key !== 'string' || key.length < 8 || key.length > 80) {
      conn.send(JSON.stringify({ type: 'refused', why: 'no key' } satisfies ServerMsg))
      conn.close()
      return null
    }
    let p = [...this.players.values()].find((q) => q.key === key) ?? null
    if (!p) {
      const humans = [...this.players.values()].filter((q) => !q.bot)
      if (humans.length >= MAX_PLAYERS) {
        conn.send(JSON.stringify({ type: 'refused', why: `The room is full: ${MAX_PLAYERS} doctors already.` } satisfies ServerMsg))
        conn.close()
        return null
      }
      this.dropBots(MAX_PLAYERS - humans.length - 1)
      const used = new Set([...this.players.values()].map((q) => q.color))
      p = this.newPlayer(key, PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0], null)
      p.look = randomLook(this.deps.random, { hair: 'wild-white-hair' })
    } else p.conn?.close()
    p.conn = conn
    p.left = 0
    if (profile) this.setProfile(p, profile)
    this.send(p, { type: 'welcome', you: p.id })
    this.send(p, { type: 'wardrobe', parts: [...this.wardrobe.values()] })
    this.send(p, { type: 'profile', profile: { name: p.name, title: p.title, look: p.look } })
    if (this.sim) {
      this.send(p, { type: 'arena', arena: this.sim.arena!.view })
      this.send(p, { type: 'models', models: Object.fromEntries(this.sim.models) })
      if (!this.sim.doctors.has(p.id)) this.spectate(p)
    }
    this.lobbyDirty = true
    return p
  }

  private newPlayer(key: string, color: string, bot: Bot | null): Player {
    const id = `p${++this.seq}`
    const p: Player = {
      id,
      key,
      name: '',
      title: '',
      look: randomLook(this.deps.random, {}),
      color,
      bot,
      ready: bot !== null,
      dressing: false,
      wins: 0,
      conn: null,
      joined: this.now(),
      left: 0,
      input: NO_INPUT,
      cooldownUntil: 0,
      note: null,
      tauntAt: -10,
      nextTaunt: null,
      tauntWaiting: false,
      botCrateAt: 0,
    }
    this.players.set(id, p)
    return p
  }

  /** The doctor stays, standing still, for REJOIN seconds: a reloaded page comes back to it (tick removes it after). */
  private leave(p: Player): void {
    p.conn = null
    p.left = this.now()
    p.ready = false
    p.input = { ...NO_INPUT, yaw: p.input.yaw, pitch: p.input.pitch, presses: p.input.presses }
    this.lobbyDirty = true
  }

  private chair(): Player | null {
    return [...this.players.values()].filter((p) => !p.bot && p.conn).sort((a, b) => a.joined - b.joined)[0] ?? null
  }

  private handle(p: Player, msg: ClientMsg): void {
    switch (msg.type) {
      case 'profile':
        this.setProfile(p, msg.profile)
        return
      case 'dress':
        if (typeof msg.text === 'string') void this.dress(p, msg.text.trim().slice(0, 300))
        return
      case 'ready':
        p.ready = msg.ready === true && p.name !== ''
        if (msg.ready === true && p.name === '') this.note(p, 'Give your doctor a name first.')
        this.lobbyDirty = true
        return
      case 'input':
        p.input = cleanInput(msg.input)
        return
      case 'writing': {
        const d = this.sim?.doctors.get(p.id)
        if (d) d.writing = msg.on === true
        return
      }
      case 'request':
        if (typeof msg.text === 'string' && msg.text.trim()) this.request(p, msg.text.trim().slice(0, 400))
        return
      case 'random':
        this.request(p, null)
        return
      case 'taunt':
        this.taunt(p)
        return
      case 'settings':
        if (this.chair() !== p || msg.settings === null || typeof msg.settings !== 'object') return
        this.settings = {
          bots: Math.max(0, Math.min(MAX_PLAYERS - 1, Math.round(Number(msg.settings.bots) || 0))),
          arena: msg.settings.arena === 'anything' ? 'anything' : 'academic',
        }
        this.lobbyDirty = true
        return
      case 'endRound':
        if (this.chair() === p && this.phase === 'round') this.endRound(null)
        return
    }
  }

  private setProfile(p: Player, profile: Profile): void {
    if (profile === null || typeof profile !== 'object') return
    p.name = typeof profile.name === 'string' ? profile.name.trim().slice(0, 40) : p.name
    if (p.name === '') p.ready = false
    const title = typeof profile.title === 'string' ? profile.title.trim().slice(0, 160) : ''
    if (title) p.title = title
    else {
      // An empty title asks for one: Haiku's next, or the next to come (refill hands them out).
      p.title = ''
      this.giveTitle(p)
    }
    if (profile.look && typeof profile.look === 'object') p.look = cleanLook(profile.look, (id) => this.wardrobe.get(id)?.slot ?? null)
    if (p.name && !p.nextTaunt) p.nextTaunt = this.prepareTaunt(p)
    this.lobbyDirty = true
  }

  private giveTitle(p: Player): void {
    const title = this.takeLine('title')
    if (title) {
      p.title = title
      this.send(p, { type: 'profile', profile: { name: p.name, title: p.title, look: p.look } })
      this.lobbyDirty = true
    }
  }

  // ---------------------------------------------------------------------------- lines

  /** A line never handed out before, or null when none is ready. */
  private takeLine(kind: 'taunt' | 'title'): string | null {
    const stock = kind === 'taunt' ? this.deps.store.lines.taunts : this.deps.store.lines.titles
    const used = new Set(stock.used.map(lineKey))
    let line = stock.ready.shift() ?? null
    while (line !== null && used.has(lineKey(line))) line = stock.ready.shift() ?? null
    if (line === null && kind === 'taunt') line = OWN_TAUNTS.find((t) => !used.has(lineKey(t))) ?? null
    if (line !== null) {
      stock.used.push(line)
      this.deps.store.saveLines()
    }
    this.refill(kind)
    return line
  }

  private refill(kind: 'taunt' | 'title'): void {
    const designers = this.deps.designers
    const stock = kind === 'taunt' ? this.deps.store.lines.taunts : this.deps.store.lines.titles
    if (!designers || this.refilling[kind] || stock.ready.length >= 6 || this.closed) return
    this.refilling[kind] = true
    designers
      .lines(kind, linesMessage(12, [...stock.used, ...stock.ready]))
      .then((lines) => {
        const seen = new Set([...stock.used, ...stock.ready].map(lineKey))
        for (const l of lines) {
          const line = l.trim().replace(/^["'\d.\-\s]+|["']+$/g, '').slice(0, 200)
          if (line.length < 6 || seen.has(lineKey(line))) continue
          seen.add(lineKey(line))
          stock.ready.push(line)
        }
        this.deps.store.saveLines()
        for (const p of this.players.values()) if (!p.title && !p.bot && p.conn) this.giveTitle(p)
      })
      .catch((err: Error) => this.deps.log(`${kind}s: ${err.message}`))
      .finally(() => {
        this.refilling[kind] = false
      })
  }

  /**
   * A player's next taunt: a line taken now and said in their voice ahead of time (about 2 s), so
   * V is heard at once. Null when no line is ready.
   */
  private prepareTaunt(p: Player): Promise<Taunt | null> {
    const text = this.takeLine('taunt')
    if (!text) return Promise.resolve(null)
    if (!this.deps.voice) return Promise.resolve({ text, speech: null })
    return this.deps.voice.say(text, p.key).then(
      (speech) => ({ text, speech }),
      (err: Error) => {
        if (!this.closed) this.deps.log(`voice: "${text}" was not said: ${err.message}`)
        return { text, speech: null }
      },
    )
  }

  private taunt(p: Player): void {
    const now = this.now()
    if (now - p.tauntAt < TAUNT_EVERY || !p.name || p.tauntWaiting) return
    const next = p.nextTaunt ?? this.prepareTaunt(p)
    p.nextTaunt = null
    p.tauntWaiting = true
    p.tauntAt = now
    void next.then((t) => {
      p.tauntWaiting = false
      if (this.closed) return
      if (!t) {
        p.tauntAt = -10
        return this.note(p, 'No taunt is ready yet.')
      }
      const d = this.sim?.doctors.get(p.id)
      const at = d && this.phase !== 'dressing' ? this.sim!.eyeOf(d) : null
      this.broadcast({ type: 'taunt', by: p.id, text: t.text, at, voice: t.speech?.mp3 ?? null })
      this.deps.store.append({ kind: 'taunt', by: p.name, text: t.text, ...(t.speech && { tone: t.speech.tone, secs: Math.round(t.speech.secs * 10) / 10, ms: t.speech.ms }) })
      p.nextTaunt = this.prepareTaunt(p)
    })
  }

  // ---------------------------------------------------------------------------- the dressing room

  private async dress(p: Player, text: string): Promise<void> {
    if (!text) return
    const designers = this.deps.designers
    if (!designers) return this.note(p, 'Opus is not here, so nothing new can be made. Pick from the wardrobe.')
    if (p.dressing) return this.note(p, 'Your last wish is still being made.')
    p.dressing = true
    this.lobbyDirty = true
    const t0 = this.now()
    let fix: { answer: WearAnswer; problems: string[] } | null = null
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const wornNames = Object.fromEntries(Object.entries(p.look.worn).map(([s, id]) => [s, this.wardrobe.get(id)?.name ?? id]))
        const a = await designers.wear(wearMessage({ ask: text, look: p.look, wornNames, fix }), WEAR_TIMEOUT)
        const problems: string[] = []
        const built: { slot: Slot; name: string; code: string }[] = []
        for (const part of Array.isArray(a.data.parts) ? a.data.parts : []) {
          if (!SLOTS.includes(part.slot as Slot)) continue
          try {
            recipeOf(compile('look', part.code))
            built.push({ slot: part.slot as Slot, name: String(part.name).slice(0, 60), code: part.code })
          } catch (err) {
            problems.push(`${part.slot} "${part.name}": ${(err as Error).message}`)
          }
        }
        if (problems.length > 0 && attempt === 0) {
          fix = { answer: a.data, problems }
          continue
        }
        if (this.closed) return
        const look: Look = { ...p.look, worn: { ...p.look.worn } }
        if (typeof a.data.height === 'number') look.height = a.data.height
        if (typeof a.data.build === 'number') look.build = a.data.build
        if (typeof a.data.gait === 'string') look.gait = a.data.gait
        for (const [k, v] of Object.entries(a.data.colors ?? {})) if (typeof v === 'string' && k in look) (look as unknown as Record<string, unknown>)[k] = v
        for (const s of Array.isArray(a.data.remove) ? a.data.remove : []) delete look.worn[s as Slot]
        const parts: WardrobePart[] = []
        for (const b of built) {
          const id = this.deps.store.freeId('wear', b.name)
          const design = { id, name: b.name, slot: b.slot, code: b.code, ask: text, by: p.name, model: a.model, made: new Date().toISOString() }
          this.deps.store.saveWear(design)
          const part = this.addWear(design)
          if (part) {
            parts.push(part)
            look.worn[b.slot] = id
          }
        }
        if (parts.length) this.broadcast({ type: 'wardrobe', parts })
        p.look = cleanLook(look, (id) => this.wardrobe.get(id)?.slot ?? null)
        this.send(p, { type: 'profile', profile: { name: p.name, title: p.title, look: p.look } })
        this.deps.store.append({ kind: 'wear', by: p.name, ask: text, model: a.model, ms: Math.round((this.now() - t0) * 1000), parts: parts.map((x) => x.id), problems })
        this.note(p, problems.length ? `${a.data.name}: some of it would not build.` : `${a.data.name}.`)
        return
      }
    } catch (err) {
      this.deps.log(`dressing ${p.name}: ${(err as Error).message}`)
      this.deps.store.append({ kind: 'wear', by: p.name, ask: text, error: (err as Error).message })
      this.note(p, 'That did not work out. Try other words.')
    } finally {
      p.dressing = false
      this.lobbyDirty = true
    }
  }

  // ---------------------------------------------------------------------------- crates

  private request(p: Player, ask: string | null): void {
    const sim = this.sim
    const now = this.now()
    if (!sim || this.phase !== 'round') return this.note(p, 'Crates come only during a round.')
    const d = sim.doctors.get(p.id)
    if (!d?.alive) return this.note(p, 'You are out of this round.')
    d.writing = false
    if (now < p.cooldownUntil) return this.note(p, `Wait ${Math.ceil(p.cooldownUntil - now)} s.`)
    if (sim.me(p.id).crate) return this.note(p, 'Your crate is still coming.')
    const crate = sim.dropCrate(p.id)
    if (!crate) return
    p.cooldownUntil = now + REQUEST_COOLDOWN
    const curse = sim.takeCurse(p.id)
    const job: CrateJob = { crate: crate.id, sim, deadline: now + DESIGN_LIMIT, filled: false, player: p.id }
    this.jobs.push(job)
    if (!this.deps.designers) {
      this.fill(job, this.fallbackKind(), 'Opus is not here: a thing from the archive.')
      return
    }
    this.note(p, `${capital(this.deps.designers.next())} is designing it.`)
    this.designThing(ask, p.name, curse).then(
      (kind) => {
        if (!job.filled) this.fill(job, kind, `Ready: ${kind.name}.`)
        else this.note(p, `${kind.name} came too late for that crate; it is in the archive now.`)
      },
      (err: Error) => {
        this.deps.log(`design for ${p.name}: ${err.message}`)
        if (!job.filled) this.fill(job, this.fallbackKind(), 'The design failed: a thing from the archive.')
      },
    )
  }

  private fill(job: CrateJob, kind: ThingKind, note: string): void {
    job.filled = true
    if (job.sim !== this.sim) return
    job.sim.fillCrate(job.crate, kind)
    const p = this.players.get(job.player)
    if (p) this.note(p, note)
  }

  private fallbackKind(): ThingKind {
    const all = [...this.kinds.values()]
    return all[Math.floor(this.deps.random() * all.length)]!
  }

  private async designThing(ask: string | null, by: string, curse: string | null): Promise<ThingKind> {
    const designers = this.deps.designers!
    const avoid = ask === null ? [...this.kinds.values()].map((k) => k.name) : []
    const genie = ask !== null && this.deps.random() < GENIE
    const t0 = this.now()
    let fix: { answer: ThingAnswer; problems: string[] } | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      const a = await designers.thing(thingMessage({ ask, by, curse, avoid, genie, fix }), THING_TIMEOUT)
      const answer = a.data
      const id = this.deps.store.freeId('things', String(answer.name || 'thing'))
      const design: ThingDesign = {
        id,
        name: String(answer.name).slice(0, 60),
        description: String(answer.description).slice(0, 200),
        budget: answer.budget === 20 ? 20 : 10,
        look: String(answer.look),
        code: String(answer.code),
        ask: ask ?? '',
        by,
        random: ask === null,
        model: a.model,
        ms: Math.round((this.now() - t0) * 1000),
        made: new Date().toISOString(),
      }
      let problems: string[]
      let kind: ThingKind | null = null
      try {
        kind = compileThing(design)
        problems = trialThing(kind)
      } catch (err) {
        problems = [(err as Error).message]
      }
      this.deps.store.append({ kind: 'thing', by, ask, curse, genie, model: a.model, ms: design.ms, id, name: design.name, problems, ...(problems.length ? { look: design.look, code: design.code } : {}) })
      if (problems.length === 0 && kind) {
        this.deps.store.saveThing(design)
        this.kinds.set(id, kind)
        return kind
      }
      fix = { answer, problems: problems.slice(0, 8) }
    }
    throw new Error('no design passed its trial')
  }

  // ---------------------------------------------------------------------------- arenas

  private buildNextArena(): void {
    if (this.arenaJob || this.nextArena || this.closed) return
    const designers = this.deps.designers
    if (!designers) {
      this.nextArena = this.fallbackArena()
      this.lobbyDirty = true
      return
    }
    // It nearly always takes at most the 95th percentile of the last 20 builds kept (the latest
    // tell best, as the prompts change), retries and all.
    const ms = [...this.deps.store.arenas.values()]
      .sort((a, b) => a.made.localeCompare(b.made))
      .slice(-20)
      .map((a) => a.ms)
      .sort((a, b) => a - b)
    const expect = ms.length < 5 ? ARENA_EXPECT : Math.round(ms[Math.ceil(ms.length * 0.95) - 1]! / 1000)
    this.arenaJob = { since: this.now(), expect, model: 'opus' }
    this.lobbyDirty = true
    const setting = this.settings.arena
    this.designArena(designers, setting)
      .then(
        (src) => {
          this.nextArena = src
        },
        (err: Error) => {
          this.deps.log(`arena: ${err.message}`)
          this.nextArena = this.fallbackArena()
        },
      )
      .finally(() => {
        this.arenaJob = null
        this.lobbyDirty = true
      })
  }

  private async designArena(designers: Designers, setting: Settings['arena']): Promise<ArenaSource> {
    const avoid = [...this.deps.store.arenas.values()].map((a) => a.name)
    let fix: { answer: { name: string; code: string }; problems: string[] } | null = null
    const t0 = this.now()
    for (let attempt = 0; attempt < 3; attempt++) {
      const a = await designers.arena(setting, arenaMessage({ avoid, fix }), ARENA_TIMEOUT)
      const id = this.deps.store.freeId('arenas', String(a.data.name || 'arena'))
      let problems: string[]
      let src: ArenaSource | null = null
      try {
        src = { id, name: String(a.data.name).slice(0, 60), build: compile('arena', String(a.data.code)) }
        problems = checkArena(src)
      } catch (err) {
        problems = [(err as Error).message]
      }
      this.deps.store.append({ kind: 'arena', model: a.model, ms: Math.round((this.now() - t0) * 1000), id, name: a.data.name, problems, ...(problems.length ? { code: a.data.code } : {}) })
      if (problems.length === 0 && src) {
        const design: ArenaDesign = { id, name: src.name, setting, code: String(a.data.code), model: a.model, ms: Math.round((this.now() - t0) * 1000), made: new Date().toISOString() }
        this.deps.store.saveArena(design)
        return src
      }
      fix = { answer: { name: String(a.data.name), code: String(a.data.code) }, problems }
    }
    throw new Error('no arena passed its checks')
  }

  /** A kept arena (not the last one played) that still passes today's checks, else the game's own hall. */
  private fallbackArena(): ArenaSource {
    const kept = [...this.deps.store.arenas.values()].filter((a) => a.id !== this.lastArena)
    while (kept.length) {
      const a = kept.splice(Math.floor(this.deps.random() * kept.length), 1)[0]!
      try {
        const src = { id: a.id, name: a.name, build: compile('arena', a.code) }
        const problems = checkArena(src)
        if (problems.length === 0) return src
        this.deps.log(`kept arena ${a.id} fails today's checks: ${problems[0]}`)
      } catch (err) {
        this.deps.log(`kept arena ${a.id} would not compile: ${(err as Error).message}`)
      }
    }
    return LECTURE_HALL
  }

  // ---------------------------------------------------------------------------- bots

  private humans(): Player[] {
    return [...this.players.values()].filter((p) => !p.bot && p.conn)
  }

  /** Humans in the game, counting those who dropped out a moment ago and may come back. */
  private present(): Player[] {
    const now = this.now()
    return [...this.players.values()].filter((p) => !p.bot && (p.conn || now - p.left < REJOIN))
  }

  private dropBots(keep: number): void {
    const bots = [...this.players.values()].filter((p) => p.bot)
    while (bots.length > Math.max(0, keep)) {
      const b = bots.pop()!
      this.sim?.removeDoctor(b.id)
      this.players.delete(b.id)
      this.lobbyDirty = true
    }
  }

  private fitBots(): void {
    const want = Math.min(this.settings.bots, MAX_PLAYERS - this.humans().length)
    const bots = [...this.players.values()].filter((p) => p.bot)
    if (bots.length > want) return this.dropBots(want)
    for (let i = bots.length; i < want; i++) {
      const used = new Set([...this.players.values()].map((q) => q.color))
      const p = this.newPlayer(`bot-${this.seq + 1}-xxxxxxxx`, PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[i % PLAYER_COLORS.length]!, null)
      p.bot = new Bot(p.id, this.deps.random)
      p.ready = true
      p.name = botName(this.deps.random, new Set([...this.players.values()].map((q) => q.name)))
      const wear = (slot: Slot) => {
        const parts = [...this.wardrobe.values()].filter((w) => w.slot === slot)
        return this.deps.random() < 0.7 && parts.length ? parts[Math.floor(this.deps.random() * parts.length)]!.id : undefined
      }
      const worn: Look['worn'] = {}
      for (const s of SLOTS) {
        const id = wear(s)
        if (id) worn[s] = id
      }
      p.look = randomLook(this.deps.random, worn)
      p.title = this.takeLine('title') ?? 'On the Unexamined Properties of Things'
      this.lobbyDirty = true
    }
  }

  // ---------------------------------------------------------------------------- rounds

  /**
   * Everyone is ready (bots always are), or the first was READY_WAIT ago. The arena never holds
   * the start up: when Opus's new one is not done, a kept one is played and the new one comes next.
   */
  private canStart(): boolean {
    const humans = this.humans()
    if (humans.length === 0) {
      this.waitSince = null
      return false
    }
    if (humans.every((p) => p.ready)) return true
    if (!humans.some((p) => p.ready)) {
      this.waitSince = null
      return false
    }
    this.waitSince ??= this.now()
    return this.now() - this.waitSince >= READY_WAIT
  }

  private startRound(): void {
    const src = this.nextArena ?? this.fallbackArena()
    this.nextArena = null
    this.waitSince = null
    this.sim?.free()
    this.jobs = []
    const sim = new Sim(this.deps.random)
    sim.apiFor = thingApi
    try {
      buildArena(sim, src)
      this.lastArena = src.id
    } catch (err) {
      this.deps.log(`arena ${src.id} would not build: ${(err as Error).message}`)
      sim.free()
      return this.startRoundIn(LECTURE_HALL)
    }
    this.sim = sim
    for (const p of this.players.values()) {
      if (p.bot || (p.conn && p.name)) {
        sim.addDoctor(p.id, p.name, p.bot !== null)
        sim.setInput(p.id, p.input)
        sim.syncPresses(p.id)
      }
      p.cooldownUntil = 0
      p.botCrateAt = this.now() + 12 + this.deps.random() * 20
      if (!p.bot) p.ready = false
    }
    for (const p of this.players.values()) if (p.conn && !sim.doctors.has(p.id)) this.spectate(p)
    this.startedWith = sim.doctors.size
    this.round++
    this.winner = null
    this.setPhase('countdown', COUNTDOWN)
    this.broadcast({ type: 'arena', arena: sim.arena!.view })
    this.broadcast({ type: 'models', models: sim.drainModels() })
    this.buildNextArena()
  }

  private startRoundIn(src: ArenaSource): void {
    this.nextArena = src
    this.startRound()
  }

  /** A player who came in the middle watches the round. */
  private spectate(p: Player): void {
    const sim = this.sim!
    if (sim.doctors.has(p.id)) return
    const d = sim.addDoctor(p.id, p.name || 'Someone', false)
    d.alive = false
    d.collider.setEnabled(false)
  }

  private endRound(winner: string | null): void {
    const sim = this.sim!
    sim.live = false
    this.winner = winner
    if (winner) this.players.get(winner)!.wins++
    this.setPhase('roundEnd', ROUND_END)
  }

  private setPhase(phase: Phase, secs: number): void {
    this.phase = phase
    this.phaseUntil = this.now() + secs
    this.lobbyDirty = true
  }

  // ---------------------------------------------------------------------------- the beat

  tick(): void {
    if (this.closed) return
    const now = this.now()
    this.acc = Math.min(this.acc + (now - this.last), DT * 6)
    this.last = now
    for (const p of [...this.players.values()]) {
      if (p.bot || p.conn) continue
      if (now - p.left > REJOIN && this.sim?.doctors.has(p.id)) this.sim.removeDoctor(p.id)
      if (now - p.left > FORGET_AFTER) {
        this.players.delete(p.id)
        this.lobbyDirty = true
      }
    }

    switch (this.phase) {
      case 'dressing':
        this.fitBots()
        if (this.canStart()) this.startRound()
        break
      case 'countdown':
        if (now >= this.phaseUntil) {
          this.sim!.live = true
          this.setPhase('round', 0)
        }
        break
      case 'round': {
        const sim = this.sim!
        // The committee's patience: past it, everyone still in loses credibility every second.
        if (sim.time > PATIENCE && Math.floor(sim.time) !== Math.floor(sim.time - DT * 2)) {
          for (const d of sim.alive()) sim.harm(d, PATIENCE_DRAIN, { attacker: 'committee', thing: null, what: "the committee's patience" })
        }
        const alive = sim.alive()
        if (this.startedWith >= 2 && alive.length <= 1) this.endRound(alive[0]?.id ?? null)
        else if (this.present().length === 0) this.endRound(null)
        break
      }
      case 'roundEnd':
        if (now >= this.phaseUntil) {
          const champion = [...this.players.values()].find((p) => p.wins >= WINS_TO_MATCH)
          if (champion) {
            this.winner = champion.id
            this.setPhase('matchEnd', MATCH_END)
          } else this.toDressing()
        }
        break
      case 'matchEnd':
        if (now >= this.phaseUntil) {
          for (const p of this.players.values()) p.wins = 0
          this.toDressing()
        }
        break
    }

    const sim = this.sim
    let stepped = false
    if (sim && this.phase !== 'dressing') {
      while (this.acc >= DT) {
        this.acc -= DT
        for (const p of this.players.values()) {
          if (!sim.doctors.has(p.id)) continue
          let input = p.bot ? p.bot.think(sim) : p.input
          if (this.phase === 'countdown') input = { ...NO_INPUT, yaw: input.yaw, pitch: input.pitch, presses: input.presses }
          sim.setInput(p.id, input)
        }
        if (this.phase === 'countdown') for (const id of sim.doctors.keys()) sim.syncPresses(id)
        sim.step()
        stepped = true
      }
      if (this.phase === 'round') this.botCrates(sim, now)
      for (const job of this.jobs) {
        if (!job.filled && now >= job.deadline) {
          this.fill(job, this.fallbackKind(), 'Opus took too long: a thing from the archive.')
          this.deps.store.append({ kind: 'late', crate: job.crate })
        }
      }
      this.jobs = this.jobs.filter((j) => !j.filled)
    } else this.acc = 0

    if (sim && stepped) {
      const models = sim.drainModels()
      if (Object.keys(models).length) this.broadcast({ type: 'models', models })
      const snapText = JSON.stringify(sim.snapshot())
      for (const p of this.players.values()) {
        if (!p.conn) continue
        const me: Me = {
          cooldown: Math.max(0, Math.round((p.cooldownUntil - now) * 10) / 10),
          ...sim.me(p.id),
          note: p.note && p.note.until > now ? p.note.text : null,
        }
        p.conn.send(`{"type":"snap","me":${JSON.stringify(me)},"snap":${snapText}}`)
      }
    }
    // Sent when it changed, when its timer counts down, and every second in the dressing room (for the arena's building).
    const timer = this.countdown(now)
    if (this.lobbyDirty || timer !== this.sentTimer || (this.phase === 'dressing' && Math.floor(now) !== Math.floor(now - 1 / 60))) {
      this.lobbyDirty = false
      this.sentTimer = timer
      this.broadcast({ type: 'lobby', lobby: this.lobby() })
    }
  }

  /** Bots get a crate of their own now and then, filled from the archive. */
  private botCrates(sim: Sim, now: number): void {
    for (const p of this.players.values()) {
      if (!p.bot || now < p.botCrateAt) continue
      p.botCrateAt = now + 25 + this.deps.random() * 20
      if (!sim.doctors.get(p.id)?.alive || sim.me(p.id).crate) continue
      const crate = sim.dropCrate(p.id)
      if (crate) sim.fillCrate(crate.id, this.fallbackKind())
    }
  }

  private toDressing(): void {
    this.sim?.free()
    this.sim = null
    this.jobs = []
    this.broadcast({ type: 'arena', arena: null })
    this.setPhase('dressing', 0)
    this.buildNextArena()
  }

  /** Whole seconds left in the countdown, the round's end, the match's end or the break's wait; null when nothing counts down. */
  private countdown(now: number): number | null {
    if (this.phase === 'countdown' || this.phase === 'roundEnd' || this.phase === 'matchEnd') return Math.max(0, Math.ceil(this.phaseUntil - now))
    if (this.phase === 'dressing' && this.waitSince !== null) return Math.max(0, Math.ceil(READY_WAIT - (now - this.waitSince)))
    return null
  }

  lobby(): Lobby {
    const now = this.now()
    const chair = this.chair()
    const players: PlayerInfo[] = [...this.players.values()]
      .filter((p) => p.bot || p.conn)
      .map((p) => ({ id: p.id, name: p.name, title: p.title, look: p.look, color: p.color, bot: p.bot !== null, ready: p.bot !== null || p.ready, dressing: p.dressing, wins: p.wins, chair: p === chair, connected: p.conn !== null || p.bot !== null }))
    const arena: ArenaStatus = this.nextArena ? { state: 'ready', name: this.nextArena.name } : this.arenaJob ? { state: 'building', since: Math.round(now - this.arenaJob.since), expect: this.arenaJob.expect, model: this.arenaJob.model } : { state: 'none' }
    const timer = this.countdown(now)
    const winner = this.winner ? (this.players.get(this.winner)?.name ?? null) : null
    return { players, settings: this.settings, phase: this.phase, timer, round: this.round, arena, winner, join: this.deps.join }
  }
}

const capital = (s: string) => s.slice(0, 1).toUpperCase() + s.slice(1)

/** An input as the sim may take it: numbers in range, counters as numbers. */
function cleanInput(v: unknown): Input {
  if (v === null || typeof v !== 'object') return NO_INPUT
  const i = v as Partial<Input>
  const n = (x: unknown, lo: number, hi: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : 0)
  const presses = (i.presses ?? {}) as Partial<Input['presses']>
  const count = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.floor(x) : 0)
  const pair = (x: unknown): [number, number] => (Array.isArray(x) ? [count(x[0]), count(x[1])] : [0, 0])
  return {
    move: [n(i.move?.[0], -1, 1), n(i.move?.[1], -1, 1)],
    yaw: n(i.yaw, -1e6, 1e6),
    pitch: n(i.pitch, -1.5, 1.5),
    jump: i.jump === true,
    hands: [i.hands?.[0] === true, i.hands?.[1] === true],
    presses: { use: pair(presses.use), other: pair(presses.other), throw: pair(presses.throw), pick: count(presses.pick), jump: count(presses.jump) },
  }
}
