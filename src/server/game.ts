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
  FIX_GRACE,
  MATCH_WINS,
  MAX_PLAYERS,
  NO_INPUT,
  COUNTDOWN,
  PATIENCE,
  PATIENCE_DRAIN,
  READY_WAIT,
  REQUEST_COOLDOWN,
  SLOTS,
  VOICES,
  type ArenaStatus,
  type ClientMsg,
  type Input,
  type Lobby,
  type Look,
  type MatchWins,
  type Me,
  type Phase,
  type PlayerInfo,
  type Profile,
  type ServerMsg,
  type Settings,
  type Slot,
  type VoiceName,
  type WardrobePart,
} from '../protocol'
import { recipeOf, thingApi } from '../sim/api'
import { buildArena, checkArena, type ArenaSource } from '../sim/arena'
import { LECTURE_HALL } from '../sim/hall'
import { Bot } from '../sim/bots'
import { compile } from '../sim/sandbox'
import { DT, Sim, type Made, type ThingKind } from '../sim/sim'
import { STARTERS, compileThing, trialThing, type ThingDesign } from '../sim/things'
import type { Designers } from './opus'
import { arenaMessage, linesMessage, thingMessage, wearMessage, type ThingAnswer, type WearAnswer } from './prompts'
import { Store, lineKey, lineText, type ArenaDesign, type LineStock } from './store'
import { phrased, speakerOf, type Phrase, type Speech, type Voice } from './voice'

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
  /** The voice they chose to lead theirs (null: their own, as their key gives it; always for a bot). */
  voice: VoiceName | null
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
  /** When their last taunt has been said (the game's clock): V waits for it and TAUNT_GAP more. */
  speakingUntil: number
  /** Their next taunt, taken and being said in their voice ahead of V (null: none taken yet). */
  nextTaunt: Promise<Taunt | null> | null
  /** V was pressed and the taunt is still being said. */
  tauntWaiting: boolean
  botCrateAt: number
  /** What they will bring to their defence, as last written (empty: something nobody has had). */
  bringWords: string
  /** What they bring to their defence this break, once they were Ready. */
  bring: Bring | null
  /** The crate brought to their defence this round: it counts against no request. */
  defence: string | null
  /** The round they last wrote a review in. */
  reviewed: number
}

interface Taunt {
  /** The line as written, to be said again in another voice. */
  line: Phrase[]
  text: string
  /** The voice it was said in (null: the player's own). */
  voice: VoiceName | null
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

/**
 * A thing brought to one's defence: asked for in the break once the player is Ready, designed at
 * most BRING_AT_ONCE at a time there and bound by no crate's time, and waiting in a crate beside
 * them when the round begins.
 */
interface Bring {
  player: Player
  /** Waiting its turn for a designer, being made, made, or failed (its crate gets a thing from the archive). */
  state: Exclude<PlayerInfo['bringing'], 'none'>
  /** The words it is made from (null: something nobody has had), as they are when its design starts. */
  ask: string | null
  genie: boolean
  /** Its design, once started. */
  design: Promise<ThingKind> | null
  /** Its crate's job, once the round has begun. */
  job: CrateJob | null
}

/** Seconds a player who dropped out (a page reloaded, the network blinked) keeps their doctor in the round, to come back to. */
export const REJOIN = 20
const ROUND_END = 4.5
const MATCH_END = 9
/** Seconds after one's own taunt has been said before the next may start, so a doctor never talks over themselves. */
const TAUNT_GAP = 0.8
/** Seconds a taunt only read lasts, a word (said, the lines take about 0.5 s a word: measured 2026-11-11). */
const READ_WORD = 0.5
const WEAR_TIMEOUT = 70_000
const THING_TIMEOUT = 100_000
/**
 * The share of typed requests the designer twists like a genie ("sometimes ... twist the
 * players words as much as possible"). Decided here: asked to twist "now and then", the model
 * twisted nearly every clear request.
 */
const GENIE = 0.25
/**
 * The share of random-button requests the designer is told to make take no credibility by itself,
 * changing the fight some other way (left alone, it made only weapons: all 76 things kept by
 * 2026-11-10 hurt).
 */
const ASIDE = 1 / 3
/**
 * Things brought to a defence designed at once in a break: half of the four Opus was measured to
 * take at once no slower than one (2026-11-11), the rest left to outfits being made meanwhile.
 */
const BRING_AT_ONCE = 2
const ARENA_TIMEOUT = 480_000
/** Seconds an arena is expected to take while fewer than five are kept to measure by. */
const ARENA_EXPECT = 180
/** Players gone this long are forgotten (their wins with them). */
const FORGET_AFTER = 180

/**
 * Taunts the game has of its own, said only when Haiku has none ready; each only once, ever. In
 * the style Haiku is asked for (LINES_SYSTEM.taunt), split into phrases at their punctuation.
 */
const OWN_TAUNTS = [
  'Stand back, genius at work!',
  'Your thesis? I have read longer menus.',
  'Three doctorates! How dare you push me?',
  'Bow down, my thesis has a sequel!',
  'Careful, this brain is insured!',
  'Your footnotes? Even you skipped them.',
  'Push me, and I stop citing you!',
  'Lovely effort! Almost a real argument.',
  'My bibliography is longer than your thesis!',
  'Silence! The expert is speaking.',
]

export class Game {
  readonly players = new Map<string, Player>()
  phase: Phase = 'dressing'
  private phaseUntil = 0
  round = 0
  sim: Sim | null = null
  settings: Settings = { bots: 0, arena: 'academic', wins: null }
  /** The archive: every thing kept (the starters and the library's), compiled the first time it is drawn into kinds. */
  private readonly archive = new Map<string, ThingDesign>()
  readonly kinds = new Map<string, ThingKind>()
  readonly wardrobe = new Map<string, WardrobePart>()
  private nextArena: ArenaSource | null = null
  private arenaJob: { since: number; expect: number; model: string } | null = null
  private lastArena: string | null = null
  private waitSince: number | null = null
  private winner: string | null = null
  private startedWith = 0
  /** The rounds to win this match by the room, fixed at its first round (null: no match under way). */
  private roomWins: MatchWins | null = null
  private jobs: CrateJob[] = []
  /** This break's things brought to a defence, in the order their players were Ready. */
  private brings: Bring[] = []
  private lobbyDirty = true
  /** The lobby's timer as last sent, to send it again whenever it counts down. */
  private sentTimer: number | null = null
  private seq = 0
  private acc = 0
  private last: number
  private readonly timer: ReturnType<typeof setInterval> | null
  private refilling = { taunt: false, title: false }
  /** OWN_TAUNTS as phrases, each with a tone. */
  private readonly ownTaunts: Phrase[][]
  private closed = false

  constructor(
    private readonly deps: Deps,
    /** False in tests: they call tick() themselves. */
    run = true,
  ) {
    for (const w of STARTER_WEAR) this.addWear({ ...w, ask: '', by: '' })
    for (const w of deps.store.wear.values()) this.addWear(w)
    // Compiled when drawn: compiling all 81 kept here held the game's first answer to a page 0.4 s
    // (measured 2026-11-11).
    for (const d of [...STARTERS, ...deps.store.things.values()]) this.archive.set(d.id, d)
    this.ownTaunts = OWN_TAUNTS.map((t) => phrased(t, deps.random))
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
    this.send(p, { type: 'welcome', you: p.id, ownVoice: speakerOf(p.key, null).own[0][0] })
    this.send(p, { type: 'wardrobe', parts: [...this.wardrobe.values()] })
    this.sendProfile(p)
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
      voice: null,
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
      speakingUntil: -10,
      nextTaunt: null,
      tauntWaiting: false,
      botCrateAt: 0,
      bringWords: '',
      bring: null,
      defence: null,
      reviewed: 0,
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
        // Ready, what they bring takes its turn to be made: once a break (Ready again after a reload, its turn may have come).
        if (p.ready && this.phase === 'dressing' && this.deps.designers) {
          this.bringOf(p)
          this.startBrings()
        }
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
      case 'bring':
        // Written in the dressing room for the round to come (a page's last word may land after it began).
        if (this.phase === 'dressing' && typeof msg.text === 'string') p.bringWords = msg.text.trim().slice(0, 400)
        return
      case 'review':
        if (typeof msg.target === 'string' && typeof msg.text === 'string' && msg.text.trim()) this.review(p, msg.target, msg.text.trim().slice(0, 200))
        return
      case 'taunt':
        this.taunt(p)
        return
      case 'settings':
        if (this.chair() !== p || msg.settings === null || typeof msg.settings !== 'object') return
        this.settings = {
          bots: Math.max(0, Math.min(MAX_PLAYERS - 1, Math.round(Number(msg.settings.bots) || 0))),
          arena: msg.settings.arena === 'anything' ? 'anything' : 'academic',
          wins: MATCH_WINS.find((w) => w === msg.settings.wins) ?? null,
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
    // One of the voices offered, or their own (an unknown one too: a page's hello hears back which).
    const voice = VOICES.find((v) => v === profile.voice) ?? null
    if (voice !== p.voice) {
      p.voice = voice
      // The taunt said ahead in the voice before is said again in this one, so V lets them hear it.
      if (p.nextTaunt) p.nextTaunt = p.nextTaunt.then((t) => (t && t.voice !== p.voice ? this.said(p, t.line) : t))
    }
    if (p.name && !p.nextTaunt) p.nextTaunt = this.prepareTaunt(p)
    this.lobbyDirty = true
  }

  /** The player's own profile as the server has it, to their page. */
  private sendProfile(p: Player): void {
    this.send(p, { type: 'profile', profile: { name: p.name, title: p.title, look: p.look, voice: p.voice } })
  }

  private giveTitle(p: Player): void {
    const title = this.takeLine('title', this.deps.store.lines.titles, [])
    if (title) {
      p.title = title
      this.sendProfile(p)
      this.lobbyDirty = true
    }
  }

  // ---------------------------------------------------------------------------- lines

  /** A line never handed out before (from the stock, else from `own`), or null when none is ready. */
  private takeLine<T extends string | Phrase[]>(kind: 'taunt' | 'title', stock: LineStock<T>, own: T[]): T | null {
    const used = new Set(stock.used.map(lineKey))
    const fresh = (l: T) => !used.has(lineKey(lineText(l)))
    let line = stock.ready.shift() ?? null
    while (line !== null && !fresh(line)) line = stock.ready.shift() ?? null
    line ??= own.find(fresh) ?? null
    if (line !== null) {
      stock.used.push(lineText(line))
      this.deps.store.saveLines()
    }
    this.refill(kind)
    return line
  }

  private refill(kind: 'taunt' | 'title'): void {
    const designers = this.deps.designers
    if (!designers) return
    const clean = (t: string) => t.trim().replace(/^["'\d.\-\s]+|["']+$/g, '').slice(0, 200)
    const lines = this.deps.store.lines
    if (kind === 'taunt') this.restock(kind, lines.taunts, (m) => designers.taunts(m).then((ls) => ls.map((l) => l.map((p) => ({ text: clean(p.text), tone: p.tone })).filter((p) => p.text))))
    else this.restock(kind, lines.titles, (m) => designers.titles(m).then((ls) => ls.map(clean)))
  }

  /** Twelve more lines asked for while fewer than six are ready, each unlike any written. */
  private restock<T extends string | Phrase[]>(kind: 'taunt' | 'title', stock: LineStock<T>, write: (message: string) => Promise<T[]>): void {
    if (this.refilling[kind] || stock.ready.length >= 6 || this.closed) return
    this.refilling[kind] = true
    const avoid = [...stock.used, ...stock.ready.map(lineText)]
    write(linesMessage(12, avoid))
      .then((lines) => {
        const seen = new Set(avoid.map(lineKey))
        for (const line of lines) {
          const text = lineText(line)
          if (text.length < 6 || seen.has(lineKey(text))) continue
          seen.add(lineKey(text))
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
   * A player's next taunt: a line taken now and said in their voice ahead of time (about a second),
   * so V is heard at once. Null when no line is ready.
   */
  private prepareTaunt(p: Player): Promise<Taunt | null> {
    const line = this.takeLine('taunt', this.deps.store.lines.taunts, this.ownTaunts)
    return line ? this.said(p, line) : Promise.resolve(null)
  }

  /** A line said in the player's voice as it is now; only read when there is no voice or it failed. */
  private said(p: Player, line: Phrase[]): Promise<Taunt> {
    const text = lineText(line)
    const voice = p.voice
    if (!this.deps.voice) return Promise.resolve({ line, text, voice, speech: null })
    return this.deps.voice.say(line, p.key, voice).then(
      (speech) => ({ line, text, voice, speech }),
      (err: Error) => {
        if (!this.closed) this.deps.log(`voice: "${text}" was not said: ${err.message}`)
        return { line, text, voice, speech: null }
      },
    )
  }

  private taunt(p: Player): void {
    if (this.now() < p.speakingUntil + TAUNT_GAP || !p.name || p.tauntWaiting) return
    const next = p.nextTaunt ?? this.prepareTaunt(p)
    p.nextTaunt = null
    p.tauntWaiting = true
    void next.then((t) => {
      p.tauntWaiting = false
      if (this.closed) return
      if (!t) return this.note(p, 'No taunt is ready yet.')
      const d = this.sim?.doctors.get(p.id)
      const at = d && this.phase !== 'dressing' ? this.sim!.eyeOf(d) : null
      this.broadcast({ type: 'taunt', by: p.id, text: t.text, at, voice: t.speech?.mp3 ?? null })
      this.deps.store.append({ kind: 'taunt', by: p.name, text: t.text, ...(t.speech && { tones: t.speech.tones, secs: Math.round(t.speech.secs * 10) / 10, ms: t.speech.ms }) })
      p.speakingUntil = this.now() + (t.speech ? t.speech.secs : t.text.split(/\s+/).length * READ_WORD)
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
        this.sendProfile(p)
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
    // In the countdown too: the doctor cannot move then anyway.
    if (!sim || (this.phase !== 'round' && this.phase !== 'countdown')) return this.note(p, 'Crates come only during a round.')
    const d = sim.doctors.get(p.id)
    if (!d?.alive) return this.note(p, 'You are out of this round.')
    d.writing = false
    if (now < p.cooldownUntil) return this.note(p, `Wait ${Math.ceil(p.cooldownUntil - now)} s.`)
    if (this.crateComing(sim, p)) return this.note(p, 'Your crate is still coming.')
    const genie = ask !== null && this.deps.random() < GENIE
    const aside = ask === null && this.deps.random() < ASIDE
    const crate = sim.dropCrate(p.id, ask)
    if (!crate) return
    p.cooldownUntil = now + REQUEST_COOLDOWN
    const curse = sim.takeCurse(p.id)
    const job: CrateJob = { crate: crate.id, sim, deadline: now + DESIGN_LIMIT, filled: false, player: p.id }
    this.jobs.push(job)
    if (!this.deps.designers) {
      this.fill(job, this.fallbackKind(), { archive: true }, 'Opus is not here: a thing from the archive.')
      return
    }
    this.note(p, `${capital(this.deps.designers.next())} is designing it.`)
    const design = this.designThing({ ask, by: p.name, curse, genie, aside }, () => job.deadline, () => this.sentBack(job))
    design.catch((err: Error) => this.deps.log(`design for ${p.name}: ${err.message}`))
    this.follow(job, design, { archive: false, genie, curse })
  }

  /** A crate the player asked for in this round is still coming or unopened (the one brought to their defence counts for nothing). */
  private crateComing(sim: Sim, p: Player): boolean {
    return [...sim.crates.values()].some((c) => c.owner === p.id && c.id !== p.defence)
  }

  /**
   * A crate waits for its design: filled with it when it comes, or, when it comes after the
   * archive's thing filled the crate, in its place while nobody has opened it; from the archive
   * when the design fails.
   */
  private follow(job: CrateJob, design: Promise<ThingKind>, made: Made): void {
    design.then(
      (kind) => {
        if (!job.filled) return this.fill(job, kind, made, `Ready: ${kind.name}.`)
        const p = this.players.get(job.player)
        if (job.sim === this.sim && job.sim.crates.has(job.crate)) {
          job.sim.fillCrate(job.crate, kind, made)
          if (p) this.note(p, `It made it after all: ${kind.name}.`)
        } else if (p) this.note(p, `${kind.name} came too late for that crate; it is in the archive now.`)
      },
      () => {
        if (!job.filled) this.fill(job, this.fallbackKind(), { archive: true }, 'The design failed: a thing from the archive.')
      },
    )
  }

  private fill(job: CrateJob, kind: ThingKind, made: Made, note: string): void {
    job.filled = true
    if (job.sim !== this.sim) return
    job.sim.fillCrate(job.crate, kind, made)
    const p = this.players.get(job.player)
    if (p) this.note(p, note)
  }

  /** A crate's design failed its trial and went back to be fixed: the crate waits FIX_GRACE longer for it, and its asker is told. */
  private sentBack(job: CrateJob): void {
    if (job.filled || job.sim !== this.sim) return
    job.deadline += FIX_GRACE
    const p = this.players.get(job.player)
    if (p) this.note(p, `It failed its trial and went back to be fixed: ${FIX_GRACE} s more.`)
  }

  /** A thing from the archive, at random: one that will not compile is logged and left out of it. */
  private fallbackKind(): ThingKind {
    for (;;) {
      const ids = [...this.archive.keys()]
      if (!ids.length) throw new Error('nothing in the archive compiles')
      const id = ids[Math.floor(this.deps.random() * ids.length)]!
      let kind = this.kinds.get(id)
      if (!kind) {
        try {
          kind = compileThing(this.archive.get(id)!)
        } catch (err) {
          this.deps.log(`thing ${id} would not compile: ${(err as Error).message}`)
          this.archive.delete(id)
          continue
        }
        this.kinds.set(id, kind)
      }
      return kind
    }
  }

  /**
   * A thing designed from a request (tried, kept in the library), or the reason none passed.
   * deadline: when its crate falls back to the archive, as it is when each try is asked (null: no
   * crate waits for it yet), for the picker to judge the model by; onFix is called when a first
   * try goes back to be fixed (before the second is asked).
   */
  private async designThing(req: { ask: string | null; by: string; curse: string | null; genie: boolean; aside: boolean }, deadline: () => number | null, onFix: () => void): Promise<ThingKind> {
    const designers = this.deps.designers!
    const { ask, by, curse, genie, aside } = req
    const avoid = ask === null ? [...this.archive.values()].map((d) => d.name) : []
    const t0 = this.now()
    let fix: { answer: ThingAnswer; problems: string[] } | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      if (fix) onFix()
      const until = deadline()
      const a = await designers.thing(thingMessage({ ...req, avoid, fix }), THING_TIMEOUT, until === null ? null : Math.max(0, Math.round((until - this.now()) * 1000)))
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
      this.deps.store.append({ kind: 'thing', by, ask, curse, genie, aside, model: a.model, ms: design.ms, id, name: design.name, problems, ...(problems.length ? { look: design.look, code: design.code } : {}) })
      if (problems.length === 0 && kind) {
        this.deps.store.saveThing(design)
        this.archive.set(id, design)
        this.kinds.set(id, kind)
        return kind
      }
      fix = { answer, problems: problems.slice(0, 8) }
    }
    throw new Error('no design passed its trial')
  }

  // ---------------------------------------------------------------------------- brought to a defence

  /** What a player brings to their defence this break: a new one waits its turn for a designer. */
  private bringOf(p: Player): Bring {
    if (!p.bring) {
      p.bring = { player: p, state: 'queued', ask: null, genie: false, design: null, job: null }
      this.brings.push(p.bring)
    }
    return p.bring
  }

  /**
   * Starts this break's brought things in turn, at most BRING_AT_ONCE being made at once, for the
   * players still here (one who left starts when they are back and a turn comes, or at the round's
   * start if they play it); none once the game has closed.
   */
  private startBrings(): void {
    if (this.closed) return
    let making = this.brings.filter((b) => b.state === 'making').length
    for (const b of this.brings) {
      if (making >= BRING_AT_ONCE) return
      if (b.state !== 'queued' || !b.player.conn) continue
      this.startBring(b, null)
      making++
    }
  }

  /**
   * A brought thing's design starts, from the words the player has written by now (the last words
   * win). deadline: when its crate falls back to the archive (null in the break: no crate yet).
   */
  private startBring(b: Bring, deadline: number | null): void {
    const p = b.player
    b.state = 'making'
    b.ask = p.bringWords || null
    b.genie = b.ask !== null && this.deps.random() < GENIE
    const aside = b.ask === null && this.deps.random() < ASIDE
    b.design = this.designThing({ ask: b.ask, by: p.name, curse: null, genie: b.genie, aside }, () => (b.job ? b.job.deadline : deadline), () => {
      if (b.job) this.sentBack(b.job)
    })
    b.design
      .then(
        () => {
          b.state = 'ready'
          if (!b.job) this.note(p, 'What you bring is made. It waits beside you when the round begins.')
        },
        (err: Error) => {
          b.state = 'failed'
          this.deps.log(`brought by ${p.name}: ${err.message}`)
          if (!b.job) this.note(p, 'What you bring failed its design: a thing from the archive waits for you instead.')
        },
      )
      .finally(() => {
        this.lobbyDirty = true
        this.startBrings()
      })
    this.lobbyDirty = true
  }

  /**
   * The crate beside a doctor as the round begins, with what they brought to their defence, under
   * a crate's rules: filled when its design is done, or from the archive DESIGN_LIMIT seconds into
   * the round. One still waiting its turn starts now, past the break's BRING_AT_ONCE (its crate's
   * time runs), and a player never Ready brings what they last wrote, made from now; a bot, and
   * everyone when nothing new can be made, a thing from the archive at once.
   */
  private defend(sim: Sim, p: Player, now: number): void {
    if (p.bot || !this.deps.designers) {
      const crate = sim.dropCrate(p.id, null)!
      p.defence = crate.id
      return sim.fillCrate(crate.id, this.fallbackKind(), { archive: true })
    }
    const deadline = now + COUNTDOWN + DESIGN_LIMIT
    const b = this.bringOf(p)
    if (b.state === 'queued') this.startBring(b, deadline)
    const crate = sim.dropCrate(p.id, b.ask)!
    p.defence = crate.id
    b.job = { crate: crate.id, sim, deadline, filled: false, player: p.id }
    this.jobs.push(b.job)
    this.follow(b.job, b.design!, { archive: false, genie: b.genie, curse: null })
  }

  // ---------------------------------------------------------------------------- reviews

  /**
   * A dismissed player's review of a doctor still in: once a round, laid on that doctor's next
   * request as a curse by them (the designer follows it before reading their words).
   */
  private review(p: Player, target: string, text: string): void {
    const no = this.noReview(p)
    if (no) return this.note(p, no)
    const sim = this.sim!
    const t = sim.doctors.get(target)
    if (!t?.alive) return this.note(p, 'They are out of this round.')
    // A review lies on a request, and bots ask for nothing: on one it would never bite.
    if (t.bot) return this.note(p, `${t.name} is a bot and asks for nothing: review a doctor who asks.`)
    if (t.curse) return this.note(p, `${t.name} is already under review.`)
    sim.curse(t, text, 1, p.id)
    p.reviewed = this.round
    this.deps.store.append({ kind: 'review', by: p.name, of: t.name, text })
    this.note(p, `Your review of ${t.name} is lodged.`)
  }

  /** Why a player may not write a review now, or null: they may (dismissed in a round, with a name, none written yet this round). */
  private noReview(p: Player): string | null {
    if (this.phase !== 'round') return 'Reviews are written during a round.'
    if (!p.name) return 'Give your doctor a name first.'
    if (this.sim!.doctors.get(p.id)!.alive) return 'Only the dismissed write reviews.'
    if (p.reviewed === this.round) return 'One review a round.'
    return null
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
      p.title = this.takeLine('title', this.deps.store.lines.titles, []) ?? 'On the Unexamined Properties of Things'
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
    const now = this.now()
    const playing = this.playing()
    for (const p of playing) {
      // A bot's plans are in its round's time, which starts at 0 again: one kept from the last
      // round walked to where it last stepped round something and stood there, its hands idle, for
      // as long as that round had lasted.
      if (p.bot) p.bot = new Bot(p.id, this.deps.random)
      sim.addDoctor(p.id, p.name, p.bot !== null)
      sim.setInput(p.id, p.input)
      sim.syncPresses(p.id)
    }
    // The physics world's queries see what was built and added only from a step: one now, so the
    // crates brought to a defence come in beside their doctors, not on top of them.
    sim.world.step()
    for (const p of this.players.values()) {
      p.defence = null
      if (playing.includes(p)) this.defend(sim, p, now)
      p.bring = null
      p.bringWords = ''
      p.cooldownUntil = 0
      p.botCrateAt = now + 12 + this.deps.random() * 20
      if (!p.bot) p.ready = false
    }
    this.brings = []
    for (const p of this.players.values()) if (p.conn && !sim.doctors.has(p.id)) this.spectate(p)
    // The doctors who play: a page here without a name watches, and counts for neither.
    this.startedWith = playing.length
    this.roomWins ??= winsForRoom(playing.length)
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

  /** Who plays when a round starts: the bots, and everyone here with a name. */
  private playing(): Player[] {
    return [...this.players.values()].filter((p) => p.bot || (p.conn && p.name))
  }

  /** The rounds to win this match: the chair's choice, else the room's (fixed at the match's first round; before it, as the room is now). */
  private matchWins(): MatchWins {
    return this.settings.wins ?? this.roomWins ?? winsForRoom(this.playing().length)
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
          this.sim!.goLive()
          // The next request is a cooldown away for everyone, asked in the countdown or not.
          for (const p of this.players.values()) p.cooldownUntil = Math.max(p.cooldownUntil, now + REQUEST_COOLDOWN)
          this.setPhase('round', 0)
        }
        break
      case 'round': {
        const sim = this.sim!
        // The committee's patience: past it, everyone still in loses credibility every second.
        if (sim.time > PATIENCE && Math.floor(sim.time) !== Math.floor(sim.time - DT * 2)) {
          for (const d of sim.alive()) sim.harm(d, PATIENCE_DRAIN, { attacker: 'committee', thing: null, fists: null, what: "the committee's patience" })
        }
        const alive = sim.alive()
        if (this.startedWith >= 2 && alive.length <= 1) this.endRound(alive[0]?.id ?? null)
        else if (this.present().length === 0) this.endRound(null)
        break
      }
      case 'roundEnd':
        if (now >= this.phaseUntil) {
          // The most wins, should the chair have set fewer than more than one doctor has.
          const champion = [...this.players.values()].filter((p) => p.wins >= this.matchWins()).sort((a, b) => b.wins - a.wins)[0]
          if (champion) {
            this.winner = champion.id
            this.setPhase('matchEnd', MATCH_END)
          } else this.toDressing()
        }
        break
      case 'matchEnd':
        if (now >= this.phaseUntil) {
          for (const p of this.players.values()) p.wins = 0
          this.roomWins = null
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
          this.fill(job, this.fallbackKind(), { archive: true }, 'Opus took too long: a thing from the archive.')
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
          crate: this.crateComing(sim, p),
          ...sim.me(p.id),
          note: p.note && p.note.until > now ? p.note.text : null,
          review: this.noReview(p) === null,
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
      if (!sim.doctors.get(p.id)?.alive || this.crateComing(sim, p)) continue
      const crate = sim.dropCrate(p.id, null)
      if (crate) sim.fillCrate(crate.id, this.fallbackKind(), { archive: true })
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
      .map((p) => ({ id: p.id, name: p.name, title: p.title, look: p.look, color: p.color, bot: p.bot !== null, ready: p.bot !== null || p.ready, dressing: p.dressing, wins: p.wins, chair: p === chair, connected: p.conn !== null || p.bot !== null, bringing: p.bring?.state ?? 'none' }))
    const arena: ArenaStatus = this.nextArena ? { state: 'ready', name: this.nextArena.name } : this.arenaJob ? { state: 'building', since: Math.round(now - this.arenaJob.since), expect: this.arenaJob.expect, model: this.arenaJob.model } : { state: 'none' }
    const timer = this.countdown(now)
    const winner = this.winner ? (this.players.get(this.winner)?.name ?? null) : null
    return { players, settings: this.settings, phase: this.phase, timer, round: this.round, arena, winner, wins: this.matchWins(), join: this.deps.join }
  }
}

const capital = (s: string) => s.slice(0, 1).toUpperCase() + s.slice(1)

/** The rounds to win a match left to the room: fewer in a bigger room (first to 5 among 8 equal doctors took a median 19 rounds). */
const winsForRoom = (doctors: number): MatchWins => (doctors <= 3 ? 5 : doctors <= 5 ? 4 : 3)

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
