/**
 * The page's side of the WebSocket: it says hello with this browser's key and profile, keeps
 * what the server sends (the lobby, the arena, the models, the wardrobe, the last snapshots),
 * hands snapshot events to whoever listens, and reconnects when the socket drops (a new game
 * after the server's code changed, or the host's computer waking up). The profile (name, title, look)
 * lives in this browser's localStorage and goes with every hello.
 */

import { randomLook } from './doctor'
import { WS_PATH, type ArenaView, type ClientMsg, type GameEvent, type Input, type Lobby, type Me, type Profile, type Recipe, type ServerMsg, type Snap, type Vec3, type WardrobePart } from './protocol'

const KEY = 'dissertation-key'
const PROFILE = 'dissertation-profile'

function stored<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : null
  } catch {
    return null
  }
}

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private windows may refuse; the profile then lasts as long as the page.
  }
}

export interface TauntHeard {
  by: string
  text: string
  at: Vec3 | null
  /** The line in the doctor's voice, MP3 in base64 (null: only read). */
  voice: string | null
  /** performance.now() when it came. */
  when: number
}

/** A snapshot with when it came, in this page's clock (ms). */
export interface Received {
  snap: Snap
  at: number
}

export class Net {
  you: string | null = null
  lobby: Lobby | null = null
  arena: ArenaView | null = null
  readonly models = new Map<string, Recipe>()
  readonly wardrobe = new Map<string, WardrobePart>()
  /** The newest snapshots, oldest first. */
  readonly snaps: Received[] = []
  me: Me | null = null
  profile: Profile
  connected = false
  refused: string | null = null
  note: { text: string; until: number } | null = null
  /** Bumps on every change the React side should see. */
  version = 0
  private ws: WebSocket | null = null
  private readonly listeners = new Set<() => void>()
  private readonly eventListeners = new Set<(e: GameEvent, snap: Snap) => void>()
  private readonly tauntListeners = new Set<(t: TauntHeard) => void>()
  private retry = 500
  private readonly key: string

  constructor() {
    let key = stored<string>(KEY)
    if (!key) {
      key = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')
      store(KEY, key)
    }
    this.key = key
    this.profile = stored<Profile>(PROFILE) ?? { name: '', title: '', look: randomLook(Math.random, { hair: 'wild-white-hair' }) }
    this.open()
  }

  private open(): void {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${WS_PATH}`)
    this.ws = ws
    ws.onopen = () => {
      this.connected = true
      this.retry = 500
      this.send({ type: 'hello', key: this.key, profile: this.profile })
      this.changed()
    }
    ws.onmessage = (e) => this.receive(JSON.parse(String(e.data)) as ServerMsg)
    ws.onclose = () => {
      this.connected = false
      this.ws = null
      this.changed()
      if (this.refused) return
      setTimeout(() => this.open(), this.retry)
      this.retry = Math.min(5000, this.retry * 1.6)
    }
  }

  private receive(msg: ServerMsg): void {
    switch (msg.type) {
      case 'welcome':
        this.you = msg.you
        break
      case 'lobby':
        this.lobby = msg.lobby
        break
      case 'arena':
        this.arena = msg.arena
        this.snaps.length = 0
        break
      case 'models':
        for (const [id, r] of Object.entries(msg.models)) this.models.set(id, r)
        break
      case 'wardrobe':
        for (const p of msg.parts) this.wardrobe.set(p.id, p)
        break
      case 'snap': {
        this.me = msg.me
        this.snaps.push({ snap: msg.snap, at: performance.now() })
        if (this.snaps.length > 30) this.snaps.splice(0, this.snaps.length - 30)
        for (const e of msg.snap.events) {
          // The arena as it is now, for a drawing of it made later.
          if (e.type === 'break') this.arena?.broken.push(e.piece)
          for (const l of this.eventListeners) l(e, msg.snap)
        }
        // Snapshots come 60 times a second: React hears of them only through the HUD's own beat.
        return
      }
      case 'taunt':
        for (const l of this.tauntListeners) l({ by: msg.by, text: msg.text, at: msg.at, voice: msg.voice, when: performance.now() })
        return
      case 'profile':
        this.profile = msg.profile
        store(PROFILE, this.profile)
        break
      case 'note':
        this.note = { text: msg.text, until: performance.now() + 6000 }
        break
      case 'refused':
        this.refused = msg.why
        break
    }
    this.changed()
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  sendInput(input: Input): void {
    this.send({ type: 'input', input })
  }

  /** Changes the profile here and on the server. */
  setProfile(p: Profile): void {
    this.profile = p
    store(PROFILE, p)
    this.send({ type: 'profile', profile: p })
    this.changed()
  }

  private changed(): void {
    this.version++
    for (const l of this.listeners) l()
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  onEvent(l: (e: GameEvent, snap: Snap) => void): () => void {
    this.eventListeners.add(l)
    return () => this.eventListeners.delete(l)
  }

  onTaunt(l: (t: TauntHeard) => void): () => void {
    this.tauntListeners.add(l)
    return () => this.tauntListeners.delete(l)
  }

  latest(): Received | null {
    return this.snaps.at(-1) ?? null
  }

  player(id: string) {
    return this.lobby?.players.find((p) => p.id === id) ?? null
  }
}
