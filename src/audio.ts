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

/**
 * The way a sound goes from where it is to the ear: its loudness, the air's and any wall's
 * dulling, its place in 3D, and a share of it into the room. Null when it is too far to hear.
 * Moved, it keeps the wall it started behind.
 */
export function route(p: Placed): Route | null {
  const c = audio()
  const out = mainOut()
  if (!c || !out || !wet) return null
  const gain = c.createGain()
  gain.gain.value = p.volume
  if (!p.at) {
    gain.connect(out)
    const send = c.createGain()
    send.gain.value = 0.25
    gain.connect(send).connect(wet)
    return { into: gain, moveTo: () => {} }
  }
  const d = Math.hypot(p.at[0] - ear.at[0], p.at[1] - ear.at[1], p.at[2] - ear.at[2])
  if (d > 110) return null
  const wall = d > 1.5 && occluded(p.at, ear.at)
  const air = c.createBiquadFilter()
  air.type = 'lowpass'
  air.Q.value = 0.5
  if (wall) gain.gain.value *= 0.55
  const pan = new PannerNode(c, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1.6, maxDistance: 110, rolloffFactor: 1.1, positionX: p.at[0], positionY: p.at[1], positionZ: p.at[2] })
  gain.connect(air).connect(pan).connect(out)
  // Farther off, more of what is heard is the room's echo.
  const send = c.createGain()
  air.connect(send).connect(wet)
  const far = (d: number) => ({ air: Math.min(20000, 22000 / (1 + d / 28)) * (wall ? 0.06 : 1), echo: 0.2 + Math.min(0.7, d / 40) })
  air.frequency.value = far(d).air
  send.gain.value = far(d).echo
  return {
    into: gain,
    moveTo: (at) => {
      const t = c.currentTime
      const now = far(Math.hypot(at[0] - ear.at[0], at[1] - ear.at[1], at[2] - ear.at[2]))
      pan.positionX.setTargetAtTime(at[0], t, 0.02)
      pan.positionY.setTargetAtTime(at[1], t, 0.02)
      pan.positionZ.setTargetAtTime(at[2], t, 0.02)
      air.frequency.setTargetAtTime(now.air, t, 0.05)
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
  const r = route({ ...p, volume: p.volume * e.gain })
  if (!c || !r) return true
  const s = c.createBufferSource()
  s.buffer = buf
  s.playbackRate.value = p.pitch * (0.93 + Math.random() * 0.14)
  s.connect(r.into)
  s.start()
  return true
}
