/**
 * Where the page's sounds are heard: the browser's audio, set out as a space (2026-11-10:
 * "could we improve the sound design? make the sounds much much more realistic?").
 *
 * - The listener is the camera (World moves it every frame). Each sound in the world is placed in
 *   3D with the browser's head-related panning, gets quieter and duller with distance (the air
 *   takes the highs), and is muffled when the arena stands between it and the ear (World says
 *   what stands where).
 * - Every sound also goes into the room: an echo made for each arena from its size, what its
 *   surfaces are made of and how much of it is open to the sky (a stone hall rings, a library is
 *   dead, a ship's deck is open air).
 * - Voices carry as voices do: further, clearer through a wall and with less echo than other
 *   sounds, and the other sounds dip a little while a voice near the ear is heard (2026-11-11), so
 *   a taunt's words come through the fight.
 * - The sounds themselves are recordings (CC0, from OpenGameArt, built into sounds/ by
 *   `npm install`; scripts/sounds/README.md says which), several of each, picked at random and at a slightly different pitch every time
 *   so no two are the same. sounds/library.json lists them; they load in the background after
 *   the first click, and until one has, its caller may draw a sound of its own.
 */

import { options } from './options'
import type { Vec3 } from './protocol'

let ctx: AudioContext | null = null
let master: GainNode | null = null
/** The room's echo: what is sent here comes back through the room. */
let wet: GainNode | null = null
let convolver: ConvolverNode | null = null
/** Every sound but the voices, and its share of the echo: the way the voices duck them. */
let others: { dry: GainNode; wet: GainNode } | null = null

export function audio(): AudioContext | null {
  return ctx && ctx.state === 'running' ? ctx : null
}

/** Starts the audio on the first click or key (browsers want a gesture), and the recordings loading. */
export function wakeAudio(): void {
  ctx ??= new AudioContext()
  if (ctx.state === 'suspended') void ctx.resume()
  if (!master) {
    master = ctx.createGain()
    master.connect(ctx.destination)
    convolver = ctx.createConvolver()
    convolver.buffer = roomEcho(ctx, ROOM)
    wet = ctx.createGain()
    wet.gain.value = ROOM.wet
    wet.connect(convolver).connect(master)
    others = { dry: ctx.createGain(), wet: ctx.createGain() }
    others.dry.connect(master)
    others.wet.connect(wet)
    void loadLibrary()
  }
}

/** Every sound's way out: at the options' volume. */
export function mainOut(): AudioNode | null {
  const c = audio()
  if (!c || !master) return null
  master.gain.value = options().volume
  return master
}

// ------------------------------------------------------------------------------ the listener

/** The ear: where it is and which way it looks (World sets it every frame from the camera). */
const ear = { at: [0, 1.6, 0] as Vec3, forward: [0, 0, -1] as Vec3, up: [0, 1, 0] as Vec3 }

export function setListener(at: Vec3, forward: Vec3, up: Vec3): void {
  ear.at = at
  ear.forward = forward
  ear.up = up
  const c = ctx
  if (!c) return
  const l = c.listener
  if (l.positionX) {
    const t = c.currentTime
    l.positionX.setTargetAtTime(at[0], t, 0.01)
    l.positionY.setTargetAtTime(at[1], t, 0.01)
    l.positionZ.setTargetAtTime(at[2], t, 0.01)
    l.forwardX.setTargetAtTime(forward[0], t, 0.01)
    l.forwardY.setTargetAtTime(forward[1], t, 0.01)
    l.forwardZ.setTargetAtTime(forward[2], t, 0.01)
    l.upX.setTargetAtTime(up[0], t, 0.01)
    l.upY.setTargetAtTime(up[1], t, 0.01)
    l.upZ.setTargetAtTime(up[2], t, 0.01)
  } else {
    l.setPosition(...at)
    l.setOrientation(...forward, ...up)
  }
}

export function earAt(): Vec3 {
  return ear.at
}

/** What stands between a sound and the ear: World sets it to a test against the arena. */
let occluded: (from: Vec3, to: Vec3) => boolean = () => false
export function setOccluder(fn: (from: Vec3, to: Vec3) => boolean): void {
  occluded = fn
}

// ------------------------------------------------------------------------------ the room

export interface Room {
  /** Seconds the echo takes to die away (to a thousandth). */
  decay: number
  /** How much of a sound comes back as echo, 0..1. */
  wet: number
  /** Metres to the nearest walls, for the first reflections. */
  size: number
  /** 0 bright (stone, glass), 1 dark (books, cloth): how fast the highs die. */
  dark: number
}

/** Before an arena: a middling room. */
const ROOM: Room = { decay: 1.2, wet: 0.22, size: 12, dark: 0.4 }

/** The arena's echo, as World works it out when an arena is built. */
export function setRoom(room: Room): void {
  const c = ctx
  if (!c || !convolver || !wet) {
    Object.assign(ROOM, room)
    return
  }
  Object.assign(ROOM, room)
  convolver.buffer = roomEcho(c, room)
  wet.gain.setTargetAtTime(room.wet, c.currentTime, 0.1)
}

/**
 * An impulse response for a room: a few early reflections off the walls, then a tail of noise
 * dying away over `decay`, its highs dying faster the darker the room, a little different in each
 * ear.
 */
function roomEcho(c: AudioContext, room: Room): AudioBuffer {
  const rate = c.sampleRate
  const secs = Math.min(5, Math.max(0.3, room.decay))
  const n = Math.floor(rate * secs)
  const buf = c.createBuffer(2, n, rate)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    let low = 0
    for (let i = 0; i < n; i++) {
      const t = i / rate
      const env = Math.exp((-6.9 * t) / secs)
      // A one-pole filter closing as the tail goes on: the highs go first in a dark room.
      const k = Math.min(1, 0.9 - room.dark * 0.75 * Math.min(1, t / secs) + 0.1)
      low += (Math.random() * 2 - 1 - low) * Math.max(0.02, k)
      d[i] = low * env * (t < 0.004 ? t / 0.004 : 1)
    }
    // Early reflections: the walls at their distances, softer each time, each a few milliseconds of
    // scattered sound (a single sharp copy would ring like a comb, metallic).
    const spread = Math.floor(rate * 0.004)
    for (let r = 1; r <= 6; r++) {
      const dist = room.size * (0.5 + 0.35 * r + 0.13 * ((r * 7 + ch * 3) % 5))
      const at = Math.floor((dist / 343) * rate)
      for (let j = 0; j < spread && at + j < n; j++) d[at + j]! += (Math.random() * 2 - 1) * 0.35 * Math.pow(0.7, r) * Math.exp((-4 * j) / spread)
    }
  }
  return buf
}

// ------------------------------------------------------------------------------ the recordings

interface Entry {
  files: string[]
  /** Loudness, times the recording's own (they are levelled when made). */
  gain: number
}

let library: Record<string, Entry> = {}
const buffers = new Map<string, AudioBuffer[]>()
const lastPicked = new Map<string, number>()
/** sounds/, wherever the page is opened from (Vite rewrites the address without its last slash). */
const BASE = new URL('../sounds/', import.meta.url).href.replace(/\/?$/, '/')

async function loadLibrary(): Promise<void> {
  try {
    library = (await (await fetch(`${BASE}library.json`)).json()) as Record<string, Entry>
  } catch {
    return
  }
  // Everything, a few at a time, in the background.
  const names = Object.keys(library)
  const next = async (): Promise<void> => {
    const name = names.shift()
    if (!name) return
    await load(name)
    return next()
  }
  await Promise.all([next(), next(), next(), next()])
}

async function load(name: string): Promise<void> {
  const c = ctx
  const e = library[name]
  if (!c || !e || buffers.has(name)) return
  buffers.set(name, [])
  for (const f of e.files) {
    try {
      const data = await (await fetch(`${BASE}${name}/${f}`)).arrayBuffer()
      buffers.get(name)!.push(await c.decodeAudioData(data))
    } catch {
      // A recording that will not load is left out.
    }
  }
}

/** Whether there are recordings of a sound (loaded or not). */
export const recorded = (name: string): boolean => name in library

/** One of a sound's recordings, not the one played last when there are others; null while none has loaded. */
function pick(name: string): AudioBuffer | null {
  const list = buffers.get(name)
  if (!list?.length) {
    void load(name)
    return null
  }
  let i = Math.floor(Math.random() * list.length)
  if (list.length > 1 && i === lastPicked.get(name)) i = (i + 1) % list.length
  lastPicked.set(name, i)
  return list[i]!
}

// ------------------------------------------------------------------------------ playing

export interface Placed {
  /** Where the sound is (null: in the ear). */
  at: Vec3 | null
  pitch: number
  volume: number
}

/** A sound's way to the ear: the node to play into, and moving it as what makes it moves. */
export interface Route {
  into: AudioNode
  /** Where the sound is now (a voice follows its doctor); a sound in the ear stays there. */
  moveTo(at: Vec3): void
}

/** What a sound is, for how it carries to the ear. */
export type Kind = 'sound' | 'voice'

interface Carry {
  /** Metres within which it is as loud as made, and how fast it falls away beyond (the browser's inverse distance model). */
  refDistance: number
  rolloff: number
  /** The most of it that goes into the room's echo, however far it is. */
  echoMax: number
  /** Behind a wall: what the air leaves of its highs cut to 6%, but never below this (Hz), and its loudness times `wallGain`. */
  wallLowpass: number
  wallGain: number
}

/**
 * How each kind carries (to tune by ear). Through the sounds' curve, a taunt was 17 dB down at
 * 10 m and 20 at 15 m, mostly echo (the echo does not fall with distance), and a wall muffled it
 * to about 1 kHz: friends 15 m away read the subtitle and heard a murmur. A voice's own curve is
 * about 9 dB down at 15 m, at most 0.35 of it echoes, and a wall leaves it 2.5 kHz and 0.7 of its
 * loudness.
 */
const CARRY: Record<Kind, Carry> = {
  sound: { refDistance: 1.6, rolloff: 1.1, echoMax: 0.9, wallLowpass: 0, wallGain: 0.55 },
  voice: { refDistance: 4, rolloff: 0.7, echoMax: 0.35, wallLowpass: 2500, wallGain: 0.7 },
}

/** Seconds between looks for a wall between a moving sound and the ear, and how long a change takes. */
const WALL_CHECK = 0.25
const WALL_RAMP = 0.15

/** While a voice within `within` metres is heard, every other sound dips `db`, down over `attack` seconds and back over `release` after it. */
const DUCK = { within: 12, db: -4, attack: 0.08, release: 0.4 }
/** Voices near the ear now: the other sounds are down while there is any. */
let ducking = 0

/**
 * A voice's dip of the other sounds: tell what it returns how far the voice is from the ear as it
 * goes (the other sounds are down while it is within DUCK.within), and Infinity when it ends.
 */
export function ducker(): (distance: number) => void {
  let near = false
  return (distance) => {
    const c = ctx
    if (!c || !others || (distance <= DUCK.within) === near) return
    near = !near
    if (near ? ducking++ > 0 : --ducking > 0) return
    for (const g of [others.dry.gain, others.wet.gain]) {
      g.cancelScheduledValues(c.currentTime)
      g.setTargetAtTime(near ? 10 ** (DUCK.db / 20) : 1, c.currentTime, (near ? DUCK.attack : DUCK.release) / 3)
    }
  }
}

/**
 * The way a sound goes from where it is to the ear: its loudness, the air's and any wall's
 * dulling, its place in 3D, and a share of it into the room, as its kind carries. Null when it is
 * too far to hear. Moved, it looks for a wall in the way again every WALL_CHECK seconds.
 */
export function route(p: Placed, kind: Kind): Route | null {
  const c = audio()
  const out = mainOut()
  if (!c || !out || !wet || !others) return null
  const carry = CARRY[kind]
  const [dry, echo] = kind === 'voice' ? [out, wet] : [others.dry, others.wet]
  const gain = c.createGain()
  gain.gain.value = p.volume
  if (!p.at) {
    gain.connect(dry)
    const send = c.createGain()
    send.gain.value = 0.25
    gain.connect(send).connect(echo)
    return { into: gain, moveTo: () => {} }
  }
  const d = Math.hypot(p.at[0] - ear.at[0], p.at[1] - ear.at[1], p.at[2] - ear.at[2])
  if (d > 110) return null
  const walled = (at: Vec3, d: number) => d > 1.5 && occluded(at, ear.at)
  let wall = walled(p.at, d)
  const air = c.createBiquadFilter()
  air.type = 'lowpass'
  air.Q.value = 0.5
  const through = c.createGain()
  through.gain.value = wall ? carry.wallGain : 1
  const pan = new PannerNode(c, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: carry.refDistance, maxDistance: 110, rolloffFactor: carry.rolloff, positionX: p.at[0], positionY: p.at[1], positionZ: p.at[2] })
  gain.connect(through).connect(air).connect(pan).connect(dry)
  // Farther off, more of what is heard is the room's echo.
  const send = c.createGain()
  air.connect(send).connect(echo)
  const far = (d: number) => {
    const open = Math.min(20000, 22000 / (1 + d / 28))
    return { air: wall ? Math.max(carry.wallLowpass, open * 0.06) : open, echo: Math.min(carry.echoMax, 0.2 + Math.min(0.7, d / 40)) }
  }
  air.frequency.value = far(d).air
  send.gain.value = far(d).echo
  let checked = c.currentTime
  return {
    into: gain,
    moveTo: (at) => {
      const t = c.currentTime
      const d = Math.hypot(at[0] - ear.at[0], at[1] - ear.at[1], at[2] - ear.at[2])
      if (t - checked >= WALL_CHECK) {
        checked = t
        const behind = walled(at, d)
        if (behind !== wall) through.gain.setTargetAtTime(behind ? carry.wallGain : 1, t, WALL_RAMP / 3)
        wall = behind
      }
      const now = far(d)
      pan.positionX.setTargetAtTime(at[0], t, 0.02)
      pan.positionY.setTargetAtTime(at[1], t, 0.02)
      pan.positionZ.setTargetAtTime(at[2], t, 0.02)
      air.frequency.setTargetAtTime(now.air, t, WALL_RAMP / 3)
      send.gain.setTargetAtTime(now.echo, t, 0.05)
    },
  }
}

/**
 * Plays a recording of a sound where it is: one of its variants at a slightly different pitch.
 * Returns false when there is none to play yet (the caller may draw one of its own).
 */
export function playRecorded(name: string, p: Placed): boolean {
  const e = library[name]
  if (!e) return false
  const buf = pick(name)
  if (!buf) return false
  const c = audio()
  const r = route({ ...p, volume: p.volume * e.gain }, 'sound')
  if (!c || !r) return true
  const s = c.createBufferSource()
  s.buffer = buf
  s.playbackRate.value = p.pitch * (0.93 + Math.random() * 0.14)
  s.connect(r.into)
  s.start()
  return true
}
